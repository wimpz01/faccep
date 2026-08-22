"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/auth";
import { csvLines, splitCsvLine } from "@/lib/csv";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/** What a property may be. Fixed in the schema, so a file cannot invent one. */
const PROPERTY_TYPES = [
  "commercial_building",
  "office",
  "warehouse",
  "vacant_lot",
  "apartment",
] as const;

/** What a person actually types in a spreadsheet for yes. */
const asBoolean = (value: string) =>
  ["yes", "y", "true", "1"].includes(value.trim().toLowerCase());

/**
 * Brings a list of properties in from a spreadsheet.
 *
 * Nothing is written unless every row is good. A part-finished import is worse
 * than none: you cannot tell by looking which rows landed, so the only safe
 * thing to do with one is delete what arrived and start again.
 *
 * The invoice prefix is deliberately not a column. It is one letter per
 * property, assigned in creation order by the database, and letting a
 * spreadsheet choose would be a way to collide two properties on one letter or
 * to renumber an existing series by accident.
 */
export async function importLocations(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.adminLocations, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const raw = String(formData.get("csv") ?? "").trim();
  if (!raw) return { error: "Choose a file, or paste the rows in." };

  const lines = csvLines(raw);
  if (lines.length < 2) return { error: "That file has a header but no rows." };

  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  for (const required of ["code", "name"]) {
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
  const { data: existing } = await supabase
    .from("locations")
    .select("code")
    .eq("company_id", companyId);
  const onFile = new Set(
    (existing ?? []).map((row) => row.code.toLowerCase()),
  );

  const rows: Record<string, unknown>[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    const code = at(cells, "code");
    const name = at(cells, "name");
    const where = `Line ${index + 1}`;

    if (!code && !name) continue;
    if (!code) {
      problems.push(`${where}: code is required.`);
      continue;
    }
    if (!name) {
      problems.push(`${where}: name is required.`);
      continue;
    }
    if (onFile.has(code.toLowerCase())) {
      problems.push(`${where}: ${code} is already on file.`);
      continue;
    }
    if (seen.has(code.toLowerCase())) {
      problems.push(`${where}: ${code} appears twice in this file.`);
      continue;
    }
    seen.add(code.toLowerCase());

    /*
     * A fixed list, not free text. Spaces and capitals are forgiven --
     * "Commercial Building" is what a person types -- but anything not on
     * the list is reported by name rather than reaching the database as an
     * enum error nobody can act on.
     */
    const typedRaw = at(cells, "property_type");
    const typed = typedRaw.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (typed && !PROPERTY_TYPES.includes(typed as (typeof PROPERTY_TYPES)[number])) {
      problems.push(
        `${where}: property_type must be one of ${PROPERTY_TYPES.join(", ")}.`,
      );
      continue;
    }

    rows.push({
      company_id: companyId,
      code,
      name,
      property_type: typed || null,
      address: at(cells, "address") || null,
      is_active: at(cells, "is_active") === "" ? true : asBoolean(at(cells, "is_active")),
    });
  }

  if (problems.length > 0) {
    return {
      error: `Nothing was imported. ${problems.slice(0, 6).join(" ")}${
        problems.length > 6 ? ` (${problems.length - 6} more.)` : ""
      }`,
    };
  }
  if (rows.length === 0) return { error: "No rows to import." };

  const { error } = await supabase.from("locations").insert(rows);
  if (error) return { error: `Nothing was imported. ${error.message}` };

  await logAudit({
    action: "create",
    moduleKey: MODULE.adminLocations,
    entityTable: "locations",
    summary: `Imported ${rows.length} location(s) from a spreadsheet.`,
    after: { count: rows.length },
  });

  revalidatePath("/portfolio/locations");
  revalidatePath("/properties");
  return {
    success: `Imported ${rows.length} location(s). Each has been given its own invoice letter.`,
  };
}
