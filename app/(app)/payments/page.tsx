import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { recordPayment } from "./actions";
import { RecordPaymentForm, type OpenInvoice } from "./payment-forms";
import { applyContractFund } from "@/app/(app)/contracts/actions";
import { FundApplicationForm } from "@/app/(app)/contracts/fund-form";

import { PaymentList } from "./payment-list";

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

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string; fund?: string }>;
}) {
  const { add, fund } = await searchParams;
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
  const adding = canEdit && add === "1";
  const applyingFund = canEdit && fund === "1";

  /*
   * Contracts with money still held against them. Loaded only when the form
   * is open, since most visits to this page are about ordinary payments.
   */
  const { data: fundRows } = applyingFund
    ? await supabase
        .from("contract_fund_status")
        .select(
          `contract_id, deposit_remaining, advance_remaining,
           contracts(contract_no, status, tenants(company_name))`,
        )
        .eq("company_id", companyId)
        .returns<
          {
            contract_id: string;
            deposit_remaining: string;
            advance_remaining: string;
            contracts: {
              contract_no: string;
              status: string;
              tenants: { company_name: string } | null;
            } | null;
          }[]
        >()
    : { data: null };

  const fundContracts = (fundRows ?? [])
    .filter(
      (row) =>
        row.contracts?.status === "active" &&
        (Number(row.deposit_remaining) > 0 || Number(row.advance_remaining) > 0),
    )
    .map((row) => ({
      id: row.contract_id,
      contract_no: row.contracts?.contract_no ?? "",
      tenant: row.contracts?.tenants?.company_name ?? "Unknown tenant",
      depositRemaining: Number(row.deposit_remaining),
      advanceRemaining: Number(row.advance_remaining),
    }))
    .sort((a, b) => a.tenant.localeCompare(b.tenant));
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
          <div className="flex gap-2 flex-wrap">
            <Link href="/payments/pdc" className="btn btn-secondary btn-sm">
              Postdated cheques
            </Link>
            {canEdit ? (
              applyingFund ? (
                <Link href="/payments" className="btn btn-secondary btn-sm">
                  Close
                </Link>
              ) : (
                <Link href="/payments?fund=1" className="btn btn-secondary btn-sm">
                  Apply advance / deposit
                </Link>
              )
            ) : null}
            {canEdit ? (
              adding ? (
                <Link href="/payments" className="btn btn-secondary btn-sm">
                  Close
                </Link>
              ) : (
                <Link href="/payments?add=1" className="btn btn-primary btn-sm">
                  + Record payment
                </Link>
              )
            ) : null}
          </div>
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

      {applyingFund ? (
        <div className="mb-6">
          <Card
            title="Apply an advance or deposit"
            description="Money already held against a contract, set against a bill, refunded or forfeited. The contract keeps saying what was taken at signing."
          >
            <FundApplicationForm
              action={applyContractFund}
              contracts={fundContracts}
            />
          </Card>
        </div>
      ) : null}

      {adding ? (
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

      <PaymentList
        rows={rows.map((payment) => ({
          id: payment.id,
          payment_no: payment.payment_no,
          reference: payment.reference,
          tenant: payment.tenants?.company_name ?? "—",
          payment_date: payment.payment_date,
          payment_kind: payment.payment_kind,
          payment_mode: payment.payment_mode,
          amount: Number(payment.amount),
          applied: (payment.payment_applications ?? []).reduce(
            (sum, row) => sum + Number(row.amount),
            0,
          ),
          status: payment.status,
        }))}
      />
    </>
  );
}
