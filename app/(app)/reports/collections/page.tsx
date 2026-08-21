import type { Metadata } from "next";
import Link from "next/link";

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
  check_bank: string | null;
  check_date: string | null;
  cheque_amount: string | null;
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
      "id, payment_no, payment_date, payment_kind, payment_mode, amount, reference, check_bank, check_date, cheque_amount, tenants(company_name)",
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

  /*
   * The cheques taken in, listed on their own. A cheque has to be found
   * again -- to bank it, to chase it, to answer the bank -- and the figure
   * on the receipt is not enough for that: it needs the drawee, the number
   * and the date written on its face.
   *
   * On a cash-and-cheque receipt only the cheque part belongs here. The
   * cash went in the drawer.
   */
  const cheques = rows
    .filter((row) => row.payment_mode === "check" || row.payment_mode === "cash_check")
    .map((row) => ({
      ...row,
      chequeValue:
        row.payment_mode === "cash_check" && row.cheque_amount !== null
          ? Number(row.cheque_amount)
          : Number(row.amount),
    }));

  const chequeTotal = round2(
    cheques.reduce((sum, row) => sum + row.chequeValue, 0),
  );

  const today = new Date().toISOString().slice(0, 10);
  const isToday = from === today && to === today;

  return (
    <ReportShell
      title="Collection report"
      description={`Posted payments from ${formatDate(from)} to ${formatDate(to)}. Voided payments are excluded.`}
      from={from}
      to={to}
    >
      {/* The day's takings is the usual reason this is opened, so it is one
          click rather than two dates. */}
      <div className="mb-4 no-print">
        <Link
          href={`/reports/collections?from=${today}&to=${today}`}
          className={isToday ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
        >
          Today
        </Link>
      </div>

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

      {/* Only when cheques were actually taken in; an all-cash day should
          not print an empty schedule. */}
      {cheques.length > 0 ? (
        <div className="mb-5">
          <Card
            title="Cheque collections"
            description="Cheques taken in over this range, with the particulars needed to bank or trace them."
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Receipt</th>
                    <th>Tenant</th>
                    <th>Bank</th>
                    <th>Cheque no.</th>
                    <th>Cheque date</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {cheques.map((row) => (
                    <tr key={row.id}>
                      <td className="text-xs">{formatDate(row.payment_date)}</td>
                      <td className="text-sm">{row.payment_no}</td>
                      <td className="text-sm">
                        {row.tenants?.company_name ?? "—"}
                      </td>
                      <td className="text-sm">{row.check_bank ?? "—"}</td>
                      <td className="text-sm tabular-nums">
                        {row.reference ?? "—"}
                      </td>
                      <td className="text-xs">
                        {row.check_date ? formatDate(row.check_date) : "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(row.chequeValue)}
                        {row.payment_mode === "cash_check" ? (
                          <span className="block text-xs muted">
                            with {money(round2(Number(row.amount) - row.chequeValue))}{' '}
                            cash
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={6} className="text-right font-semibold">
                      Cheques taken in
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(chequeTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

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
