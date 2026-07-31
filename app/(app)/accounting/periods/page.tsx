import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createPeriod, setPeriodStatus } from "../actions";
import {
  PeriodForm,
  PeriodStatusForm,
  type ReadinessRow,
} from "../accounting-forms";

export const metadata: Metadata = { title: "Accounting periods" };

type PeriodRow = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  closed_at: string | null;
};

export default async function PeriodsPage() {
  const context = await requirePermission(MODULE.accountingPeriods, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.accountingPeriods, "edit");
  const canClose = can(context.permissions, MODULE.accountingPeriods, "approve");

  const supabase = await createClient();
  const { data: periods } = await supabase
    .from("accounting_periods")
    .select("id, name, start_date, end_date, status, closed_at")
    .eq("company_id", companyId)
    .order("start_date", { ascending: false })
    .returns<PeriodRow[]>();

  const rows = periods ?? [];

  // Readiness is only meaningful for periods that are still open.
  const readinessByPeriod = new Map<string, ReadinessRow[]>();
  await Promise.all(
    rows
      .filter((period) => period.status === "open")
      .map(async (period) => {
        const { data } = await supabase.rpc("period_close_readiness", {
          p_period: period.id,
        });
        readinessByPeriod.set(period.id, (data ?? []) as ReadinessRow[]);
      }),
  );

  return (
    <>
      <PageHeader
        title="Accounting periods"
        description="A period cannot be closed while unposted documents are dated inside it — they would be locked out of the ledger."
        action={
          <Link href="/accounting/journal" className="btn btn-secondary btn-sm">
            Journal
          </Link>
        }
      />

      {canEdit ? (
        <div className="mb-6">
          <Card title="Open a period">
            <PeriodForm action={createPeriod} />
          </Card>
        </div>
      ) : null}

      <Card title="Periods" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Status</th>
                  <th style={{ minWidth: "22rem" }}>
                    {canClose ? "Close readiness" : "Outstanding"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((period) => {
                  const readiness = readinessByPeriod.get(period.id) ?? [];
                  const blockers = readiness.filter(
                    (row) => row.severity === "blocker",
                  );
                  return (
                    <tr key={period.id}>
                      <td className="text-sm font-medium">{period.name}</td>
                      <td className="text-xs">{formatDate(period.start_date)}</td>
                      <td className="text-xs">{formatDate(period.end_date)}</td>
                      <td>
                        <span
                          className={
                            period.status === "open" ? "badge badge-brand" : "badge"
                          }
                        >
                          {period.status}
                        </span>
                        {blockers.length > 0 ? (
                          <p
                            className="text-xs mt-1"
                            style={{ color: "var(--danger)" }}
                          >
                            {blockers.reduce(
                              (sum, row) => sum + Number(row.item_count),
                              0,
                            )}{" "}
                            item(s) blocking
                          </p>
                        ) : null}
                      </td>
                      <td>
                        {canClose ? (
                          <PeriodStatusForm
                            action={setPeriodStatus}
                            periodId={period.id}
                            periodName={period.name}
                            status={period.status}
                            readiness={readiness}
                          />
                        ) : readiness.length > 0 ? (
                          <ul className="flex flex-col gap-1">
                            {readiness.map((row) => (
                              <li key={row.kind} className="text-xs">
                                <span
                                  className="badge"
                                  style={
                                    row.severity === "blocker"
                                      ? { color: "var(--danger)" }
                                      : undefined
                                  }
                                >
                                  {row.severity === "blocker" ? "blocks close" : "note"}
                                </span>{" "}
                                {row.kind} ({row.item_count})
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-xs muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No accounting periods defined yet.</EmptyState>
        )}
      </Card>

      <p className="text-xs muted mt-3">
        Only transactions on hold are listed. A released invoice that is still
        unpaid is a finished transaction — the receivable carries forward and
        has no bearing on the close.
      </p>
    </>
  );
}
