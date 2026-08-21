import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { pendingApprovalFor } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { suggestedWithholding, type TaxRate } from "@/lib/tax";

import { applyPrepayment, requestPaymentVoid, unapplyPayment } from "../actions";
import { ApplyCreditForm, type OpenBill } from "../apply-credit-form";
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
    id: string;
    amount: string;
    tax_withheld: string;
    vat_withheld: string;
    form_2307_no: string | null;
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
      "*, tenants(id, company_name), payment_applications(id, amount, tax_withheld, vat_withheld, form_2307_no, invoices(id, invoice_no, due_date))",
    )
    .eq("id", id)
    .maybeSingle<PaymentDetail>();

  if (!payment || payment.company_id !== companyId) notFound();

  const pendingVoid = await pendingApprovalFor("payments", id, "void");
  const applied = (payment.payment_applications ?? []).reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );

  const unapplied = Math.round((Number(payment.amount) - applied) * 100) / 100;

  // Taking an application back off a live payment; a voided one is already
  // reversed and must not be touched again.
  const canUnapply =
    can(context.permissions, MODULE.payments, "edit") &&
    payment.status !== "voided";

  /*
   * A credit can only be placed while it is unapplied, the payment stands, and
   * it is money held on account. A deposit belongs to a contract and a refund
   * is money out; neither settles a bill, and the database refuses both.
   */
  const canApply =
    can(context.permissions, MODULE.payments, "edit") &&
    payment.status !== "voided" &&
    payment.payment_kind !== "deposit" &&
    payment.payment_kind !== "refund" &&
    unapplied > 0;

  /*
   * The tenant's withholding habit and the company's rates, so the form can
   * offer a figure. Loaded only when the form is shown.
   */
  const [{ data: billRows }, { data: tenantRow }, { data: rateRows }] = canApply
    ? await Promise.all([
        supabase
          .from("invoices")
          .select(
            "id, invoice_no, due_date, total, amount_paid, credited_amount, vatable_net, vat_amount",
          )
          .eq("company_id", companyId)
          .eq("tenant_id", payment.tenants?.id ?? "")
          .in("status", ["released", "partially_paid"])
          .order("due_date")
          .returns<
            {
              id: string;
              invoice_no: string;
              due_date: string;
              total: string;
              amount_paid: string;
              credited_amount: string;
              vatable_net: string;
              vat_amount: string;
            }[]
          >(),
        supabase
          .from("tenants")
          .select("withholds_tax, is_government")
          .eq("id", payment.tenants?.id ?? "")
          .maybeSingle<{ withholds_tax: boolean; is_government: boolean }>(),
        supabase
          .from("tax_rates")
          .select("*")
          .eq("company_id", companyId)
          .returns<TaxRate[]>(),
      ])
    : [{ data: null }, { data: null }, { data: null }];

  const withholds = tenantRow?.withholds_tax ?? false;
  const isGovernment = tenantRow?.is_government ?? false;
  const rates = rateRows ?? [];

  const openBills: OpenBill[] = (billRows ?? [])
    .map((row) => {
      const balance =
        Number(row.total) - Number(row.amount_paid) - Number(row.credited_amount);
      const suggestion = suggestedWithholding({
        vatableNet: Number(row.vatable_net),
        vatAmount: Number(row.vat_amount),
        withholds,
        isGovernment,
        rates,
      });
      return {
        id: row.id,
        invoice_no: row.invoice_no,
        due_date: row.due_date,
        balance,
        // Never offer to withhold more than is left owing on the bill.
        suggestedTax: Math.min(suggestion.tax, Math.max(balance, 0)),
        suggestedVat: Math.min(
          suggestion.vat,
          Math.max(balance - Math.min(suggestion.tax, balance), 0),
        ),
      };
    })
    .filter((row) => row.balance > 0);

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

      {canApply ? (
        <div className="mb-6">
          <Card
            title="Apply this credit"
            description="Set what is left of this payment against the tenant's open invoices. The credit moves from their account to the bill."
          >
            <ApplyCreditForm
              action={applyPrepayment}
              paymentId={payment.id}
              unapplied={unapplied}
              invoices={openBills}
              tenantWithholds={withholds}
              tenantIsGovernment={isGovernment}
            />
          </Card>
        </div>
      ) : null}

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
                    <th className="text-right">Tax withheld</th>
                    {canUnapply ? <th /> : null}
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
                      <td className="text-right tabular-nums">
                        {/* Withheld tax settles the invoice without any cash
                            arriving, so it is shown apart from what was paid. */}
                        {Number(row.tax_withheld) + Number(row.vat_withheld) > 0 ? (
                          <>
                            {money(
                              Number(row.tax_withheld) + Number(row.vat_withheld),
                            )}
                            {row.form_2307_no ? (
                              <span className="block text-xs muted">
                                2307 {row.form_2307_no}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      {canUnapply ? (
                        <td className="text-right">
                          {/* Removing it reverses the posting, so the credit
                              returns to the tenant's account. */}
                          <form action={unapplyPayment}>
                            <input type="hidden" name="id" value={row.id} />
                            <input
                              type="hidden"
                              name="payment_id"
                              value={payment.id}
                            />
                            <button
                              type="submit"
                              className="btn btn-secondary btn-sm"
                            >
                              Unapply
                            </button>
                          </form>
                        </td>
                      ) : null}
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
