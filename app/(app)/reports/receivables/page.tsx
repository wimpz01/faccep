import type { Metadata } from "next";

import { AGING_BUCKETS, ReportShell, agingBucket } from "@/components/report-shell";
import { Card, EmptyState } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Receivables & aging" };

type InvoiceRow = {
  id: string;
  invoice_no: string;
  due_date: string;
  total: string;
  amount_paid: string;
  credited_amount: string;
  tenants: { id: string; company_name: string } | null;
};

export default async function ReceivablesReport({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; view?: string }>;
}) {
  const { tenant, view } = await searchParams;
  const context = await requirePermission(MODULE.reportsReceivables, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const [{ data: invoices }, { data: tenants }] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        "id, invoice_no, due_date, total, amount_paid, credited_amount, tenants(id, company_name)",
      )
      .eq("company_id", companyId)
      .in("status", ["released", "partially_paid"])
      .order("due_date")
      .returns<InvoiceRow[]>(),
    supabase
      .from("tenants")
      .select("id, company_name")
      .eq("company_id", companyId)
      .order("company_name")
      .returns<{ id: string; company_name: string }[]>(),
  ]);

  /*
   * Two controls doing two jobs. The tenant narrows what the report covers;
   * the view decides whether that comes back as aged totals or as the invoices
   * behind them. Both live in the URL, so a particular view of a particular
   * tenant can be bookmarked or sent to somebody.
   *
   * An unknown tenant id is treated as "all" rather than silently showing an
   * empty page.
   */
  const chosen = (tenants ?? []).find((row) => row.id === tenant) ?? null;
  const detailed = view === "detail";

  const open = (invoices ?? [])
    .map((invoice) => ({
      ...invoice,
      balance: round2(
        Number(invoice.total) -
          Number(invoice.amount_paid) -
          Number(invoice.credited_amount),
      ),
    }))
    .filter((invoice) => invoice.balance > 0)
    .filter((invoice) => !chosen || invoice.tenants?.id === chosen.id);

  // Summary by tenant, bucketed by how overdue each invoice is.
  const byTenant = new Map<
    string,
    { name: string; buckets: Record<string, number>; total: number }
  >();

  for (const invoice of open) {
    const tenantId = invoice.tenants?.id ?? "unknown";
    const entry =
      byTenant.get(tenantId) ??
      {
        name: invoice.tenants?.company_name ?? "Unknown tenant",
        buckets: Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, 0])),
        total: 0,
      };
    const bucket = agingBucket(invoice.due_date);
    entry.buckets[bucket] = round2(entry.buckets[bucket] + invoice.balance);
    entry.total = round2(entry.total + invoice.balance);
    byTenant.set(tenantId, entry);
  }

  const rows = [...byTenant.values()].sort((a, b) => b.total - a.total);
  const columnTotals = Object.fromEntries(
    AGING_BUCKETS.map((bucket) => [
      bucket,
      round2(rows.reduce((sum, row) => sum + row.buckets[bucket], 0)),
    ]),
  );
  const grandTotal = round2(rows.reduce((sum, row) => sum + row.total, 0));

  return (
    <ReportShell
      title="Receivables & aging"
      description="Open invoices by tenant, aged from the due date."
      showRange={false}
      scopeNote={`${chosen ? chosen.company_name : "All tenants"} · ${
        detailed ? "Detailed" : "Summary"
      }`}
      extraFilters={
        <>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="view">
              Show
            </label>
            <select
              id="view"
              name="view"
              className="select"
              defaultValue={detailed ? "detail" : "summary"}
            >
              <option value="summary">Summary — aged totals</option>
              <option value="detail">Detailed — every open invoice</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="tenant">
              Tenant
            </label>
            <select
              id="tenant"
              name="tenant"
              className="select"
              defaultValue={chosen?.id ?? ""}
            >
              <option value="">All tenants</option>
              {(tenants ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.company_name}
                </option>
              ))}
            </select>
          </div>
        </>
      }
      filterNote="The tenant narrows either view. One tenant with Detailed gives you their statement."
    >
      {!detailed ? (
        <Card
          title={
            chosen ? `Aging — ${chosen.company_name}` : "Customer aging summary"
          }
          description="What is owed, split by how long it has been due."
          bodyClassName=""
        >
          {rows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    {AGING_BUCKETS.map((bucket) => (
                      <th key={bucket} className="text-right">
                        {bucket === "current" ? "Not yet due" : `${bucket} days`}
                      </th>
                    ))}
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.name}>
                      <td className="text-sm">{row.name}</td>
                      {AGING_BUCKETS.map((bucket) => (
                        <td
                          key={bucket}
                          className="text-right tabular-nums"
                          style={
                            bucket === "120+" && row.buckets[bucket] > 0
                              ? { color: "var(--danger)" }
                              : undefined
                          }
                        >
                          {row.buckets[bucket] ? money(row.buckets[bucket]) : "—"}
                        </td>
                      ))}
                      <td className="text-right tabular-nums font-semibold">
                        {money(row.total)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="font-bold">Total</td>
                    {AGING_BUCKETS.map((bucket) => (
                      <td key={bucket} className="text-right tabular-nums font-bold">
                        {money(columnTotals[bucket])}
                      </td>
                    ))}
                    <td className="text-right tabular-nums font-bold">
                      {money(grandTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              {chosen
                ? `${chosen.company_name} owes nothing.`
                : "Nothing outstanding."}
            </EmptyState>
          )}
        </Card>
      ) : (
      <Card
        title={
          chosen
            ? `Open invoices — ${chosen.company_name}`
            : "Detail — open invoices"
        }
        description={
          chosen
            ? `Every open invoice for ${chosen.company_name}, oldest due first.`
            : "Every open invoice, oldest due first."
        }
        bodyClassName=""
      >
        {open.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Tenant</th>
                  <th>Due</th>
                  <th>Age</th>
                  <th className="text-right">Invoiced</th>
                  <th className="text-right">Settled</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {open.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="text-sm">{invoice.invoice_no}</td>
                    <td className="text-sm">{invoice.tenants?.company_name}</td>
                    <td className="text-xs">{formatDate(invoice.due_date)}</td>
                    <td className="text-xs">
                      <span className="badge">{agingBucket(invoice.due_date)}</span>
                    </td>
                    <td className="text-right tabular-nums">{money(invoice.total)}</td>
                    <td className="text-right tabular-nums">
                      {money(
                        Number(invoice.amount_paid) + Number(invoice.credited_amount),
                      )}
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(invoice.balance)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="text-right font-bold">
                    {chosen ? `Owed by ${chosen.company_name}` : "Total owed"}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(
                      round2(
                        open.reduce((sum, row) => sum + Number(row.total), 0),
                      ),
                    )}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(
                      round2(
                        open.reduce(
                          (sum, row) =>
                            sum +
                            Number(row.amount_paid) +
                            Number(row.credited_amount),
                          0,
                        ),
                      ),
                    )}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(grandTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No open invoices.</EmptyState>
        )}
      </Card>
      )}
    </ReportShell>
  );
}
