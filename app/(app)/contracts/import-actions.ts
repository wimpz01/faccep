"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/auth";
import { csvLines, splitCsvLine } from "@/lib/csv";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const STATUSES = ["draft", "active", "expired", "terminated"] as const;

/**
 * Brings existing leases in from a spreadsheet.
 *
 * These are contracts already signed, so the rent floor does not apply: a
 * lease running at a rent the unit has since outgrown is a fact to be
 * recorded, not a decision being made. The floor is stood down for the
 * transaction by import_contract() and by nothing else -- a contract written
 * in the app afterwards is held to it as before.
 *
 * A unit named on two contracts is refused. One unit cannot be let twice over
 * at the same time, and letting it through would leave occupancy and the rent
 * roll wrong in a way nobody would spot until a bill went out.
 */
export async function importContracts(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.contracts, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const raw = String(formData.get("csv") ?? "").trim();
  if (!raw) return { error: "Choose a file, or paste the rows in." };

  const lines = csvLines(raw);
  if (lines.length < 2) return { error: "That file has a header but no rows." };

  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  for (const required of ["tenant", "unit_codes", "start_date", "monthly_rent"]) {
    if (!header.includes(required)) {
      return {
        error: `The header is missing: ${required}. Download the template to see the expected columns.`,
      };
    }
  }

  const at = (cells: string[], column: string) => {
    const index = header.indexOf(column);
    return index === -1 ? "" : (cells[index] ?? "").trim();
  };

  const supabase = await createClient();
  const [{ data: tenants }, { data: units }, { data: taken }] = await Promise.all([
    supabase
      .from("tenants")
      .select("id, company_name")
      .eq("company_id", companyId)
      .returns<{ id: string; company_name: string }[]>(),
    supabase
      .from("units")
      .select("id, code, locations(code)")
      .eq("company_id", companyId)
      .returns<{ id: string; code: string; locations: { code: string } | null }[]>(),
    // Units already on a live contract, so an import cannot let one twice.
    supabase
      .from("contract_units")
      .select("unit_id, contracts(status)")
      .returns<{ unit_id: string; contracts: { status: string } | null }[]>(),
  ]);

  const tenantByName = new Map(
    (tenants ?? []).map((row) => [row.company_name.trim().toLowerCase(), row.id]),
  );

  /*
   * A unit is named either by its own code, or as PROPERTY/UNIT where two
   * properties happen to use the same one. Both are accepted; the qualified
   * form is the one to reach for when a bare code is ambiguous.
   */
  const unitByKey = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const unit of units ?? []) {
    const bare = unit.code.trim().toLowerCase();
    if (unitByKey.has(bare)) ambiguous.add(bare);
    else unitByKey.set(bare, unit.id);
    if (unit.locations?.code) {
      unitByKey.set(
        `${unit.locations.code.trim().toLowerCase()}/${bare}`,
        unit.id,
      );
    }
  }

  const alreadyLet = new Set(
    (taken ?? [])
      .filter((row) => ["active", "draft"].includes(row.contracts?.status ?? ""))
      .map((row) => row.unit_id),
  );

  type Draft = {
    line: number;
    tenantId: string;
    unitIds: string[];
    contractNo: string;
    status: string;
    start: string;
    end: string;
    rent: number;
    deposit: number;
    advance: number;
    dueDay: number;
    notes: string;
  };

  const drafts: Draft[] = [];
  const problems: string[] = [];
  const claimed = new Map<string, number>();

  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    const where = `Line ${index + 1}`;
    const tenantName = at(cells, "tenant");
    const unitCodes = at(cells, "unit_codes");

    if (!tenantName && !unitCodes) continue;

    const tenantId = tenantByName.get(tenantName.toLowerCase());
    if (!tenantId) {
      problems.push(`${where}: no tenant on file called "${tenantName}".`);
      continue;
    }

    const unitIds: string[] = [];
    let unitProblem = false;
    for (const piece of unitCodes.split(/[;|]/).map((s) => s.trim()).filter(Boolean)) {
      const key = piece.toLowerCase();
      if (ambiguous.has(key) && !key.includes("/")) {
        problems.push(
          `${where}: the unit code ${piece} is used by more than one property — write it as PROPERTY/${piece}.`,
        );
        unitProblem = true;
        continue;
      }
      const unitId = unitByKey.get(key);
      if (!unitId) {
        problems.push(`${where}: there is no unit ${piece}.`);
        unitProblem = true;
        continue;
      }
      if (alreadyLet.has(unitId)) {
        problems.push(`${where}: unit ${piece} is already on a live contract.`);
        unitProblem = true;
        continue;
      }
      const seenOn = claimed.get(unitId);
      if (seenOn) {
        problems.push(`${where}: unit ${piece} is also on line ${seenOn}.`);
        unitProblem = true;
        continue;
      }
      claimed.set(unitId, index + 1);
      unitIds.push(unitId);
    }
    if (unitProblem) continue;
    if (unitIds.length === 0) {
      problems.push(`${where}: name at least one unit in unit_codes.`);
      continue;
    }

    const start = at(cells, "start_date");
    const end = at(cells, "end_date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      problems.push(`${where}: start_date must be written as YYYY-MM-DD.`);
      continue;
    }
    if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      problems.push(`${where}: end_date must be written as YYYY-MM-DD.`);
      continue;
    }
    if (end && end < start) {
      problems.push(`${where}: end_date is before start_date.`);
      continue;
    }

    const money = (column: string, fallback = 0) => {
      const text = at(cells, column);
      return text === "" ? fallback : Number(text);
    };
    const rent = money("monthly_rent");
    if (!Number.isFinite(rent) || rent < 0) {
      problems.push(`${where}: monthly_rent must be a number.`);
      continue;
    }
    const deposit = money("security_deposit");
    const advance = money("advance_payment");
    if (!Number.isFinite(deposit) || !Number.isFinite(advance)) {
      problems.push(`${where}: security_deposit and advance_payment must be numbers.`);
      continue;
    }

    const dueText = at(cells, "rent_due_day");
    const dueDay = dueText === "" ? 5 : Number(dueText);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
      problems.push(`${where}: rent_due_day must be a whole number from 1 to 28.`);
      continue;
    }

    const status = (at(cells, "status") || "active").toLowerCase();
    if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
      problems.push(`${where}: status must be one of ${STATUSES.join(", ")}.`);
      continue;
    }

    drafts.push({
      line: index + 1,
      tenantId,
      unitIds,
      contractNo: at(cells, "contract_no"),
      status,
      start,
      end: end || start,
      rent,
      deposit,
      advance,
      dueDay,
      notes: at(cells, "notes"),
    });
  }

  if (problems.length > 0) {
    return {
      error: `Nothing was imported. ${problems.slice(0, 6).join(" ")}${
        problems.length > 6 ? ` (${problems.length - 6} more.)` : ""
      }`,
    };
  }
  if (drafts.length === 0) return { error: "No rows to import." };

  /*
   * The whole file in one call, so it is one transaction. Row by row would
   * be a transaction each, and a failure on the last row would leave every
   * row before it written -- which is not what the form promises.
   */
  const { data: made, error } = await supabase.rpc("import_contracts", {
    p_company: companyId,
    p_rows: drafts.map((draft) => ({
      tenant: draft.tenantId,
      contract_no: draft.contractNo,
      status: draft.status,
      start: draft.start,
      end: draft.end,
      rent: draft.rent,
      deposit: draft.deposit,
      advance: draft.advance,
      due_day: draft.dueDay,
      notes: draft.notes,
      units: draft.unitIds,
    })),
  });

  if (error) {
    return { error: `Nothing was imported. ${error.message}` };
  }

  const count = Number(made ?? 0);

  await logAudit({
    action: "create",
    moduleKey: MODULE.contracts,
    entityTable: "contracts",
    summary: `Imported ${count} contract(s) from a spreadsheet.`,
    after: { count },
  });

  revalidatePath("/contracts");
  revalidatePath("/properties");
  return { success: `Imported ${count} contract(s).` };
}
