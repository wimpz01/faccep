"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
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
    notes: formData.get("notes"),
  });
}

function toRow(values: z.infer<typeof tenantSchema>) {
  return {
    company_name: values.company_name,
    address: values.address || null,
    company_number: values.company_number || null,
    contact_person: values.contact_person || null,
    mobile_number: values.mobile_number || null,
    email: values.email || null,
    tin: values.tin || null,
    is_vatable: values.is_vatable,
    notes: values.notes || null,
  };
}

export async function createTenant(
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

  await logAudit({
    action: "create",
    moduleKey: MODULE.tenants,
    entityTable: "tenants",
    entityId: data.id,
    summary: `Created tenant "${data.company_name}".`,
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
      "company_name, address, company_number, contact_person, mobile_number, email, tin, is_vatable, notes",
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
