"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

export async function createSchedule(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.maintenanceScheduled, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const title = String(formData.get("title") ?? "").trim();
  if (title.length < 3) return { error: "Give the recurring job a title." };

  const monthOfYear = Number(formData.get("month_of_year") ?? 0);
  const intervalMonths = Number(formData.get("interval_months") ?? 12);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_schedules")
    .insert({
      company_id: companyId,
      location_id: String(formData.get("location_id") ?? "") || null,
      title,
      description: String(formData.get("description") ?? "").trim() || null,
      month_of_year: monthOfYear >= 1 && monthOfYear <= 12 ? monthOfYear : null,
      interval_months: intervalMonths > 0 ? intervalMonths : 12,
      assigned_to: String(formData.get("assigned_to") ?? "").trim() || null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.maintenanceScheduled,
    entityTable: "maintenance_schedules",
    entityId: data.id,
    summary: `Added recurring maintenance "${title}".`,
  });

  revalidatePath("/maintenance/schedules");
  return { success: `"${title}" scheduled.` };
}

/** Turns a scheduled item into a live job for this cycle. */
export async function raiseScheduledJob(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.maintenanceRepairs, "edit")) return;

  const scheduleId = String(formData.get("id") ?? "");
  const companyId = context.activeCompany!.companyId;
  const supabase = await createClient();

  const { data: schedule } = await supabase
    .from("maintenance_schedules")
    .select("title, description, location_id, assigned_to")
    .eq("id", scheduleId)
    .single();
  if (!schedule) return;

  const { data: job, error } = await supabase
    .from("maintenance_jobs")
    .insert({
      company_id: companyId,
      schedule_id: scheduleId,
      title: schedule.title,
      description: schedule.description,
      location_id: schedule.location_id,
      assigned_to: schedule.assigned_to,
      status: "approved",
    })
    .select("id, job_no")
    .single();

  if (error) return;

  await logAudit({
    action: "create",
    moduleKey: MODULE.maintenanceScheduled,
    entityTable: "maintenance_jobs",
    entityId: job.id,
    summary: `Raised ${job.job_no} from the maintenance schedule.`,
  });

  revalidatePath("/maintenance/schedules");
  revalidatePath("/maintenance/jobs");
}
