"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { csvLines, splitCsvLine } from "@/lib/csv";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const tenantSchema = z.object({
  company_name: z.string().trim().min(2, "Company name is required."),
  address: z.string().trim().nullish().or(z.literal("")),
  company_number: z.string().trim().nullish().or(z.literal("")),
  contact_person: z.string().trim().nullish().or(z.literal("")),
  mobile_number: z.string().trim().nullish().or(z.literal("")),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .optional()
    .or(z.literal("")),
  tin: z.string().trim().nullish().or(z.literal("")),
  is_vatable: z.boolean(),
  withholds_tax: z.boolean(),
  is_government: z.boolean(),
  notes: z.string().trim().nullish().or(z.literal("")),
});

function readForm(formData: FormData) {
  return tenantSchema.safeParse({
    company_name: formData.get("company_name"),
    address: formData.get("address"),
    company_number: formData.get("company_number"),
    contact_person: formData.get("contact_person"),
    mobile_number: formData.get("mobile_number"),
    email: formData.get("email"),
    tin: formData.get("tin"),
    is_vatable: formData.get("is_vatable") === "on",
    withholds_tax: formData.get("withholds_tax") === "on",
    // A government tenant always withholds, whatever the other box says.
    is_government: formData.get("is_government") === "on",
    notes: formData.get("notes"),
  });
}

function toRow(values: z.infer<typeof tenantSchema>) {
  /*
   * Withholding is computed on a tenant's VATable inclusions, so a tenant who
   * is not VAT-registered has nothing to withhold on and cannot be marked as
   * withholding -- the database refuses it outright. A government tenant is a
   * withholding one by definition, so ticking that alone is enough.
   *
   * The form disables the boxes rather than showing them ticked and refused,
   * so this only catches a stale form or a request built by hand.
   */
  const withholds =
    values.is_vatable && (values.withholds_tax || values.is_government);

  return {
    company_name: values.company_name,
    address: values.address || null,
    company_number: values.company_number || null,
    contact_person: values.contact_person || null,
    mobile_number: values.mobile_number || null,
    email: values.email || null,
    tin: values.tin || null,
    is_vatable: values.is_vatable,
    withholds_tax: withholds,
    is_government: withholds && values.is_government,
    notes: values.notes || null,
  };
}

export async function createTenant(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.tenants, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .insert({ company_id: companyId, ...toRow(parsed.data) })
    .select("id, company_name")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A tenant with that company name already exists."
          : error.message,
    };
  }

  /*
   * The papers attached while the form was being filled in. They are already
   * in storage -- the browser put them there as they were chosen -- so this
   * only writes the rows that tie them to the tenant that now exists.
   *
   * A failure here does not undo the tenant. The tenant is the record that
   * matters and it is sound; a document that did not attach can be attached
   * again, and saying so is better than throwing the tenant away.
   */
  const docs: {
    company_id: string;
    tenant_id: string;
    title: string;
    doc_kind: string;
    storage_path: string;
    expires_on: string | null;
    no_expiry: boolean;
    uploaded_by: string;
  }[] = [];

  for (const [field, raw] of formData.entries()) {
    if (!field.startsWith("doc_path:")) continue;
    const kind = field.slice("doc_path:".length);
    const path = String(raw).trim();
    if (!path) continue;

    const noExpiry = formData.get(`doc_no_expiry:${kind}`) === "on";
    const expiry = String(formData.get(`doc_expiry:${kind}`) ?? "").slice(0, 10);

    docs.push({
      company_id: companyId,
      tenant_id: data.id,
      title: String(formData.get(`doc_name:${kind}`) ?? kind),
      doc_kind: kind,
      storage_path: path,
      // A date and "never expires" contradict each other; the database
      // refuses the pair, so the flag wins here.
      expires_on: noExpiry || !expiry ? null : expiry,
      no_expiry: noExpiry,
      uploaded_by: userId,
    });
  }

  let docNote = "";
  if (docs.length > 0) {
    const { error: docError } = await supabase.from("documents").insert(docs);
    docNote = docError
      ? ` The tenant was created, but the documents did not attach: ${docError.message}`
      : ` ${docs.length} document${docs.length === 1 ? "" : "s"} attached.`;
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.tenants,
    entityTable: "tenants",
    entityId: data.id,
    summary: `Created tenant "${data.company_name}".${docNote}`,
    after: toRow(parsed.data),
  });

  redirect(`/tenants/${data.id}`);
}

