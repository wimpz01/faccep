"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

// unitId comes back on create so the form can upload the photos it staged
// while the unit did not exist yet.
export type ActionState = {
  error?: string;
  success?: string;
  unitId?: string;
};

const optionalNumber = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : Number(value)))
  .refine((value) => value === null || Number.isFinite(value), {
    message: "Enter a number.",
  });

const unitSchema = z.object({
  code: z.string().trim().min(1, "Unit code is required.").max(30),
  floor: z.string().trim().nullish().or(z.literal("")),
  area_sqm: optionalNumber,
  monthly_rate: z.coerce
    .number({ invalid_type_error: "Enter a monthly rate." })
    .min(0, "Monthly rate cannot be negative."),
  description: z.string().trim().nullish().or(z.literal("")),
  // One entry per appliance the form has added; absent means none.
  appliances: z.array(z.string()).default([]),
  water_meter_serial: z.string().trim().nullish().or(z.literal("")),
  electric_meter_serial: z.string().trim().nullish().or(z.literal("")),
});

function readForm(formData: FormData) {
  return unitSchema.safeParse({
    code: formData.get("code"),
    floor: formData.get("floor"),
    area_sqm: formData.get("area_sqm"),
    monthly_rate: formData.get("monthly_rate"),
    description: formData.get("description"),
    appliances: formData.getAll("appliances").map(String),
    water_meter_serial: formData.get("water_meter_serial"),
    electric_meter_serial: formData.get("electric_meter_serial"),
  });
}

function toRow(values: z.infer<typeof unitSchema>) {
  return {
    code: values.code,
    floor: values.floor || null,
    area_sqm: values.area_sqm,
    monthly_rate: values.monthly_rate,
    description: values.description || null,
    appliances: values.appliances.map((item) => item.trim()).filter(Boolean),
    water_meter_serial: values.water_meter_serial || null,
    electric_meter_serial: values.electric_meter_serial || null,
  };
}

export async function createUnit(
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

  const locationId = String(formData.get("locationId") ?? "");
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("units")
    .insert({ company_id: companyId, location_id: locationId, ...toRow(parsed.data) })
    .select("id, code")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That unit code already exists in this location."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.units,
    entityTable: "units",
    entityId: data.id,
    summary: `Created unit ${data.code}.`,
    after: toRow(parsed.data),
  });

  revalidatePath(`/properties/${locationId}`);
  revalidatePath("/properties");
  revalidatePath("/approvals");
  /*
   * The rate typed on the form is not the rate the unit carries. It has been
   * raised for approval, and until somebody agrees it the unit has no price
   * and cannot be let -- which is worth saying plainly here rather than
   * leaving it to be discovered at the point a contract is refused.
   */
  return {
    success:
      parsed.data.monthly_rate > 0
        ? `Unit ${data.code} created. Its rate of ${parsed.data.monthly_rate.toFixed(2)} has gone to Approvals — the unit carries no rate, and cannot be put on a contract, until that is signed off.`
        : `Unit ${data.code} created.`,
    unitId: data.id,
  };
}

export async function updateUnit(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.units, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const locationId = String(formData.get("locationId") ?? "");
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("units")
    .select(
      "code, floor, area_sqm, monthly_rate, description, water_meter_serial, electric_meter_serial",
    )
    .eq("id", id)
    .single();

  /*
   * The rate is left out of the update on purpose. It moves only by
   * approval -- the database refuses a direct write to the column -- so a
   * changed figure is raised as a proposal below and everything else on the
   * unit saves as it always did.
   */
  const { monthly_rate: proposedRate, ...row } = toRow(parsed.data);
  const { error } = await supabase.from("units").update(row).eq("id", id);

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That unit code already exists in this location."
          : error.message,
    };
  }

  const diff = before
    ? changedFields(before, {
        code: row.code,
        floor: row.floor,
        area_sqm: row.area_sqm,
        // The rate is not part of this update; it moves by approval.
        description: row.description,
        water_meter_serial: row.water_meter_serial,
        electric_meter_serial: row.electric_meter_serial,
      })
    : { before: {}, after: row };

  await logAudit({
    action: "update",
    moduleKey: MODULE.units,
    entityTable: "units",
    entityId: id,
    summary: `Updated unit ${row.code}.`,
    before: diff.before,
    after: diff.after,
  });

  /*
   * A changed rate goes to whoever holds Approve on units. The unit keeps
   * the rate it has until they decide, so nothing that reads the rate --
   * a contract being priced, the potential income on the property page --
   * moves in the meantime.
   */
  let rateNote = '';
  if (before && Number(before.monthly_rate) !== Number(proposedRate)) {
    const { error: rateError } = await supabase.rpc("propose_unit_rate", {
      p_unit: id,
      p_rate: proposedRate,
      p_reason: null,
    });

    if (rateError) {
      // The rest of the unit saved, so this reports what did not.
      return {
        error:
          rateError.code === "23505"
            ? "The unit saved, but a rate change is already waiting on approval for it."
            : `The unit saved, but the rate change was not raised: ${rateError.message}`,
      };
    }

    await logAudit({
      action: "update",
      moduleKey: MODULE.units,
      entityTable: "units",
      entityId: id,
      summary: `Proposed moving unit ${row.code} from ${Number(before.monthly_rate).toFixed(2)} to ${Number(proposedRate).toFixed(2)}; awaiting approval.`,
      before: { monthly_rate: before.monthly_rate },
      after: { monthly_rate: proposedRate },
    });

    rateNote =
      " The rate change has gone to Approvals — the unit keeps its current rate until it is signed off.";
  }

  revalidatePath(`/properties/${locationId}`);
  revalidatePath("/approvals");
  return { success: `Unit updated.${rateNote}` };
}

