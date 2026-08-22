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

/**
 * What came over the counter, by day and by how it was paid.
 *
 * Deliberately not broken down by property. A collection is money received
 * from a tenant, not money earned by a building, and a great deal of it --
 * every prepayment, every deposit -- arrives before anyone knows which bill it
 * will settle. Placing those by guesswork would give the cashier a report that
 * balanced against nothing they could count. What the drawer holds at the end
 * of the day is the question this answers; which property earned it is the
 * income report's question, asked of invoices, which do know.
 */

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

const MODE_FILTERS = [
  { value: "all", label: "All modes" },
  { value: "cash", label: "Cash only" },
  { value: "cheque", label: "Cheque only" },
] as const;

export default async function CollectionsReport({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; mode?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsReceivables, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;
  const mode = MODE_FILTERS.some((row) => row.value === filters.mode)
    ? (filters.mode as string)
    : "all";

  const supabase = await createClient();
  const { data: payments } = await supabase
    .from("payments")
    .select(
      `id, payment_no, payment_date, payment_kind, payment_mode, amount,
       reference, check_bank, check_date, cheque_amount, tenants(company_name)`,
    )
    .eq("company_id", companyId)
    .eq("status", "posted")
    .gte("payment_date", from)
    .lte("payment_date", to)
    .order("payment_date")
    .returns<PaymentRow[]>();

  /**
   * What of a receipt counts under the chosen mode.
   *
   * A cash-and-cheque receipt is both, so it appears under either heading for
   * the part actually paid that way rather than being counted whole in one and
   * lost from the other. Cash means coin and notes: GCash and a bank transfer
   * are their own modes and are reported under All.
   */
  function amountUnderMode(payment: PaymentRow): number {
    const total = Number(payment.amount);
    const cheque =
      payment.payment_mode === "cash_check" && payment.cheque_amount !== null
        ? Number(payment.cheque_amount)
        : null;

    if (mode === "all") return total;

    if (mode === "cheque") {
      if (payment.payment_mode === "check") return total;
      return cheque ?? 0;
    }

    if (payment.payment_mode === "cash") return total;
    return cheque === null ? 0 : round2(total - cheque);
  }

  const counted = (payments ?? [])
    .map((payment) => ({ payment, share: amountUnderMode(payment) }))
    .filter((row) => row.share > 0);

  const total = round2(counted.reduce((sum, row) => sum + row.share, 0));

  const byMode = new Map<string, number>();
  for (const row of counted) {
    const key = row.payment.payment_mode;
    byMode.set(key, round2((byMode.get(key) ?? 0) + row.share));
  }

  const refunds = counted.filter((row) => row.payment.payment_kind === "refund");

  const cheques = counted
    .filter(
      (row) =>
        row.payment.payment_mode === "check" ||
        row.payment.payment_mode === "cash_check",
    )
    .map((row) => ({
      ...row.payment,
      chequeValue:
        row.payment.payment_mode === "cash_check" &&
        row.payment.cheque_amount !== null
          ? Number(row.payment.cheque_amount)
          : Number(row.payment.amount),
    }));

  const chequeTotal = round2(
    cheques.reduce((sum, row) => sum + row.chequeValue, 0),
  );

  const today = new Date().toISOString().slice(0, 10);
  const isToday = from === today && to === today;

  const modeLabel =
    MODE_FILTERS.find((row) => row.value === mode)?.label ?? "All modes";

  const modeName = (key: string) =>
    key === "cash_check" ? "cash + cheque" : key;

  return (
    <ReportShell
      title="Collection report"
      description={`Posted payments from ${formatDate(from)} to ${formatDate(to)}. Voided payments are excluded.`}
      from={from}
      to={to}
      scopeNote={modeLabel}
      extraFilters={
        <div>
          <label className="label" htmlFor="mode">
            Mode of payment
          </label>
          <select id="mode" name="mode" className="select" defaultValue={mode}>
            {MODE_FILTERS.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </select>
        </div>
      }
      filterNote="A cash-and-cheque receipt counts under either mode for the part paid that way, so choosing one never inflates or loses money."
    >
      <div className="mb-4 no-print flex gap-2 flex-wrap">
        <Link
          href={`/reports/collections?from=${today}&to=${today}&mode=${mode}`}
          className={isToday ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
        >
          Today
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <StatTile
          label="Collected"
          value={money(total)}
          hint={`${counted.length} payment(s) · ${modeLabel.toLowerCase()}`}
          tone="money"
        />
        <StatTile
          label="Refunds"
          value={money(round2(refunds.reduce((sum, row) => sum + row.share, 0)))}
          hint={`${refunds.length} refund(s)`}
        />
        <StatTile
          label="Modes used"
          value={byMode.size}
          hint={[...byMode.keys()].map(modeName).join(", ") || "—"}
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
                    .map(([key, amount]) => (
                      <tr key={key}>
                        <td className="text-sm">{modeName(key)}</td>
                        <td className="text-right tabular-nums">{money(amount)}</td>
                        <td className="text-right tabular-nums">
                          {total ? ((amount / total) * 100).toFixed(1) : "0"}%
                        </td>
                      </tr>
                    ))}
                  <tr>
                    <td className="text-right font-semibold">Total</td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(total)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>Nothing collected under these filters.</EmptyState>
          )}
        </Card>
      </div>

      {/* Only when cheques were actually taken in; an all-cash day should not
          print an empty schedule. */}
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
                            with{" "}
                            {money(round2(Number(row.amount) - row.chequeValue))}{" "}
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
        {counted.length > 0 ? (
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
                {counted.map((row) => (
                  <tr key={row.payment.id}>
                    <td className="text-xs">
                      {formatDate(row.payment.payment_date)}
                    </td>
                    <td className="text-sm">
                      {row.payment.payment_no}
                      {row.payment.reference ? (
                        <span className="block text-xs muted">
                          {row.payment.reference}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-sm">
                      {row.payment.tenants?.company_name ?? "—"}
                    </td>
                    <td className="text-xs">{row.payment.payment_kind}</td>
                    <td className="text-xs">
                      {modeName(row.payment.payment_mode)}
                    </td>
                    <td className="text-right tabular-nums">
                      {money(row.share)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} className="text-right font-semibold">
                    Total
                  </td>
                  <td className="text-right tabular-nums font-semibold">
                    {money(total)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>Nothing collected under these filters.</EmptyState>
        )}
      </Card>
    </ReportShell>
  );
}