export async function updateTenant(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.tenants, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("tenants")
    .select(
      "company_name, address, company_number, contact_person, mobile_number, email, tin, is_vatable, withholds_tax, is_government, notes",
    )
    .eq("id", id)
    .single();

  const row = toRow(parsed.data);
  const { error } = await supabase.from("tenants").update(row).eq("id", id);

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A tenant with that company name already exists."
          : error.message,
    };
  }

  const diff = before ? changedFields(before, row) : { before: {}, after: row };

  await logAudit({
    action: "update",
    moduleKey: MODULE.tenants,
    entityTable: "tenants",
    entityId: id,
    summary: `Updated tenant "${row.company_name}".`,
    before: diff.before,
    after: diff.after,
  });

  revalidatePath(`/tenants/${id}`);
  revalidatePath("/tenants");
  return { success: "Tenant updated." };
}

/**
 * Spec 12: a tenant who vacates without notice is blacklisted, which blocks any
 * future contract (enforced by the reject_blacklisted_tenant trigger).
 */
export async function setTenantStatus(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.tenants, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const reason = String(formData.get("blacklist_reason") ?? "").trim();

  if (!["prospect", "active", "ended", "blacklisted"].includes(status)) {
    return { error: "Unknown status." };
  }
  if (status === "blacklisted" && !reason) {
    return { error: "Give a reason before blacklisting a tenant." };
  }

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("tenants")
    .select("company_name, status, blacklist_reason")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("tenants")
    .update({
      status,
      blacklisted_at: status === "blacklisted" ? new Date().toISOString() : null,
      blacklist_reason: status === "blacklisted" ? reason : null,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.tenants,
    entityTable: "tenants",
    entityId: id,
    summary:
      status === "blacklisted"
        ? `Blacklisted tenant "${before?.company_name ?? id}": ${reason}`
        : `Set tenant "${before?.company_name ?? id}" to ${status}.`,
    before: { status: before?.status, blacklist_reason: before?.blacklist_reason },
    after: { status, blacklist_reason: status === "blacklisted" ? reason : null },
  });

  revalidatePath(`/tenants/${id}`);
  revalidatePath("/tenants");
  return { success: `Tenant is now ${status}.` };
}

/** Spec 2: only a role explicitly granted tenant delete may do this. */
export async function deleteTenant(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.tenants, "delete")) return;

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { count } = await supabase
    .from("contracts")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", id);

  // contracts references tenants ON DELETE RESTRICT; surface the reason rather
  // than letting the constraint fire.
  if ((count ?? 0) > 0) return;

  const { data: before } = await supabase
    .from("tenants")
    .select("company_name")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("tenants").delete().eq("id", id);
  if (error) return;

  await logAudit({
    action: "delete",
    moduleKey: MODULE.tenants,
    entityTable: "tenants",
    entityId: id,
    summary: `Deleted tenant "${before?.company_name ?? id}".`,
    before: before ?? undefined,
  });

  redirect("/tenants");
}

/**
 * Adds many tenants from a spreadsheet, instead of typing them in one by one.
 *
 * The whole file is checked before anything is written, so a typo on line 40
 * cannot leave 39 tenants half-imported and the rest missing. A name already on
 * file is reported rather than duplicated: a second "Kapetirya Cafe" would give
 * two tenants that every invoice and contract afterwards has to be told apart
 * by eye.
 *
 * Only the tenant record is imported. Contracts, units and deposits each carry
 * their own dates and money and are set up per tenant afterwards.
 */