/**
 * Retires or restores a unit.
 *
 * Occupancy itself is derived from contracts by the sync_unit_status trigger --
 * this only toggles the manual 'inactive' state, and restoring hands the unit
 * back to the trigger by way of 'vacant'.
 */
export async function setUnitInactive(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.units, "edit")) return;

  const id = String(formData.get("id") ?? "");
  const locationId = String(formData.get("locationId") ?? "");
  const inactive = formData.get("inactive") === "true";

  const supabase = await createClient();

  if (inactive) {
    const { count } = await supabase
      .from("contract_units")
      .select("contract_id", { count: "exact", head: true })
      .eq("unit_id", id);

    if ((count ?? 0) > 0) {
      // Leave it to the caller to see the unchanged state; retiring a unit that
      // is still on a contract would desynchronise occupancy.
      return;
    }
  }

  const { error } = await supabase
    .from("units")
    .update({ status: inactive ? "inactive" : "vacant" })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.units,
    entityTable: "units",
    entityId: id,
    summary: inactive ? "Retired unit." : "Returned unit to the vacant pool.",
    after: { status: inactive ? "inactive" : "vacant" },
  });

  revalidatePath(`/properties/${locationId}`);
}

export async function deleteUnit(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.units, "delete")) return;

  const id = String(formData.get("id") ?? "");
  const locationId = String(formData.get("locationId") ?? "");

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("units")
    .select("code")
    .eq("id", id)
    .single();

  // contract_units references units with ON DELETE RESTRICT, so a unit that has
  // ever been on a contract cannot be removed -- retire it instead.
  const { error } = await supabase.from("units").delete().eq("id", id);
  if (error) return;

  await logAudit({
    action: "delete",
    moduleKey: MODULE.units,
    entityTable: "units",
    entityId: id,
    summary: `Deleted unit ${before?.code ?? id}.`,
    before: before ?? undefined,
  });

  revalidatePath(`/properties/${locationId}`);
  revalidatePath("/properties");
}

export async function recordUnitPhoto(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.units, "edit")) return;

  const unitId = String(formData.get("unitId") ?? "");
  const storagePath = String(formData.get("storagePath") ?? "");
  const caption = String(formData.get("caption") ?? "");
  const locationId = String(formData.get("locationId") ?? "");
  if (!unitId || !storagePath) return;

  const supabase = await createClient();
  const { error } = await supabase.from("unit_photos").insert({
    unit_id: unitId,
    storage_path: storagePath,
    caption: caption || null,
  });
  if (error) return;

  await logAudit({
    action: "create",
    moduleKey: MODULE.units,
    entityTable: "unit_photos",
    entityId: unitId,
    summary: "Added a unit photo.",
    after: { storage_path: storagePath },
  });

  revalidatePath(`/properties/${locationId}`);
}

export async function deleteUnitPhoto(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.units, "edit")) return;

  const id = String(formData.get("id") ?? "");
  const locationId = String(formData.get("locationId") ?? "");

  const supabase = await createClient();
  const { data: photo } = await supabase
    .from("unit_photos")
    .select("storage_path")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("unit_photos").delete().eq("id", id);
  if (error) return;

  if (photo?.storage_path) {
    await supabase.storage.from("unit-photos").remove([photo.storage_path]);
  }

  await logAudit({
    action: "delete",
    moduleKey: MODULE.units,
    entityTable: "unit_photos",
    entityId: id,
    summary: "Removed a unit photo.",
    before: photo ?? undefined,
  });

  revalidatePath(`/properties/${locationId}`);
}
