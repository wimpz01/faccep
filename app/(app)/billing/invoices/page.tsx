import type { Metadata } from "next";
import Link from "next/link";

import {
  Card,
  EmptyState,
  FilterNote,
  PageHeader,
  StatTile,
} from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { generateInvoices, releaseInvoices } from "./actions";
import { STATUS_BADGE } from "./constants";
import { GenerateForm, InvoiceTable } from "./invoice-forms";

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
  searchParams: Promise<{ status?: string; view?: string }>;
}) {
  const { status, view } = await searchParams;
  const context = await requirePermission(MODULE.billingInvoices, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.billingInvoices, "edit");
  // Releasing posts to the ledger, so it is gated on approve, not edit.
  const canApprove = can(context.permissions, MODULE.billingInvoices, "approve");

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

  // Overdue is not a status, so it narrows the list here rather than in the
  // query the status buttons drive.
  const byView = view === "overdue" ? overdue : rows;


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
          href="/billing/invoices?status=released"
        />
        <StatTile
          label="Overdue"
          value={overdue.length}
          hint="Past the due date"
          href="/billing/invoices?view=overdue"
        />
        <StatTile
          label="Drafts"
          value={rows.filter((row) => row.status === "draft").length}
          hint="Not yet released"
          href="/billing/invoices?status=draft"
        />
        <StatTile
          label="Total shown"
          value={rows.length}
          hint="Most recent 200"
          href="/billing/invoices"
        />
      </div>

      {view === "overdue" ? (
        <FilterNote
          label="invoices past their due date"
          count={byView.length}
          clearHref="/billing/invoices"
        />
      ) : null}

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
        {byView.length > 0 ? (
          <InvoiceTable
            rows={byView.map((invoice) => ({
              id: invoice.id,
              invoice_no: invoice.invoice_no,
              tenant: invoice.tenants?.company_name ?? "—",
              invoice_date: invoice.invoice_date,
              due_date: invoice.due_date,
              total: Number(invoice.total),
              balance:
                Number(invoice.total) -
                Number(invoice.amount_paid) -
                Number(invoice.credited_amount),
              status: invoice.status,
              isOverdue:
                (invoice.status === "released" ||
                  invoice.status === "partially_paid") &&
                invoice.due_date < today,
            }))}
            action={releaseInvoices}
            canRelease={canApprove}
          />
        ) : (
          <EmptyState>No invoices match this filter.</EmptyState>
        )}
      </Card>
    </>
  );
}
