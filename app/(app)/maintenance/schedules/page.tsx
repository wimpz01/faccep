import type { Metadata } from "next";
import Link from "next/link";

import { PrintButton } from "@/components/print-button";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createSchedule, raiseScheduledJob } from "./actions";
import { ScheduleForm } from "./schedule-form";

export const metadata: Metadata = { title: "Scheduled maintenance" };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type ScheduleRow = {
  id: string;
  title: string;
  description: string | null;
  month_of_year: number | null;
  interval_months: number;
  assigned_to: string | null;
  is_active: boolean;
  locations: { code: string; name: string } | null;
  maintenance_jobs: { id: string; job_no: string; status: string; reported_at: string }[];
};

export default async function SchedulesPage() {
  const context = await requirePermission(MODULE.maintenanceScheduled, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.maintenanceScheduled, "edit");
  const canRaise = can(context.permissions, MODULE.maintenanceRepairs, "edit");

  const supabase = await createClient();
  const [{ data: schedules }, { data: locations }] = await Promise.all([
    supabase
      .from("maintenance_schedules")
      .select(
        "id, title, description, month_of_year, interval_months, assigned_to, is_active, locations(code, name), maintenance_jobs(id, job_no, status, reported_at)",
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("month_of_year", { nullsFirst: false })
      .returns<ScheduleRow[]>(),
    supabase
      .from("locations")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
  ]);

  const rows = schedules ?? [];
  const thisYear = new Date().getFullYear();

  return (
    <>
      <div className="no-print">
        <PageHeader
          title="Scheduled maintenance"
          description="Recurring work, when it falls due, and whether it has been raised this cycle."
          action={
            <div className="flex gap-2 flex-wrap">
              <Link href="/maintenance/jobs" className="btn btn-secondary btn-sm">
                Repair jobs
              </Link>
              <PrintButton label="Print schedule" />
            </div>
          }
        />
      </div>

      {canEdit ? (
        <div className="mb-6 no-print">
          <Card title="Add to the schedule">
            <ScheduleForm action={createSchedule} locations={locations ?? []} />
          </Card>
        </div>
      ) : null}

      <Card title={`Schedule — ${thisYear}`} bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Location</th>
                  <th>When</th>
                  <th>Usually done by</th>
                  <th>This cycle</th>
                  {canRaise ? <th className="text-right no-print">Raise</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((schedule) => {
                  const raisedThisYear = (schedule.maintenance_jobs ?? []).find(
                    (job) => job.reported_at.startsWith(String(thisYear)),
                  );
                  return (
                    <tr key={schedule.id}>
                      <td>
                        <span className="font-medium text-sm">{schedule.title}</span>
                        {schedule.description ? (
                          <p className="text-xs muted">{schedule.description}</p>
                        ) : null}
                      </td>
                      <td className="text-xs">
                        {schedule.locations?.code ?? "All"}
                      </td>
                      <td className="text-xs">
                        {schedule.month_of_year
                          ? MONTHS[schedule.month_of_year - 1]
                          : "Any month"}
                        <p className="muted">
                          every {schedule.interval_months} month
                          {schedule.interval_months === 1 ? "" : "s"}
                        </p>
                      </td>
                      <td className="text-xs">{schedule.assigned_to ?? "—"}</td>
                      <td className="text-xs">
                        {raisedThisYear ? (
                          <Link
                            href={`/maintenance/jobs/${raisedThisYear.id}`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {raisedThisYear.job_no} ({raisedThisYear.status})
                          </Link>
                        ) : (
                          <span className="muted">not raised</span>
                        )}
                      </td>
                      {canRaise ? (
                        <td className="text-right no-print">
                          {!raisedThisYear ? (
                            <form action={raiseScheduledJob}>
                              <input type="hidden" name="id" value={schedule.id} />
                              <button type="submit" className="btn btn-secondary btn-sm">
                                Raise job
                              </button>
                            </form>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>Nothing on the maintenance schedule yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
