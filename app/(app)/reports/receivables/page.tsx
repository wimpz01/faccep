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

export default async function ReceivablesReport() {
  const context = await requirePermission(MODULE.reportsReceivables, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const { data: invoices } = await supabase
    .from("invoices")
    .select(
      "id, invoice_no, due_date, total, amount_paid, credited_amount, tenants(id, company_name)",
    )
    .eq("company_id", companyId)
    .in("status", ["released", "partially_paid"])
    .order("due_date")
    .returns<InvoiceRow[]>();

  const open = (invoices ?? [])
    .map((invoice) => ({
      ...invoice,
      balance: round2(
        Number(invoice.total) -
          Number(invoice.amount_paid) -
          Number(invoice.credited_amount),
      ),
    }))
    .filter((invoice) => invoice.balance > 0);

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
    >
      <div className="mb-5">
        <Card title="Customer aging summary" bodyClassName="">
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
            <EmptyState>Nothing outstanding.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Detail — open invoices" bodyClassName="">
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
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No open invoices.</EmptyState>
        )}
      </Card>
    </ReportShell>
  );
}
