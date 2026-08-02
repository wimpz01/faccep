import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createJob } from "../actions";
import { NewJobForm } from "../job-forms";

export const metadata: Metadata = { title: "Repair jobs" };

type JobRow = {
  id: string;
  job_no: string;
  title: string;
  status: string;
  job_kind: string;
  reported_at: string;
  scheduled_for: string | null;
  contract_amount: string;
  actual_cost: string;
  locations: { code: string } | null;
  vendors: { name: string } | null;
};

const OPEN_STATUSES = ["reported", "approved", "assigned", "in_progress"];

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const context = await requirePermission(MODULE.maintenanceRepairs, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.maintenanceRepairs, "edit");

  const supabase = await createClient();
  const [{ data: jobs }, { data: locations }, { data: vendors }] = await Promise.all([
    supabase
      .from("maintenance_jobs")
      .select(
        "id, job_no, title, status, job_kind, reported_at, scheduled_for, contract_amount, actual_cost, locations(code), vendors(name)",
      )
      .eq("company_id", companyId)
      .order("reported_at", { ascending: false })
      .limit(150)
      .returns<JobRow[]>(),
    supabase
      .from("locations")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
    supabase
      .from("vendors")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("status", "approved")
      .order("name"),
  ]);

  const rows = jobs ?? [];
  const open = rows.filter((job) => OPEN_STATUSES.includes(job.status));
  const awaitingInspection = rows.filter((job) => job.status === "completed");
  const contracted = rows.filter((job) => job.job_kind === "contracted");

  // Clicking a figure narrows the list below it to exactly what it counted.
  const shown =
    view === "open"
      ? open
      : view === "inspection"
        ? awaitingInspection
        : view === "contracted"
          ? contracted
          : rows;
  const filterLabel =
    view === "open"
      ? "jobs not yet completed"
      : view === "inspection"
        ? "jobs completed but not signed off"
        : view === "contracted"
          ? "jobs given to a vendor"
          : null;

  return (
    <>
      <PageHeader
        title="Repair jobs"
        description="Reported → approved → assigned → in progress → completed → inspected → closed."
        action={
          <Link href="/maintenance/schedules" className="btn btn-secondary btn-sm">
            Scheduled maintenance
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Open"
          value={open.length}
          hint="Not yet completed"
          href="/maintenance/jobs?view=open"
        />
        <StatTile
          label="Awaiting inspection"
          value={awaitingInspection.length}
          hint="Completed, not signed off"
          href="/maintenance/jobs?view=inspection"
        />
        <StatTile
          label="Contracted"
          value={contracted.length}
          hint="With a vendor"
          href="/maintenance/jobs?view=contracted"
        />
        <StatTile
          label="Committed cost"
          value={money(
            rows
              .filter((job) => job.status !== "cancelled")
              .reduce(
                (sum, job) =>
                  sum + Math.max(Number(job.contract_amount), Number(job.actual_cost)),
                0,
              ),
          )}
          hint="Contract or actual, whichever is higher"
          tone="money"
        />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Report a job"
            description="Contracted work needs a vendor and gets percent-complete sign-off before each payment."
          >
            <NewJobForm
              action={createJob}
              locations={locations ?? []}
              vendors={vendors ?? []}
            />
          </Card>
        </div>
      ) : null}

      {filterLabel ? (
        <FilterNote
          label={filterLabel}
          count={shown.length}
          clearHref="/maintenance/jobs"
        />
      ) : null}

      <Card title="Jobs" bodyClassName="">
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Location</th>
                  <th>Type</th>
                  <th>Reported</th>
                  <th className="text-right">Cost</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link
                        href={`/maintenance/jobs/${job.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {job.job_no}
                      </Link>
                      <p className="text-xs muted">{job.title}</p>
                    </td>
                    <td className="text-xs">{job.locations?.code ?? "—"}</td>
                    <td className="text-xs">
                      {job.job_kind === "contracted"
                        ? `contracted · ${job.vendors?.name ?? "?"}`
                        : "in-house"}
                    </td>
                    <td className="text-xs">{formatDate(job.reported_at)}</td>
                    <td className="text-right tabular-nums">
                      {money(
                        Math.max(Number(job.contract_amount), Number(job.actual_cost)),
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          OPEN_STATUSES.includes(job.status)
                            ? "badge badge-brand"
                            : "badge"
                        }
                      >
                        {job.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No jobs yet{canEdit ? " — report the first one above." : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
