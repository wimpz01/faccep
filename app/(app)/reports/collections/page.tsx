import type { Metadata } from "next";

import { ReportShell, defaultRange } from "@/components/report-shell";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Collection report" };

type PaymentRow = {
  id: string;
  payment_no: string;
  payment_date: string;
  payment_kind: string;
  payment_mode: string;
  amount: string;
  reference: string | null;
  tenants: { company_name: string } | null;
};

export default async function CollectionsReport({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsReceivables, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;

  const supabase = await createClient();
  const { data: payments } = await supabase
    .from("payments")
    .select(
      "id, payment_no, payment_date, payment_kind, payment_mode, amount, reference, tenants(company_name)",
    )
    .eq("company_id", companyId)
    .eq("status", "posted")
    .gte("payment_date", from)
    .lte("payment_date", to)
    .order("payment_date")
    .returns<PaymentRow[]>();

  const rows = payments ?? [];
  const total = round2(rows.reduce((sum, row) => sum + Number(row.amount), 0));

  const byMode = new Map<string, number>();
  for (const row of rows) {
    byMode.set(row.payment_mode, round2((byMode.get(row.payment_mode) ?? 0) + Number(row.amount)));
  }

  const refunds = rows.filter((row) => row.payment_kind === "refund");

  return (
    <ReportShell
      title="Collection report"
      description={`Posted payments from ${formatDate(from)} to ${formatDate(to)}. Voided payments are excluded.`}
      from={from}
      to={to}
    >
      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <StatTile label="Collected" value={money(total)} hint={`${rows.length} payment(s)`} tone="money" />
        <StatTile
          label="Refunds"
          value={money(refunds.reduce((sum, row) => sum + Number(row.amount), 0))}
          hint={`${refunds.length} refund(s)`}
        />
        <StatTile
          label="Modes used"
          value={byMode.size}
          hint={[...byMode.keys()].join(", ") || "—"}
        />
      </div>

      <div className="mb-5">
        <Card title="By payment mode" bodyClassName="">
          {byMode.size > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byMode.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([mode, amount]) => (
                      <tr key={mode}>
                        <td className="text-sm">{mode}</td>
                        <td className="text-right tabular-nums">{money(amount)}</td>
                        <td className="text-right tabular-nums">
                          {total ? ((amount / total) * 100).toFixed(1) : "0"}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>Nothing collected in this range.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Detail" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Tenant</th>
                  <th>Type</th>
                  <th>Mode</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs">{formatDate(row.payment_date)}</td>
                    <td className="text-sm">
                      {row.payment_no}
                      {row.reference ? (
                        <p className="text-xs muted">{row.reference}</p>
                      ) : null}
                    </td>
                    <td className="text-sm">{row.tenants?.company_name ?? "—"}</td>
                    <td className="text-xs">{row.payment_kind}</td>
                    <td className="text-xs">{row.payment_mode}</td>
                    <td className="text-right tabular-nums">{money(row.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} className="text-right font-bold">
                    Total
                  </td>
                  <td className="text-right tabular-nums font-bold">{money(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No payments in this range.</EmptyState>
        )}
      </Card>
    </ReportShell>
  );
}
