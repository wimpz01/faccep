import type { Metadata } from "next";

import { ReportShell, defaultRange } from "@/components/report-shell";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Maintenance cost" };

type JobRow = {
  id: string;
  job_no: string;
  title: string;
  status: string;
  job_kind: string;
  reported_at: string;
  contract_amount: string;
  actual_cost: string;
  locations: { code: string; name: string } | null;
  vendors: { name: string } | null;
};

export default async function MaintenanceReport({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsMaintenance, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;

  const supabase = await createClient();
  const [{ data: jobs }, { data: issues }] = await Promise.all([
    supabase
      .from("maintenance_jobs")
      .select(
        "id, job_no, title, status, job_kind, reported_at, contract_amount, actual_cost, locations(code, name), vendors(name)",
      )
      .eq("company_id", companyId)
      .gte("reported_at", from)
      .lte("reported_at", to)
      .order("reported_at", { ascending: false })
      .returns<JobRow[]>(),
    // Materials issued in the range, valued at the movement's own unit cost.
    supabase
      .from("inventory_movements")
      .select("quantity, unit_cost, movement_kind, created_at")
      .eq("company_id", companyId)
      .in("movement_kind", ["issue", "return"])
      .gte("created_at", from)
      .lte("created_at", `${to}T23:59:59`),
  ]);

  const rows = jobs ?? [];
  const inHouse = rows.filter((job) => job.job_kind === "in_house");
  const contracted = rows.filter((job) => job.job_kind === "contracted");

  const cost = (job: JobRow) =>
    Math.max(Number(job.contract_amount), Number(job.actual_cost));

  const contractedCost = round2(contracted.reduce((sum, job) => sum + cost(job), 0));

  // Issues are negative quantities, returns positive; netting them gives the
  // material actually consumed.
  const materialCost = round2(
    (issues ?? []).reduce(
      (sum, movement) =>
        sum + -Number(movement.quantity) * Number(movement.unit_cost),
      0,
    ),
  );

  const byLocation = new Map<string, { name: string; jobs: number; cost: number }>();
  for (const job of rows) {
    const key = job.locations?.code ?? "Unattributed";
    const entry =
      byLocation.get(key) ??
      { name: job.locations?.name ?? "Unattributed", jobs: 0, cost: 0 };
    entry.jobs += 1;
    entry.cost = round2(entry.cost + cost(job));
    byLocation.set(key, entry);
  }

  return (
    <ReportShell
      title="Maintenance cost"
      description={`Jobs reported between ${formatDate(from)} and ${formatDate(to)}.`}
      from={from}
      to={to}
    >
      <div className="grid gap-4 sm:grid-cols-4 mb-5">
        <StatTile label="Jobs" value={rows.length} hint={`${inHouse.length} in-house`} />
        <StatTile
          label="Contracted cost"
          value={money(contractedCost)}
          hint={`${contracted.length} job(s)`}
          tone="money"
        />
        <StatTile
          label="Materials consumed"
          value={money(materialCost)}
          hint="Issues net of returns"
        />
        <StatTile
          label="Total"
          value={money(round2(contractedCost + materialCost))}
          hint="Contracted plus materials"
        />
      </div>

      <div className="mb-5">
        <Card title="By location" bodyClassName="">
          {byLocation.size > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="text-right">Jobs</th>
                    <th className="text-right">Job cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byLocation.entries()]
                    .sort((a, b) => b[1].cost - a[1].cost)
                    .map(([code, entry]) => (
                      <tr key={code}>
                        <td className="text-sm">
                          {code}
                          <p className="text-xs muted">{entry.name}</p>
                        </td>
                        <td className="text-right tabular-nums">{entry.jobs}</td>
                        <td className="text-right tabular-nums">{money(entry.cost)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No jobs in this range.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Jobs" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Location</th>
                  <th>Type</th>
                  <th>Reported</th>
                  <th>Status</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <span className="text-sm font-medium">{job.job_no}</span>
                      <p className="text-xs muted">{job.title}</p>
                    </td>
                    <td className="text-xs">{job.locations?.code ?? "—"}</td>
                    <td className="text-xs">
                      {job.job_kind === "contracted"
                        ? (job.vendors?.name ?? "contracted")
                        : "in-house"}
                    </td>
                    <td className="text-xs">{formatDate(job.reported_at)}</td>
                    <td>
                      <span className="badge">{job.status.replace("_", " ")}</span>
                    </td>
                    <td className="text-right tabular-nums">{money(cost(job))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No jobs in this range.</EmptyState>
        )}
      </Card>
    </ReportShell>
  );
}
