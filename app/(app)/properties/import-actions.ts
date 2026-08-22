"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { csvLines, splitCsvLine } from "@/lib/csv";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/**
 * Brings a list of units in from a spreadsheet.
 *
 * The rate is the awkward part. A unit's rate moves only with approval, and
 * creating one raises a proposal rather than setting it -- which is right when
 * somebody is pricing a unit, and merely in the way when a portfolio that
 * already exists is being loaded.
 *
 * It is not bypassed. The proposal is raised as always and then signed off, by
 * the importer, who must hold Approve on units to import a rate at all. The
 * rate history therefore reads the same as any other: proposed, approved, by
 * whom, on what day. Somebody who may add units but not price them can still
 * import the units, without the rates.
 */
export async function importUnits(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.units, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const context = await getSessionContext();
  const mayApproveRates = Boolean(
    context && can(context.permissions, MODULE.units, "approve"),
  );

  const raw = String(formData.get("csv") ?? "").trim();
  if (!raw) return { error: "Choose a file, or paste the rows in." };

  const lines = csvLines(raw);
  if (lines.length < 2) return { error: "That file has a header but no rows." };

  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  for (const required of ["location_code", "code"]) {
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
  const [{ data: locations }, { data: existing }] = await Promise.all([
    supabase
      .from("locations")
      .select("id, code")
      .eq("company_id", companyId)
      .returns<{ id: string; code: string }[]>(),
    supabase
      .from("units")
      .select("code, location_id")
      .eq("company_id", companyId)
      .returns<{ code: string; location_id: string }[]>(),
  ]);

  const locationOf = new Map(
    (locations ?? []).map((row) => [row.code.toLowerCase(), row.id]),
  );
  const onFile = new Set(
    (existing ?? []).map((row) => `${row.location_id}::${row.code.toLowerCase()}`),
  );

  type Draft = {
    row: Record<string, unknown>;
    rate: number;
    line: number;
  };

  const drafts: Draft[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    const locationCode = at(cells, "location_code");
    const code = at(cells, "code");
    const where = `Line ${index + 1}`;

    if (!locationCode && !code) continue;
    if (!locationCode) {
      problems.push(`${where}: location_code is required.`);
      continue;
    }
    if (!code) {
      problems.push(`${where}: code is required.`);
      continue;
    }

    const locationId = locationOf.get(locationCode.toLowerCase());
    if (!locationId) {
      problems.push(`${where}: there is no property with the code ${locationCode}.`);
      continue;
    }

    const key = `${locationId}::${code.toLowerCase()}`;
    if (onFile.has(key)) {
      problems.push(`${where}: ${locationCode}/${code} is already on file.`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`${where}: ${locationCode}/${code} appears twice in this file.`);
      continue;
    }
    seen.add(key);

    const rateText = at(cells, "monthly_rate");
    const rate = rateText === "" ? 0 : Number(rateText);
    if (!Number.isFinite(rate) || rate < 0) {
      problems.push(`${where}: monthly_rate must be a number of nought or more.`);
      continue;
    }
    if (rate > 0 && !mayApproveRates) {
      problems.push(
        `${where}: a rate needs Approve on units to import. Leave monthly_rate blank, or ask someone who can approve rates to run this.`,
      );
      continue;
    }

    const areaText = at(cells, "area_sqm");
    const area = areaText === "" ? null : Number(areaText);
    if (area !== null && !Number.isFinite(area)) {
      problems.push(`${where}: area_sqm must be a number.`);
      continue;
    }

    drafts.push({
      line: index + 1,
      rate,
      row: {
        company_id: companyId,
        location_id: locationId,
        code,
        floor: at(cells, "floor") || null,
        area_sqm: area,
        // The database resets this to nought and raises a proposal; the rate
        // is carried separately and approved below.
        monthly_rate: rate,
        description: at(cells, "description") || null,
        water_meter_serial: at(cells, "water_meter_serial") || null,
        electric_meter_serial: at(cells, "electric_meter_serial") || null,
      },
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
   * Inserted one at a time rather than in a batch: the trigger that raises the
   * rate proposal reads a session value set by the insert before it, and a
   * batch would have them all see the last row's rate.
   */
  const madeIds: string[] = [];
  for (const draft of drafts) {
    const { data, error } = await supabase
      .from("units")
      .insert(draft.row)
      .select("id")
      .single();

    if (error) {
      return {
        error: `Line ${draft.line} failed and the import stopped: ${error.message}. ${madeIds.length} unit(s) were created before it — remove them and try again.`,
      };
    }
    madeIds.push(data.id);
  }

  // Sign off the rates that were asked for, so the units are lettable.
  let approved = 0;
  if (mayApproveRates) {
    const { data: pending } = await supabase
      .from("unit_rate_changes")
      .select("id, unit_id")
      .in("unit_id", madeIds)
      .eq("status", "pending")
      .returns<{ id: string; unit_id: string }[]>();

    for (const change of pending ?? []) {
      const { error } = await supabase.rpc("decide_unit_rate_change", {
        p_change: change.id,
        p_approve: true,
        p_note: "Rate as imported",
      });
      if (!error) approved += 1;
    }
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.units,
    entityTable: "units",
    summary: `Imported ${madeIds.length} unit(s) from a spreadsheet${approved > 0 ? `, with ${approved} rate(s) approved on import` : ""}.`,
    after: { count: madeIds.length, ratesApproved: approved },
  });

  revalidatePath("/properties");
  revalidatePath("/approvals");
  return {
    success:
      `Imported ${madeIds.length} unit(s).` +
      (approved > 0
        ? ` ${approved} rate(s) were approved on import, so those units can be let straight away.`
        : " No rates were set, so each unit needs one before it can go on a contract."),
  };
}
