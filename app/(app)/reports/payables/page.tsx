import type { Metadata } from "next";

import { AGING_BUCKETS, ReportShell, agingBucket } from "@/components/report-shell";
import { Card, EmptyState } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Supplier aging" };

type BillRow = {
  id: string;
  invoice_no: string;
  bill_no: string;
  invoice_date: string;
  due_date: string;
  total: string;
  amount_paid: string;
  vendors: { id: string; name: string } | null;
};

export default async function PayablesAgingReport({
  searchParams,
}: {
  searchParams: Promise<{ vendor?: string }>;
}) {
  const { vendor } = await searchParams;
  const context = await requirePermission(MODULE.reportsExpenses, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();

  const [{ data: bills }, { data: vendors }] = await Promise.all([
    supabase
      .from("supplier_invoices")
      .select(
        "id, invoice_no, bill_no, invoice_date, due_date, total, amount_paid, vendors(id, name)",
      )
      .eq("company_id", companyId)
      .in("status", ["open", "partially_paid"])
      .order("due_date")
      .returns<BillRow[]>(),
    supabase
      .from("vendors")
      .select("id, name")
      .eq("company_id", companyId)
      .order("name")
      .returns<{ id: string; name: string }[]>(),
  ]);

  // A named supplier narrows the whole report; anything else reports on all of
  // them. An unknown id is treated as "all" rather than silently showing an
  // empty page.
  const chosen = (vendors ?? []).find((row) => row.id === vendor) ?? null;

  const open = (bills ?? [])
    .map((bill) => ({
      ...bill,
      balance: round2(Number(bill.total) - Number(bill.amount_paid)),
    }))
    .filter((bill) => bill.balance > 0)
    .filter((bill) => !chosen || bill.vendors?.id === chosen.id);

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
      title="Supplier aging"
      description="What is owed to each supplier, aged from the day each invoice fell due."
      showRange={false}
      scopeNote={chosen ? chosen.name : "All suppliers"}
      extraFilters={
        <div className="sm:col-span-2">
          <label className="label" htmlFor="vendor">
            Supplier
          </label>
          <select
            id="vendor"
            name="vendor"
            className="select"
            defaultValue={chosen?.id ?? ""}
          >
            <option value="">All suppliers — summary</option>
            {(vendors ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">
            Choose a supplier for a detailed statement of what is owed to them.
          </p>
        </div>
      }
    >
      <div className="mb-5">
        <Card
          title={chosen ? `Aging — ${chosen.name}` : "Aging summary"}
          bodyClassName=""
        >
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
            <EmptyState>
              {chosen
                ? `Nothing is owed to ${chosen.name}.`
                : "Nothing owed to suppliers."}
            </EmptyState>
          )}
        </Card>
      </div>

      <Card
        title={chosen ? "Invoices outstanding" : "Detail"}
        description={
          chosen
            ? `Every open invoice from ${chosen.name}, oldest due first.`
            : undefined
        }
        bodyClassName=""
      >
        {open.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Their invoice</th>
                  {chosen ? null : <th>Supplier</th>}
                  <th>Invoiced</th>
                  <th>Due</th>
                  <th>Age</th>
                  {chosen ? <th className="text-right">Invoice total</th> : null}
                  {chosen ? <th className="text-right">Paid</th> : null}
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {open.map((bill) => (
                  <tr key={bill.id}>
                    <td className="text-sm">{bill.bill_no}</td>
                    <td className="text-sm">{bill.invoice_no}</td>
                    {chosen ? null : (
                      <td className="text-sm">{bill.vendors?.name}</td>
                    )}
                    <td className="text-xs">{formatDate(bill.invoice_date)}</td>
                    <td className="text-xs">{formatDate(bill.due_date)}</td>
                    <td className="text-xs">
                      <span className="badge">{agingBucket(bill.due_date)}</span>
                    </td>
                    {chosen ? (
                      <td className="text-right tabular-nums">
                        {money(bill.total)}
                      </td>
                    ) : null}
                    {chosen ? (
                      <td className="text-right tabular-nums">
                        {money(bill.amount_paid)}
                      </td>
                    ) : null}
                    <td className="text-right tabular-nums">
                      {money(bill.balance)}
                    </td>
                  </tr>
                ))}
                {chosen ? (
                  <tr>
                    <td colSpan={5} className="text-right font-bold">
                      Owed to {chosen.name}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(
                        round2(
                          open.reduce((sum, bill) => sum + Number(bill.total), 0),
                        ),
                      )}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(
                        round2(
                          open.reduce(
                            (sum, bill) => sum + Number(bill.amount_paid),
                            0,
                          ),
                        ),
                      )}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(grandTotal)}
                    </td>
                  </tr>
                ) : null}
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
