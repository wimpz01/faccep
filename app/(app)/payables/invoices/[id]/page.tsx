import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, StatTile, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Supplier invoice" };

type BillDetail = {
  id: string;
  company_id: string;
  bill_no: string;
  invoice_no: string;
  invoice_date: string;
  due_date: string;
  amount: string;
  vat_amount: string;
  withholding_tax: string;
  total: string;
  amount_paid: string;
  status: string;
  notes: string | null;
  charge_kind: string;
  created_at: string;
  vendors: { name: string; tin: string | null } | null;
  locations: { code: string; name: string } | null;
  maintenance_jobs: { job_no: string; job_kind: string } | null;
  purchase_orders: { id: string; po_no: string } | null;
  supplier_invoice_lines: {
    id: string;
    line_no: number;
    sku: string | null;
    description: string;
    unit_of_measure: string;
    quantity: string;
    unit_price: string;
    amount: string;
    non_stock_items: { code: string; name: string } | null;
    inventory_items: { sku: string | null; name: string } | null;
  }[];
};

/**
 * One supplier invoice, and what it did.
 *
 * The lines say what was bought and the journal entry says where it landed --
 * the two questions asked of a bill, on one page rather than in two systems.
 */
export default async function SupplierInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.payablesInvoices, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const { data: bill } = await supabase
    .from("supplier_invoices")
    .select(
      `id, company_id, bill_no, invoice_no, invoice_date, due_date, amount,
       vat_amount, withholding_tax, total, amount_paid, status, notes,
       charge_kind, created_at,
       vendors(name, tin), locations(code, name),
       maintenance_jobs(job_no, job_kind), purchase_orders(id, po_no),
       supplier_invoice_lines(id, line_no, sku, description, unit_of_measure,
         quantity, unit_price, amount,
         non_stock_items(code, name), inventory_items(sku, name))`,
    )
    .eq("id", id)
    .maybeSingle<BillDetail>();

  if (!bill || bill.company_id !== companyId) notFound();

  // What the bill posted to the ledger, so the accounting is on the document.
  const { data: entries } = await supabase
    .from("journal_entries")
    .select(
      `entry_no, entry_date, memo,
       journal_lines(debit, credit, description, chart_of_accounts(code, name))`,
    )
    .eq("source_table", "supplier_invoices")
    .eq("source_id", id)
    .returns<
      {
        entry_no: string;
        entry_date: string;
        memo: string | null;
        journal_lines: {
          debit: string;
          credit: string;
          description: string | null;
          chart_of_accounts: { code: string; name: string } | null;
        }[];
      }[]
    >();

  const lines = (bill.supplier_invoice_lines ?? []).sort(
    (a, b) => a.line_no - b.line_no,
  );
  const balance = Number(bill.total) - Number(bill.amount_paid);
  const overdue =
    balance > 0 && bill.due_date < new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={bill.bill_no}
        description={`${bill.vendors?.name ?? "Unknown supplier"} · supplier ref. ${bill.invoice_no} · ${formatDate(bill.invoice_date)}`}
        action={
          <div className="flex gap-2 flex-wrap">
            {bill.purchase_orders ? (
              <Link
                href={`/purchasing/orders/${bill.purchase_orders.id}`}
                className="btn btn-secondary btn-sm"
              >
                {bill.purchase_orders.po_no}
              </Link>
            ) : null}
            <Link href="/payables" className="btn btn-secondary btn-sm">
              Back to payables
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile label="Total" value={money(bill.total)} tone="money" />
        <StatTile label="Paid" value={money(bill.amount_paid)} />
        <StatTile
          label="Balance"
          value={money(balance)}
          hint={
            overdue
              ? `Overdue since ${formatDate(bill.due_date)}`
              : `Due ${formatDate(bill.due_date)}`
          }
        />
        <StatTile
          label="Status"
          value={bill.status}
          hint={bill.locations ? bill.locations.code : "Company-wide"}
        />
      </div>

      <div className="mb-6">
        <Card title="What was billed" bodyClassName="">
          {lines.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Code</th>
                    <th style={{ minWidth: "16rem" }}>Description</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td className="text-xs tabular-nums">{line.line_no}</td>
                      <td className="text-xs tabular-nums muted">
                        {line.non_stock_items?.code ??
                          line.inventory_items?.sku ??
                          line.sku ??
                          "—"}
                      </td>
                      <td className="text-sm">
                        {line.description}
                        {line.non_stock_items ? (
                          <p className="text-xs muted">Service — non-stock</p>
                        ) : line.inventory_items ? (
                          <p className="text-xs muted">Stock item</p>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums text-sm">
                        {Number(line.quantity)} {line.unit_of_measure}
                      </td>
                      <td className="text-right tabular-nums text-sm">
                        {money(line.unit_price)}
                      </td>
                      <td className="text-right tabular-nums text-sm">
                        {money(line.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="text-right text-sm">
                      Net of VAT
                    </td>
                    <td className="text-right tabular-nums text-sm">
                      {money(bill.amount)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={5} className="text-right text-sm">
                      VAT
                    </td>
                    <td className="text-right tabular-nums text-sm">
                      {money(bill.vat_amount)}
                    </td>
                  </tr>
                  {Number(bill.withholding_tax) > 0 ? (
                    <tr>
                      <td colSpan={5} className="text-right text-sm">
                        Less tax withheld
                      </td>
                      <td className="text-right tabular-nums text-sm">
                        ({money(bill.withholding_tax)})
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <td colSpan={5} className="text-right font-semibold">
                      Total payable
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(bill.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <EmptyState>
              This bill was recorded as a single total of {money(bill.amount)}{" "}
              with no itemised lines.
            </EmptyState>
          )}
        </Card>
      </div>

      <Card
        title="Journal entry"
        description="Written when the bill was recorded. Every posted transaction has one."
        bodyClassName=""
      >
        {entries && entries.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Account</th>
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) =>
                  (entry.journal_lines ?? []).map((line, index) => (
                    <tr key={`${entry.entry_no}-${index}`}>
                      <td className="text-xs tabular-nums muted">
                        {index === 0 ? entry.entry_no : ""}
                      </td>
                      <td className="text-sm">
                        {line.chart_of_accounts
                          ? `${line.chart_of_accounts.code} — ${line.chart_of_accounts.name}`
                          : "—"}
                        {line.description ? (
                          <p className="text-xs muted">{line.description}</p>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums text-sm">
                        {Number(line.debit) > 0 ? money(line.debit) : ""}
                      </td>
                      <td className="text-right tabular-nums text-sm">
                        {Number(line.credit) > 0 ? money(line.credit) : ""}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No journal entry — the chart of accounts may not be set up.
          </EmptyState>
        )}
      </Card>

      {bill.notes ? (
        <div className="mt-6">
          <Card title="Notes">
            <p className="text-sm">{bill.notes}</p>
          </Card>
        </div>
      ) : null}

      <p className="text-xs muted mt-4">
        Recorded {formatDateTime(bill.created_at)}
        {bill.maintenance_jobs?.job_no
          ? ` · against ${bill.maintenance_jobs.job_no} (${bill.maintenance_jobs.job_kind})`
          : ""}
      </p>
    </>
  );
}