export async function importTenants(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.tenants, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const raw = String(formData.get("csv") ?? "").trim();
  if (!raw) return { error: "Choose a file, or paste the rows in." };

  const lines = csvLines(raw);
  if (lines.length < 2) return { error: "That file has a header but no rows." };

  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  if (!header.includes("company_name")) {
    return {
      error:
        "The header is missing: company_name. Download the template to see the expected columns.",
    };
  }

  const at = (cells: string[], column: string) => {
    const index = header.indexOf(column);
    return index === -1 ? "" : (cells[index] ?? "");
  };

  /** Accepts what a person actually types in a spreadsheet for yes and no. */
  const asBoolean = (value: string) =>
    ["yes", "y", "true", "1", "vat", "vatable"].includes(
      value.trim().toLowerCase(),
    );

  const rows: ReturnType<typeof toRow>[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const line = i + 1;
    const name = at(cells, "company_name");

    if (!name) {
      problems.push(`Line ${line}: no company name.`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      problems.push(`Line ${line}: "${name}" appears twice in this file.`);
      continue;
    }
    seen.add(name.toLowerCase());

    const parsed = tenantSchema.safeParse({
      company_name: name,
      address: at(cells, "address"),
      company_number: at(cells, "company_number"),
      contact_person: at(cells, "contact_person"),
      mobile_number: at(cells, "mobile_number"),
      email: at(cells, "email"),
      tin: at(cells, "tin"),
      is_vatable: asBoolean(at(cells, "is_vatable")),
      /*
       * Both are columns the importer accepts but does not require. A tenant
       * only withholds where they are VAT-registered, which the schema also
       * insists on, so the flag is read but never inferred.
       */
      withholds_tax: asBoolean(at(cells, "withholds_tax")),
      is_government: asBoolean(at(cells, "is_government")),
      notes: at(cells, "notes"),
    });
    if (!parsed.success) {
      problems.push(`Line ${line}: ${parsed.error.issues[0].message}`);
      continue;
    }

    rows.push(toRow(parsed.data));
  }

  if (problems.length > 0) {
    return {
      error: `Nothing was imported. ${problems.slice(0, 8).join(" ")}${
        problems.length > 8 ? ` (+${problems.length - 8} more)` : ""
      }`,
    };
  }
  if (rows.length === 0) return { error: "That file has no rows to import." };

  const supabase = await createClient();

  // A name already on file is a different tenant or the same one twice, and
  // neither is worth guessing at.
  const { data: existing } = await supabase
    .from("tenants")
    .select("company_name")
    .eq("company_id", companyId);

  const onFile = new Set(
    (existing ?? []).map((row) => row.company_name.toLowerCase()),
  );
  const clashes = rows
    .filter((row) => onFile.has(row.company_name.toLowerCase()))
    .map((row) => row.company_name);

  if (clashes.length > 0) {
    return {
      error: `Nothing was imported. Already on file: ${clashes.slice(0, 6).join(", ")}${
        clashes.length > 6 ? ` (+${clashes.length - 6} more)` : ""
      }.`,
    };
  }

  const { data: inserted, error } = await supabase
    .from("tenants")
    .insert(rows.map((row) => ({ company_id: companyId, ...row })))
    .select("id");

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.tenants,
    entityTable: "tenants",
    summary: `Imported ${rows.length} tenant${rows.length === 1 ? "" : "s"} from a spreadsheet.`,
    after: { count: rows.length, names: rows.map((row) => row.company_name) },
  });

  revalidatePath("/tenants");
  return {
    success: `Imported ${inserted?.length ?? rows.length} tenant${
      (inserted?.length ?? rows.length) === 1 ? "" : "s"
    }.`,
  };
}
