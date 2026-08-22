"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/**
 * Adds a meter that belongs to the building rather than to a tenant.
 *
 * Added from the period being worked on, because that is when somebody
 * notices one is missing -- they are standing at the board reading meters and
 * find a pump nobody has recorded. It belongs to the location, so once added
 * it appears on every period for that location and utility, not only this one.
 */
export async function addHouseMeter(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingMeterReadings, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const periodId = String(formData.get("periodId") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const serial = String(formData.get("serial") ?? "").trim();
  const direction = String(formData.get("direction") ?? "consumption");

  if (!periodId) return { error: "Missing period." };
  if (!label) return { error: "Give the meter a name, like Hallway lights." };
  if (direction !== "consumption" && direction !== "supply") {
    return { error: "A meter either draws or supplies." };
  }

  const supabase = await createClient();
  const { data: period } = await supabase
    .from("utility_periods")
    .select("company_id, location_id, utility")
    .eq("id", periodId)
    .maybeSingle<{ company_id: string; location_id: string; utility: string }>();

  if (!period) return { error: "That period no longer exists." };

  const { error } = await supabase.from("house_meters").insert({
    company_id: period.company_id,
    location_id: period.location_id,
    utility: period.utility,
    direction,
    label,
    serial: serial || null,
  });

  if (error) {
    return {
      error:
        error.code === "23505"
          ? `There is already a ${period.utility} meter called "${label}" at this property.`
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.billingMeterReadings,
    entityTable: "house_meters",
    summary: `Added the building meter "${label}" (${direction}).`,
    after: { label, direction, serial: serial || null },
  });

  revalidatePath(`/billing/periods/${periodId}`);
  return { success: `Added "${label}".` };
}

/**
 * Saves the building's own readings for a period.
 *
 * Same shape as the tenant readings: a blank present reading means the meter
 * was not read, and the row is removed rather than stored as nought -- a
 * missing reading and a meter that did not move are different things, and
 * recording one as the other would quietly close the gap the whole exercise
 * exists to show.
 */
export async function saveHouseReadings(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingMeterReadings, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const periodId = String(formData.get("periodId") ?? "");
  if (!periodId) return { error: "Missing period." };

  const supabase = await createClient();
  const { data: period } = await supabase
    .from("utility_periods")
    .select("company_id, is_locked")
    .eq("id", periodId)
    .maybeSingle<{ company_id: string; is_locked: boolean }>();

  if (!period) return { error: "That period no longer exists." };
  if (period.is_locked) {
    return { error: "This period is locked. Unlock it to change readings." };
  }

  const readingDate = String(formData.get("reading_date") ?? "").slice(0, 10);

  const rows: {
    company_id: string;
    period_id: string;
    house_meter_id: string;
    previous_reading: number;
    present_reading: number;
    reading_date?: string;
  }[] = [];
  const clear: string[] = [];

  for (const [field, raw] of formData.entries()) {
    if (!field.startsWith("present:")) continue;
    const meterId = field.slice("present:".length);
    const present = String(raw).trim();
    const previous = String(formData.get(`previous:${meterId}`) ?? "").trim();

    if (present === "") {
      clear.push(meterId);
      continue;
    }

    const presentValue = Number(present);
    const previousValue = previous === "" ? 0 : Number(previous);

    if (!Number.isFinite(presentValue) || !Number.isFinite(previousValue)) {
      return { error: "Readings must be numbers." };
    }
    if (presentValue < previousValue) {
      return {
        error: `A meter cannot run backwards: ${presentValue} is below the previous ${previousValue}.`,
      };
    }

    rows.push({
      company_id: period.company_id,
      period_id: periodId,
      house_meter_id: meterId,
      previous_reading: previousValue,
      present_reading: presentValue,
      ...(readingDate ? { reading_date: readingDate } : {}),
    });
  }

  if (clear.length > 0) {
    await supabase
      .from("house_meter_readings")
      .delete()
      .eq("period_id", periodId)
      .in("house_meter_id", clear);
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from("house_meter_readings")
      .upsert(rows, { onConflict: "period_id,house_meter_id" });
    if (error) return { error: error.message };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingMeterReadings,
    entityTable: "house_meter_readings",
    entityId: periodId,
    summary: `Saved ${rows.length} building meter reading${rows.length === 1 ? "" : "s"}.`,
    after: { saved: rows.length, cleared: clear.length },
  });

  revalidatePath(`/billing/periods/${periodId}`);
  return { success: `Saved ${rows.length} reading${rows.length === 1 ? "" : "s"}.` };
}
