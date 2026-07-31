import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { recordPayment } from "./actions";
import { RecordPaymentForm, type OpenInvoice } from "./payment-forms";

export const metadata: Metadata = { title: "Payments" };

type PaymentRow = {
  id: string;
  payment_no: string;
  payment_kind: string;
  payment_mode: string;
  payment_date: string;
  amount: string;
  status: string;
  reference: string | null;
  tenants: { company_name: string } | null;
  payment_applications: { amount: string }[];
};

export default async function PaymentsPage() {
  const context = await requirePermission(MODULE.payments, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.payments, "edit");

  const supabase = await createClient();
  const [{ data: payments }, { data: tenants }, { data: invoices }] =
    await Promise.all([
      supabase
        .from("payments")
        .select(
          "id, payment_no, payment_kind, payment_mode, payment_date, amount, status, reference, tenants(company_name), payment_applications(amount)",
        )
        .eq("company_id", companyId)
        .order("payment_date", { ascending: false })
        .limit(200)
        .returns<PaymentRow[]>(),
      supabase
        .from("tenants")
        .select("id, company_name")
        .eq("company_id", companyId)
        .order("company_name"),
      supabase
        .from("invoices")
        .select("id, invoice_no, tenant_id, due_date, total, amount_paid, credited_amount")
        .eq("company_id", companyId)
        .in("status", ["released", "partially_paid"])
        .order("due_date"),
    ]);

  const openInvoices: OpenInvoice[] = (invoices ?? [])
    .map((invoice) => ({
      id: invoice.id,
      invoice_no: invoice.invoice_no,
      tenant_id: invoice.tenant_id,
      due_date: invoice.due_date,
      balance:
        Number(invoice.total) -
        Number(invoice.amount_paid) -
        Number(invoice.credited_amount),
    }))
    .filter((invoice) => invoice.balance > 0);

  const rows = payments ?? [];
  const posted = rows.filter((row) => row.status === "posted");
  const thisMonth = new Date().toISOString().slice(0, 7);
  const collectedThisMonth = posted
    .filter((row) => row.payment_date.startsWith(thisMonth))
    .reduce((sum, row) => sum + Number(row.amount), 0);

  return (
    <>
      <PageHeader
        title="Payments"
        description="Payments, prepayments and refunds. Once posted, a payment can only be reversed by an approved void."
        action={
          <Link href="/payments/pdc" className="btn btn-secondary btn-sm">
            Postdated cheques
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Collected this month"
          value={money(collectedThisMonth)}
          tone="money"
          hint="Posted payments"
        />
        <StatTile label="Open invoices" value={openInvoices.length} hint="With a balance" />
        <StatTile
          label="Unpaid total"
          value={money(openInvoices.reduce((sum, row) => sum + row.balance, 0))}
          hint="Across all tenants"
        />
        <StatTile
          label="Voided"
          value={rows.filter((row) => row.status === "voided").length}
          hint="Reversed with approval"
        />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Record a payment"
            description="Choose the tenant to see their open invoices, then apply the amount."
          >
            <RecordPaymentForm
              action={recordPayment}
              tenants={tenants ?? []}
              openInvoices={openInvoices}
            />
          </Card>
        </div>
      ) : null}

      <Card title="Recent payments" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Tenant</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Mode</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Applied</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((payment) => {
                  const applied = (payment.payment_applications ?? []).reduce(
                    (sum, row) => sum + Number(row.amount),
                    0,
                  );
                  return (
                    <tr key={payment.id}>
                      <td>
                        <Link
                          href={`/payments/${payment.id}`}
                          className="font-semibold"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {payment.payment_no}
                        </Link>
                        {payment.reference ? (
                          <p className="text-xs muted">{payment.reference}</p>
                        ) : null}
                      </td>
                      <td className="text-sm">{payment.tenants?.company_name ?? "—"}</td>
                      <td className="text-xs">{formatDate(payment.payment_date)}</td>
                      <td className="text-xs">{payment.payment_kind}</td>
                      <td className="text-xs">{payment.payment_mode}</td>
                      <td className="text-right tabular-nums">{money(payment.amount)}</td>
                      <td className="text-right tabular-nums">{money(applied)}</td>
                      <td>
                        <span
                          className="badge"
                          style={
                            payment.status === "voided"
                              ? { color: "var(--danger)" }
                              : undefined
                          }
                        >
                          {payment.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No payments recorded yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
