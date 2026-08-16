"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { getSessionContext, requireSession } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const companySchema = z.object({
  name: z.string().trim().min(2, "Company name is required."),
  legal_name: z.string().trim().nullish().or(z.literal("")),
  tin: z.string().trim().nullish().or(z.literal("")),
  address: z.string().trim().nullish().or(z.literal("")),
  zip_code: z.string().trim().nullish().or(z.literal("")),
  contact_person: z.string().trim().nullish().or(z.literal("")),
  contact_number: z.string().trim().nullish().or(z.literal("")),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .optional()
    .or(z.literal("")),
});

function readCompanyForm(formData: FormData) {
  return companySchema.safeParse({
    name: formData.get("name"),
    legal_name: formData.get("legal_name"),
    tin: formData.get("tin"),
    address: formData.get("address"),
    zip_code: formData.get("zip_code"),
    contact_person: formData.get("contact_person"),
    contact_number: formData.get("contact_number"),
    email: formData.get("email"),
  });
}

function nullifyBlanks<T extends Record<string, unknown>>(values: T) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === "" ? null : value,
    ]),
  ) as { [K in keyof T]: T[K] | null };
}

export async function createCompany(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession();

  // Creating a company is install-level: there is no membership row to
  // authorise against before the company exists (mirrors the RLS policy).
  if (!context.isSuperAdmin) {
    return { error: "Only a super admin can create a company." };
  }

  const parsed = readCompanyForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("companies")
    .insert(nullifyBlanks(parsed.data))
    .select("id, name")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A company with that name already exists."
          : error.message,
    };
  }

  await logAudit({
    companyId: data.id,
    action: "create",
    moduleKey: MODULE.adminCompanies,
    entityTable: "companies",
    entityId: data.id,
    summary: `Created company "${data.name}".`,
    after: parsed.data,
  });

  revalidatePath("/admin/companies");
  return { success: `Company "${data.name}" created.` };
}

export async function updateCompany(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const companyId = String(formData.get("id") ?? "");
  const context = await getSessionContext();
  if (!context) return { error: "Not signed in." };

  const allowed =
    context.isSuperAdmin ||
    (context.activeCompany?.companyId === companyId &&
      can(context.permissions, MODULE.adminCompanies, "edit"));
  if (!allowed) {
    return { error: "You do not have permission to edit this company." };
  }

  const parsed = readCompanyForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("companies")
    .select(
      "name, legal_name, tin, address, zip_code, contact_person, contact_number, email",
    )
    .eq("id", companyId)
    .single();

  const { error } = await supabase
    .from("companies")
    .update(nullifyBlanks(parsed.data))
    .eq("id", companyId);

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A company with that name already exists."
          : error.message,
    };
  }

  const diff = before
    ? changedFields(before, parsed.data)
    : { before: {}, after: parsed.data };

  await logAudit({
    companyId,
    action: "update",
    moduleKey: MODULE.adminCompanies,
    entityTable: "companies",
    entityId: companyId,
    summary: `Updated company "${parsed.data.name}".`,
    before: diff.before,
    after: diff.after,
  });

  revalidatePath("/admin/companies");
  return { success: "Company updated." };
}

export async function setCompanyActive(formData: FormData) {
  const companyId = String(formData.get("id") ?? "");
  const isActive = formData.get("is_active") === "true";

  const context = await getSessionContext();
  if (!context) return;

  const allowed =
    context.isSuperAdmin ||
    (context.activeCompany?.companyId === companyId &&
      can(context.permissions, MODULE.adminCompanies, "edit"));
  if (!allowed) return;

  const supabase = await createClient();
  const { error } = await supabase
    .from("companies")
    .update({ is_active: isActive })
    .eq("id", companyId);
  if (error) return;

  await logAudit({
    companyId,
    action: "update",
    moduleKey: MODULE.adminCompanies,
    entityTable: "companies",
    entityId: companyId,
    summary: isActive ? "Reactivated company." : "Deactivated company.",
    before: { is_active: !isActive },
    after: { is_active: isActive },
  });

  revalidatePath("/admin/companies");
}
