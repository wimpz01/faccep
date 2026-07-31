"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const periodSchema = z.object({
  location_id: z.string().uuid("Choose a location."),
  utility: z.enum(["water", "electric"]),
  period_start: z.string().min(10, "Choose the period start."),
  period_end: z.string().min(10, "Choose the period end."),
  provider_amount: z.coerce.number().min(0, "Amount cannot be negative."),
  provider_consumption: z.coerce.number().min(0, "Consumption cannot be negative."),
  genset_expense: z.coerce.number().min(0, "Genset expense cannot be negative."),
  notes: z.string().trim().optional().or(z.literal("")),
});

export async function createUtilityPeriod(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingUtilityRates, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = periodSchema.safeParse({
    location_id: formData.get("location_id"),
    utility: formData.get("utility"),
    period_start: formData.get("period_start"),
    period_end: formData.get("period_end"),
    provider_amount: formData.get("provider_amount") || 0,
    provider_consumption: formData.get("provider_consumption") || 0,
    genset_expense: formData.get("genset_expense") || 0,
    notes: formData.get("notes"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  if (parsed.data.period_end < parsed.data.period_start) {
    return { error: "The period end must fall on or after the start." };
  }
  if (parsed.data.utility === "water" && parsed.data.genset_expense > 0) {
    return { error: "Genset expense belongs on the electricity period." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("utility_periods")
    .insert({
      company_id: companyId,
      ...parsed.data,
      notes: parsed.data.notes || null,
    })
    .select("id")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That location already has a period for this utility and start date."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.billingUtilityRates,
    entityTable: "utility_periods",
    entityId: data.id,
    summary: `Opened a ${parsed.data.utility} billing period starting ${parsed.data.period_start}.`,
    after: parsed.data,
  });

  redirect(`/billing/periods/${data.id}`);
}

export async function updateUtilityPeriod(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingUtilityRates, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("utility_periods")
    .select("provider_amount, provider_consumption, genset_expense, notes, is_locked")
    .eq("id", id)
    .single();

  if (before?.is_locked) {
    return { error: "This period is locked because invoices have been released from it." };
  }

  const values = {
    provider_amount: Number(formData.get("provider_amount") ?? 0),
    provider_consumption: Number(formData.get("provider_consumption") ?? 0),
    genset_expense: Number(formData.get("genset_expense") ?? 0),
    notes: String(formData.get("notes") ?? "") || null,
  };

  if (values.provider_amount < 0 || values.provider_consumption < 0) {
    return { error: "Amounts cannot be negative." };
  }

  const { error } = await supabase
    .from("utility_periods")
    .update(values)
    .eq("id", id);
  if (error) return { error: error.message };

  const diff = before
    ? changedFields(before, values)
    : { before: {}, after: values };

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingUtilityRates,
    entityTable: "utility_periods",
    entityId: id,
    summary: "Updated the provider bill for a utility period.",
    before: diff.before,
    after: diff.after,
  });

  revalidatePath(`/billing/periods/${id}`);
  return { success: "Provider bill saved. The rate has been recalculated." };
}

/**
 * Saves the whole reading grid in one go.
 *
 * Fields arrive as `reading:<unit id>`; a blank value means the unit was not
 * read this period and its row is removed rather than stored as a zero.
 */
export async function saveMeterReadings(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingMeterReadings, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const periodId = String(formData.get("periodId") ?? "");
  const readingDate = String(formData.get("reading_date") ?? "").slice(0, 10);
  if (!periodId) return { error: "Missing period." };

  const supabase = await createClient();
  const { data: period } = await supabase
    .from("utility_periods")
    .select("id, utility, period_start, is_locked")
    .eq("id", periodId)
    .single();

  if (!period) return { error: "Period not found." };
  if (period.is_locked) {
    return { error: "This period is locked because invoices have been released from it." };
  }

  const rows: {
    company_id: string;
    period_id: string;
    unit_id: string;
    previous_reading: number;
    present_reading: number;
    reading_date: string;
  }[] = [];
  const clear: string[] = [];

  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("reading:")) continue;
    const unitId = key.slice("reading:".length);
    const value = String(raw).trim();

    if (value === "") {
      clear.push(unitId);
      continue;
    }

    const present = Number(value);
    const previous = Number(formData.get(`previous:${unitId}`) ?? 0);

    if (!Number.isFinite(present) || present < 0) {
      return { error: `Reading for unit ${unitId} is not a valid number.` };
    }
    if (present < previous) {
      return {
        error:
          "A present reading is lower than the previous one. Check the meter, " +
          "or correct the carried-forward figure first.",
      };
    }

    rows.push({
      company_id: companyId,
      period_id: periodId,
      unit_id: unitId,
      previous_reading: previous,
      present_reading: present,
      reading_date: readingDate || new Date().toISOString().slice(0, 10),
    });
  }

  if (clear.length > 0) {
    await supabase
      .from("meter_readings")
      .delete()
      .eq("period_id", periodId)
      .in("unit_id", clear);
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from("meter_readings")
      .upsert(rows, { onConflict: "period_id,unit_id" });
    if (error) return { error: error.message };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingMeterReadings,
    entityTable: "meter_readings",
    entityId: periodId,
    summary: `Saved ${rows.length} meter reading${rows.length === 1 ? "" : "s"} for the period.`,
    after: { saved: rows.length, cleared: clear.length },
  });

  revalidatePath(`/billing/periods/${periodId}`);
  return { success: `Saved ${rows.length} reading${rows.length === 1 ? "" : "s"}.` };
}

export async function setPeriodLocked(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.billingUtilityRates, "edit")) {
    return;
  }

  const id = String(formData.get("id") ?? "");
  const locked = formData.get("locked") === "true";

  const supabase = await createClient();
  const { error } = await supabase
    .from("utility_periods")
    .update({ is_locked: locked })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingUtilityRates,
    entityTable: "utility_periods",
    entityId: id,
    summary: locked ? "Locked the utility period." : "Unlocked the utility period.",
    after: { is_locked: locked },
  });

  revalidatePath(`/billing/periods/${id}`);
}
