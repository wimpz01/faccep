import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { pendingApprovalFor } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  cancelDraftInvoice,
  createCreditMemo,
  releaseInvoice,
  requestInvoiceCancellation,
} from "../actions";
import { STATUS_BADGE } from "../constants";
import {
  CancelDraftForm,
  CancelRequestForm,
  CreditMemoForm,
  ReleaseForm,
} from "../invoice-forms";

export const metadata: Metadata = { title: "Invoice" };

type InvoiceDetail = {
  id: string;
  company_id: string;
  invoice_no: string;
  status: string;
  invoice_date: string;
  due_date: string;
  period_start: string | null;
  period_end: string | null;
  is_vatable: boolean;
  vat_rate: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  amount_paid: string;
  credited_amount: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  tenants: { id: string; company_name: string } | null;
  contracts: { id: string; contract_no: string } | null;
  invoice_lines: {
    id: string;
    line_kind: string;
    description: string;
    quantity: string;
    unit_price: string;
    amount: string;
    is_vatable: boolean;
    sort_order: number;
    utility_periods: {
      id: string;
      utility: string;
      period_start: string;
      period_end: string;
      locations: { code: string } | null;
    } | null;
  }[];
  credit_memos: {
    id: string;
    memo_no: string;
    memo_date: string;
    amount: string;
    reason: string;
  }[];
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.billingInvoices, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.billingInvoices, "edit");
  const canRelease = can(context.permissions, MODULE.billingInvoices, "approve");
  const canDelete = can(context.permissions, MODULE.billingInvoices, "delete");
  const canCredit = can(context.permissions, MODULE.billingCreditMemos, "edit");

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select(
      `*, tenants(id, company_name), contracts(id, contract_no),
       invoice_lines(id, line_kind, description, quantity, unit_price, amount, is_vatable, sort_order,
         utility_periods(id, utility, period_start, period_end, locations(code))),
       credit_memos(id, memo_no, memo_date, amount, reason)`,
    )
    .eq("id", id)
    .maybeSingle<InvoiceDetail>();

  if (!invoice || invoice.company_id !== companyId) notFound();

  const pendingCancel = await pendingApprovalFor("invoices", id, "cancel");

  const { data: applications } = await supabase
    .from("payment_applications")
    .select("amount, payments(payment_no, payment_date, status, payment_mode)")
    .eq("invoice_id", id)
    .returns<
      {
        amount: string;
        payments: {
          payment_no: string;
          payment_date: string;
          status: string;
          payment_mode: string;
        } | null;
      }[]
    >();

  const lines = [...(invoice.invoice_lines ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  );
  const balance =
    Number(invoice.total) -
    Number(invoice.amount_paid) -
    Number(invoice.credited_amount);
  const uncredited = Number(invoice.total) - Number(invoice.credited_amount);

  return (
    <>
      <PageHeader
        title={invoice.invoice_no}
        description={`${invoice.tenants?.company_name ?? "Unknown tenant"} · ${formatDate(invoice.invoice_date)} · due ${formatDate(invoice.due_date)}`}
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/billing/invoices" className="btn btn-secondary btn-sm">
              Back
            </Link>
            <Link
              href={`/billing/invoices/${invoice.id}/document`}
              className="btn btn-primary btn-sm"
            >
              Print / PDF
            </Link>
          </div>
        }
      />

      {invoice.status === "cancelled" ? (
        <div className="card mb-6">
          <div className="card-body">
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              <strong>Cancelled</strong> {formatDateTime(invoice.cancelled_at)} —{" "}
              {invoice.cancellation_reason}
            </p>
            <p className="text-xs muted mt-1">
              The record is kept; nothing was deleted.
            </p>
          </div>
        </div>
      ) : null}

      {pendingCancel ? (
        <div className="card mb-6">
          <div className="card-body">
            <p className="text-sm">
              <strong>Cancellation awaiting approval</strong> — {pendingCancel.reason}
            </p>
            <p className="text-xs muted mt-1">
              It takes effect only once someone with Approve on invoices signs it
              off in <Link href="/approvals" style={{ color: "var(--color-brand-600)" }}>Approvals</Link>.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span className={STATUS_BADGE[invoice.status] ?? "badge"}>
                {invoice.status.replace("_", " ")}
              </span>
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Total
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(invoice.total)}
            </p>
            <p className="text-xs muted">
              {invoice.is_vatable
                ? `incl. ${money(invoice.vat_amount)} VAT`
                : "non-VAT tenant"}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Paid / credited
            </p>
            <p className="text-lg font-bold mt-1 tabular-nums">
              {money(invoice.amount_paid)}
            </p>
            <p className="text-xs muted">
              credited {money(invoice.credited_amount)}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Balance
            </p>
            <p className="text-2xl font-bold mt-1 tabular-nums">
              {invoice.status === "cancelled" ? "—" : money(balance)}
            </p>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Card title="Lines" bodyClassName="">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Amount</th>
                  <th>VAT</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      <span className="badge mr-2">{line.line_kind}</span>
                      {line.description}
                      {line.utility_periods ? (
                        <p className="text-xs muted mt-0.5">
                          <Link href={`/billing/periods/${line.utility_periods.id}`}>
                            {line.utility_periods.locations?.code ?? "Location"}{" "}
                            {line.utility_periods.utility} period{" "}
                            {formatDate(line.utility_periods.period_start)} to{" "}
                            {formatDate(line.utility_periods.period_end)}
                          </Link>
                        </p>
                      ) : null}
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(line.quantity)}
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(line.unit_price).toFixed(4)}
                    </td>
                    <td className="text-right tabular-nums">{money(line.amount)}</td>
                    <td className="text-xs">{line.is_vatable ? "yes" : "—"}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="text-right font-semibold">
                    Subtotal
                  </td>
                  <td className="text-right tabular-nums font-semibold">
                    {money(invoice.subtotal)}
                  </td>
                  <td />
                </tr>
                {invoice.is_vatable ? (
                  <tr>
                    <td colSpan={3} className="text-right font-semibold">
                      VAT ({Number(invoice.vat_rate)}%)
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(invoice.vat_amount)}
                    </td>
                    <td />
                  </tr>
                ) : null}
                <tr>
                  <td colSpan={3} className="text-right font-bold">
                    Total
                  </td>
                  <td
                    className="text-right tabular-nums font-bold"
                    style={{ color: "var(--color-gold-500)" }}
                  >
                    {money(invoice.total)}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="mb-6">
        <Card title="Payments applied" bodyClassName="">
          {applications && applications.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Date</th>
                    <th>Mode</th>
                    <th className="text-right">Applied</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map((row, index) => (
                    <tr key={index}>
                      <td className="text-sm">{row.payments?.payment_no}</td>
                      <td className="text-xs">
                        {formatDate(row.payments?.payment_date)}
                      </td>
                      <td className="text-xs">{row.payments?.payment_mode}</td>
                      <td className="text-right tabular-nums">{money(row.amount)}</td>
                      <td>
                        <span className="badge">{row.payments?.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No payments applied yet.</EmptyState>
          )}
        </Card>
      </div>

      {invoice.credit_memos && invoice.credit_memos.length > 0 ? (
        <div className="mb-6">
          <Card title="Credit memos" bodyClassName="">
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Memo</th>
                    <th>Date</th>
                    <th className="text-right">Amount</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.credit_memos.map((memo) => (
                    <tr key={memo.id}>
                      <td className="text-sm">{memo.memo_no}</td>
                      <td className="text-xs">{formatDate(memo.memo_date)}</td>
                      <td className="text-right tabular-nums">{money(memo.amount)}</td>
                      <td className="text-sm">{memo.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {invoice.status === "draft" && canRelease ? (
        <div className="mb-6">
          <Card
            title="Release"
            description="Locks the invoice and makes it payable. Corrections after this need approval or a credit memo."
          >
            <ReleaseForm action={releaseInvoice} invoiceId={invoice.id} />
          </Card>
        </div>
      ) : null}

      {invoice.status !== "draft" && invoice.status !== "cancelled" && canEdit && !pendingCancel ? (
        <div className="mb-6">
          <Card
            title="Cancel this invoice"
            description="Requires approval before it takes effect. The record is preserved."
          >
            <CancelRequestForm
              action={requestInvoiceCancellation}
              invoiceId={invoice.id}
            />
          </Card>
        </div>
      ) : null}

      {invoice.status !== "draft" && invoice.status !== "cancelled" && canCredit && uncredited > 0 ? (
        <div className="mb-6">
          <Card
            title="Issue a credit memo"
            description="The alternative to cancelling: reduces what the tenant owes while leaving the invoice intact."
          >
            <CreditMemoForm
              action={createCreditMemo}
              invoiceId={invoice.id}
              maxAmount={uncredited}
            />
          </Card>
        </div>
      ) : null}

      {invoice.status === "draft" && canEdit ? (
        <Card
          title="Cancel this draft"
          description="For a draft that will not proceed. The invoice and its lines are kept with the reason recorded — nothing is deleted, and a cancelled draft no longer blocks a period close."
        >
          <CancelDraftForm action={cancelDraftInvoice} invoiceId={invoice.id} />
        </Card>
      ) : null}
    </>
  );
}
