import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { generateInvoices } from "./actions";
import { STATUS_BADGE } from "./constants";
import { GenerateForm } from "./invoice-forms";

export const metadata: Metadata = { title: "Invoices" };

type InvoiceRow = {
  id: string;
  invoice_no: string;
  status: string;
  invoice_date: string;
  due_date: string;
  total: string;
  amount_paid: string;
  credited_amount: string;
  tenants: { company_name: string } | null;
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const context = await requirePermission(MODULE.billingInvoices, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.billingInvoices, "edit");

  const supabase = await createClient();
  let query = supabase
    .from("invoices")
    .select(
      "id, invoice_no, status, invoice_date, due_date, total, amount_paid, credited_amount, tenants(company_name)",
    )
    .eq("company_id", companyId);

  if (status) query = query.eq("status", status);

  const { data: invoices } = await query
    .order("invoice_date", { ascending: false })
    .limit(200)
    .returns<InvoiceRow[]>();

  const rows = invoices ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const outstanding = rows
    .filter((row) => row.status === "released" || row.status === "partially_paid")
    .reduce(
      (sum, row) =>
        sum +
        (Number(row.total) - Number(row.amount_paid) - Number(row.credited_amount)),
      0,
    );

  const overdue = rows.filter(
    (row) =>
      (row.status === "released" || row.status === "partially_paid") &&
      row.due_date < today,
  );

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Generated from contracts and meter readings. Once released, an invoice is locked."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Outstanding"
          value={money(outstanding)}
          hint="Released and unpaid"
          tone="money"
        />
        <StatTile
          label="Overdue"
          value={overdue.length}
          hint="Past the due date"
        />
        <StatTile
          label="Drafts"
          value={rows.filter((row) => row.status === "draft").length}
          hint="Not yet released"
        />
        <StatTile label="Total shown" value={rows.length} hint="Most recent 200" />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Generate a month's invoices"
            description="One draft per active contract: rent with escalation, metered utilities, genset share, and any late penalty."
          >
            <GenerateForm action={generateInvoices} />
          </Card>
        </div>
      ) : null}

      <Card
        title="Invoices"
        action={
          <div className="flex gap-2 flex-wrap">
            {[
              ["", "All"],
              ["draft", "Drafts"],
              ["released", "Released"],
              ["partially_paid", "Part paid"],
              ["paid", "Paid"],
              ["cancelled", "Cancelled"],
            ].map(([value, label]) => (
              <Link
                key={value || "all"}
                href={value ? `/billing/invoices?status=${value}` : "/billing/invoices"}
                className={`btn btn-sm ${status === value || (!status && !value) ? "btn-primary" : "btn-secondary"}`}
              >
                {label}
              </Link>
            ))}
          </div>
        }
        bodyClassName=""
      >
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Tenant</th>
                  <th>Date</th>
                  <th>Due</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Balance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((invoice) => {
                  const balance =
                    Number(invoice.total) -
                    Number(invoice.amount_paid) -
                    Number(invoice.credited_amount);
                  const isOverdue =
                    (invoice.status === "released" ||
                      invoice.status === "partially_paid") &&
                    invoice.due_date < today;
                  return (
                    <tr key={invoice.id}>
                      <td>
                        <Link
                          href={`/billing/invoices/${invoice.id}`}
                          className="font-semibold"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {invoice.invoice_no}
                        </Link>
                      </td>
                      <td className="text-sm">{invoice.tenants?.company_name ?? "—"}</td>
                      <td className="text-xs">{formatDate(invoice.invoice_date)}</td>
                      <td className="text-xs">
                        {formatDate(invoice.due_date)}
                        {isOverdue ? (
                          <p style={{ color: "var(--danger)" }}>overdue</p>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">{money(invoice.total)}</td>
                      <td className="text-right tabular-nums">
                        {invoice.status === "cancelled" ? "—" : money(balance)}
                      </td>
                      <td>
                        <span className={STATUS_BADGE[invoice.status] ?? "badge"}>
                          {invoice.status.replace("_", " ")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No invoices match this filter.</EmptyState>
        )}
      </Card>
    </>
  );
}
