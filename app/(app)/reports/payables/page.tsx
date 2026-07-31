import type { Metadata } from "next";

import { AGING_BUCKETS, ReportShell, agingBucket } from "@/components/report-shell";
import { Card, EmptyState } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Vendor aging" };

type BillRow = {
  id: string;
  invoice_no: string;
  due_date: string;
  total: string;
  amount_paid: string;
  vendors: { id: string; name: string } | null;
};

export default async function PayablesAgingReport() {
  const context = await requirePermission(MODULE.reportsExpenses, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const { data: bills } = await supabase
    .from("supplier_invoices")
    .select("id, invoice_no, due_date, total, amount_paid, vendors(id, name)")
    .eq("company_id", companyId)
    .in("status", ["open", "partially_paid"])
    .order("due_date")
    .returns<BillRow[]>();

  const open = (bills ?? [])
    .map((bill) => ({
      ...bill,
      balance: round2(Number(bill.total) - Number(bill.amount_paid)),
    }))
    .filter((bill) => bill.balance > 0);

  const byVendor = new Map<
    string,
    { name: string; buckets: Record<string, number>; total: number }
  >();

  for (const bill of open) {
    const key = bill.vendors?.id ?? "unknown";
    const entry =
      byVendor.get(key) ??
      {
        name: bill.vendors?.name ?? "Unknown supplier",
        buckets: Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, 0])),
        total: 0,
      };
    const bucket = agingBucket(bill.due_date);
    entry.buckets[bucket] = round2(entry.buckets[bucket] + bill.balance);
    entry.total = round2(entry.total + bill.balance);
    byVendor.set(key, entry);
  }

  const rows = [...byVendor.values()].sort((a, b) => b.total - a.total);
  const grandTotal = round2(rows.reduce((sum, row) => sum + row.total, 0));

  return (
    <ReportShell
      title="Vendor aging"
      description="What is owed to suppliers, aged from each invoice's due date."
      showRange={false}
    >
      <div className="mb-5">
        <Card title="Aging summary" bodyClassName="">
          {rows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Supplier</th>
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
                        <td key={bucket} className="text-right tabular-nums">
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
                        {money(
                          round2(
                            rows.reduce((sum, row) => sum + row.buckets[bucket], 0),
                          ),
                        )}
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
            <EmptyState>Nothing owed to suppliers.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Detail" bodyClassName="">
        {open.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Supplier</th>
                  <th>Due</th>
                  <th>Age</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {open.map((bill) => (
                  <tr key={bill.id}>
                    <td className="text-sm">{bill.invoice_no}</td>
                    <td className="text-sm">{bill.vendors?.name}</td>
                    <td className="text-xs">{formatDate(bill.due_date)}</td>
                    <td className="text-xs">
                      <span className="badge">{agingBucket(bill.due_date)}</span>
                    </td>
                    <td className="text-right tabular-nums">{money(bill.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>Nothing outstanding.</EmptyState>
        )}
      </Card>
    </ReportShell>
  );
}
