import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { pendingApprovalFor } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { requestPaymentVoid } from "../actions";
import { VoidRequestForm } from "../payment-forms";

export const metadata: Metadata = { title: "Payment" };

type PaymentDetail = {
  id: string;
  company_id: string;
  payment_no: string;
  payment_kind: string;
  payment_mode: string;
  payment_date: string;
  amount: string;
  reference: string | null;
  notes: string | null;
  status: string;
  voided_at: string | null;
  void_reason: string | null;
  tenants: { id: string; company_name: string } | null;
  payment_applications: {
    amount: string;
    invoices: { id: string; invoice_no: string; due_date: string } | null;
  }[];
};

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.payments, "view");
  const companyId = context.activeCompany!.companyId;
  const canVoid = can(context.permissions, MODULE.payments, "void");
  // Asking is not voiding — a cashier who keyed the wrong amount can raise it.
  const canRequestVoid = can(context.permissions, MODULE.payments, "edit");

  const supabase = await createClient();
  const { data: payment } = await supabase
    .from("payments")
    .select(
      "*, tenants(id, company_name), payment_applications(amount, invoices(id, invoice_no, due_date))",
    )
    .eq("id", id)
    .maybeSingle<PaymentDetail>();

  if (!payment || payment.company_id !== companyId) notFound();

  const pendingVoid = await pendingApprovalFor("payments", id, "void");
  const applied = (payment.payment_applications ?? []).reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );

  return (
    <>
      <PageHeader
        title={payment.payment_no}
        description={`${payment.tenants?.company_name ?? "Unknown tenant"} · ${formatDate(payment.payment_date)}`}
        action={
          <div className="flex gap-2">
            {/* Money out gets a voucher for the payee to sign; money in
                already has its receipt. */}
            {payment.payment_kind === "refund" ? (
              <Link
                href={`/payments/${payment.id}/voucher`}
                className="btn btn-primary btn-sm"
              >
                Print voucher
              </Link>
            ) : null}
            <Link href="/payments" className="btn btn-secondary btn-sm">
              Back
            </Link>
          </div>
        }
      />

      {payment.status === "voided" ? (
        <div className="card mb-6">
          <div className="card-body">
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              <strong>Voided</strong> {formatDateTime(payment.voided_at)} —{" "}
              {payment.void_reason}
            </p>
            <p className="text-xs muted mt-1">
              The invoices it settled have been reopened automatically.
            </p>
          </div>
        </div>
      ) : null}

      {pendingVoid ? (
        <div className="card mb-6">
          <div className="card-body">
            <p className="text-sm">
              <strong>Void awaiting approval</strong> — {pendingVoid.reason}
            </p>
            <p className="text-xs muted mt-1">
              The payment stays posted until it is signed off in{" "}
              <Link href="/approvals" style={{ color: "var(--color-brand-600)" }}>
                Approvals
              </Link>
              .
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Amount
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(payment.amount)}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Applied
            </p>
            <p className="text-lg font-bold mt-1 tabular-nums">{money(applied)}</p>
            <p className="text-xs muted">
              unapplied {money(Number(payment.amount) - applied)}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Type / mode
            </p>
            <p className="text-sm font-medium mt-1">
              {payment.payment_kind} · {payment.payment_mode}
            </p>
            {payment.reference ? (
              <p className="text-xs muted">{payment.reference}</p>
            ) : null}
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span className="badge">{payment.status}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Card title="Applied to" bodyClassName="">
          {payment.payment_applications && payment.payment_applications.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Due</th>
                    <th className="text-right">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {payment.payment_applications.map((row, index) => (
                    <tr key={index}>
                      <td>
                        {row.invoices ? (
                          <Link
                            href={`/billing/invoices/${row.invoices.id}`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {row.invoices.invoice_no}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="text-xs">{formatDate(row.invoices?.due_date)}</td>
                      <td className="text-right tabular-nums">{money(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              {/* A refund settles no invoice by design; calling it an
                  unapplied credit describes a collection, not a payout. */}
              {payment.payment_kind === "refund"
                ? "Money paid out, so it settles no invoice. Print the voucher for the payee to sign."
                : "Not applied to any invoice — this sits as an unapplied credit."}
            </EmptyState>
          )}
        </Card>
      </div>

      {payment.status === "posted" && !pendingVoid ? (
        <Card
          title={canVoid ? "Void this payment" : "Request a void"}
          description={
            canRequestVoid
              ? "A payment cannot be edited or deleted — a wrong amount is corrected by voiding it and recording it again. The record is kept and its effect reversed."
              : "Correcting a payment needs Edit on payments."
          }
        >
          {canRequestVoid ? (
            <>
              <p className="text-sm muted mb-3">
                {canVoid
                  ? "Goes to Approvals for sign-off. The payment stays posted until then."
                  : "Sends the request to Approvals. The payment stays posted, and its invoices stay settled, until a manager signs it off."}
              </p>
              <VoidRequestForm action={requestPaymentVoid} paymentId={payment.id} />
            </>
          ) : (
            <p className="text-sm muted">
              Ask a manager. A payment cannot be edited or deleted — only voided
              with sign-off.
            </p>
          )}
        </Card>
      ) : null}
    </>
  );
}
