"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const locationSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "A short code is required.")
    .max(20, "Keep the code to 20 characters or fewer."),
  /*
   * Blank on creation: the database assigns the lowest free letter, so nobody
   * has to know which are taken. A value only arrives when somebody is
   * correcting one, and it is upper-cased here so entering 'b' saves rather
   * than returning a constraint violation to decipher.
   */
  invoice_prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]$/, "The invoice letter must be a single letter, A to Z.")
    .or(z.literal("")),
  name: z.string().trim().min(2, "Location name is required."),
  property_type: z.enum([
    "commercial_building",
    "office",
    "warehouse",
    "vacant_lot",
    "apartment",
  ]),
  address: z.string().trim().nullish().or(z.literal("")),
});

function readForm(formData: FormData) {
  return locationSchema.safeParse({
    code: formData.get("code"),
    invoice_prefix: formData.get("invoice_prefix") ?? "",
    name: formData.get("name"),
    property_type: formData.get("property_type"),
    address: formData.get("address"),
  });
}

export async function createLocation(
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

  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("locations")
    .insert({
      company_id: companyId,
      ...parsed.data,
      address: parsed.data.address || null,
    })
    .select("id, name")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That location code or invoice letter is already used in this company."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.adminLocations,
    entityTable: "locations",
    entityId: data.id,
    summary: `Created location "${data.name}".`,
    after: parsed.data,
  });

  revalidatePath("/portfolio/locations");
  return { success: `Location "${data.name}" created.` };
}

export async function updateLocation(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.adminLocations, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("locations")
    .select("code, invoice_prefix, name, property_type, address")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("locations")
    .update({ ...parsed.data, address: parsed.data.address || null })
    .eq("id", id);

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That location code or invoice letter is already used in this company."
          : error.message,
    };
  }

  const diff = before
    ? changedFields(before, parsed.data)
    : { before: {}, after: parsed.data };

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminLocations,
    entityTable: "locations",
    entityId: id,
    summary: `Updated location "${parsed.data.name}".`,
    before: diff.before,
    after: diff.after,
  });

  revalidatePath("/portfolio/locations");
  return { success: "Location updated." };
}

export async function setLocationActive(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.adminLocations, "edit")) {
    return;
  }

  const id = String(formData.get("id") ?? "");
  const isActive = formData.get("is_active") === "true";

  const supabase = await createClient();
  const { error } = await supabase
    .from("locations")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminLocations,
    entityTable: "locations",
    entityId: id,
    summary: isActive ? "Reactivated location." : "Deactivated location.",
    before: { is_active: !isActive },
    after: { is_active: isActive },
  });

  revalidatePath("/portfolio/locations");
}
