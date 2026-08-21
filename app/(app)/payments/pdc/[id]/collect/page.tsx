import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { suggestedWithholding, type TaxRate } from "@/lib/tax";

import { postChequeCollection } from "../../../actions";
import type { OpenInvoice } from "../../../payment-forms";
import { CollectChequeForm } from "./collect-form";

export const metadata: Metadata = { title: "Collect cheque" };

type ChequeDetail = {
  id: string;
  company_id: string;
  pdc_no: string;
  check_no: string;
  bank: string;
  amount: string;
  maturity_date: string;
  deposited_at: string | null;
  status: string;
  payment_id: string | null;
  tenant_id: string;
  tenants: { company_name: string } | null;
};

type InvoiceRow = {
  id: string;
  invoice_no: string;
  tenant_id: string;
  due_date: string;
  total: string;
  amount_paid: string;
  credited_amount: string;
  vatable_net: string;
  vat_amount: string;
};

export default async function CollectChequePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.payments, "edit");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const { data: cheque } = await supabase
    .from("postdated_checks")
    .select(
      `id, company_id, pdc_no, check_no, bank, amount, maturity_date, deposited_at,
       status, payment_id, tenant_id, tenants(company_name)`,
    )
    .eq("id", id)
    .maybeSingle<ChequeDetail>();

  if (!cheque || cheque.company_id !== companyId) notFound();

  const [{ data: invoiceRows }, { data: tenantRow }, { data: rateRows }] =
    await Promise.all([
      supabase
        .from("invoices")
        .select(
          "id, invoice_no, tenant_id, due_date, total, amount_paid, credited_amount, vatable_net, vat_amount",
        )
        .eq("company_id", companyId)
        .eq("tenant_id", cheque.tenant_id)
        .in("status", ["released", "partially_paid"])
        .order("due_date")
        .returns<InvoiceRow[]>(),
      supabase
        .from("tenants")
        .select("withholds_tax, is_government")
        .eq("id", cheque.tenant_id)
        .maybeSingle<{ withholds_tax: boolean; is_government: boolean }>(),
      supabase
        .from("tax_rates")
        .select("*")
        .eq("company_id", companyId)
        .returns<TaxRate[]>(),
    ]);

  const withholds = tenantRow?.withholds_tax ?? false;
  const isGovernment = tenantRow?.is_government ?? false;
  const rates = rateRows ?? [];

  const invoices: OpenInvoice[] = (invoiceRows ?? [])
    .map((invoice) => {
      const balance =
        Number(invoice.total) -
        Number(invoice.amount_paid) -
        Number(invoice.credited_amount);
      const suggestion = suggestedWithholding({
        vatableNet: Number(invoice.vatable_net),
        vatAmount: Number(invoice.vat_amount),
        withholds,
        isGovernment,
        rates,
      });
      return {
        id: invoice.id,
        invoice_no: invoice.invoice_no,
        tenant_id: invoice.tenant_id,
        due_date: invoice.due_date,
        balance,
        suggestedTax: Math.min(suggestion.tax, Math.max(balance, 0)),
        suggestedVat: Math.min(
          suggestion.vat,
          Math.max(balance - Math.min(suggestion.tax, balance), 0),
        ),
      };
    })
    .filter((invoice) => invoice.balance > 0);

  const alreadyCollected = Boolean(cheque.payment_id);
  const notCleared = cheque.status !== "cleared";

  return (
    <>
      <PageHeader
        title={`Collect ${cheque.pdc_no}`}
        description={`Cheque ${cheque.check_no} · ${cheque.bank} · ${cheque.tenants?.company_name ?? "—"}`}
        action={
          <Link href="/payments/pdc" className="btn btn-secondary btn-sm">
            Back to cheques
          </Link>
        }
      />

      <div className="mb-6">
        <Card title="The cheque">
          <dl className="grid gap-4 sm:grid-cols-4 text-sm">
            <div>
              <dt className="label">Amount</dt>
              <dd className="font-semibold tabular-nums">
                {money(cheque.amount)}
              </dd>
            </div>
            <div>
              <dt className="label">Cheque date</dt>
              <dd>{formatDate(cheque.maturity_date)}</dd>
            </div>
            <div>
              <dt className="label">Deposited</dt>
              <dd>
                {cheque.deposited_at ? formatDate(cheque.deposited_at) : "—"}
              </dd>
            </div>
            <div>
              <dt className="label">Status</dt>
              <dd>
                <span className="badge">{cheque.status}</span>
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      {alreadyCollected ? (
        <Card title="Already collected">
          <p className="text-sm">
            This cheque was posted as a collection.{" "}
            <Link
              href={`/payments/${cheque.payment_id}`}
              style={{ color: "var(--color-brand-600)" }}
            >
              Open the payment
            </Link>
            .
          </p>
        </Card>
      ) : notCleared ? (
        <Card title="Not cleared yet">
          <p className="text-sm">
            A cheque only becomes money once the bank has honoured it. Deposit it
            and mark it <strong>cleared</strong> in the register first — this is
            currently <strong>{cheque.status}</strong>.
          </p>
        </Card>
      ) : (
        <Card
          title="Apply the collection"
          description="The cheque has cleared. Attach the invoices it settles, then post it."
        >
          <CollectChequeForm
            action={postChequeCollection}
            chequeId={cheque.id}
            chequeAmount={Number(cheque.amount)}
            invoices={invoices}
          />
        </Card>
      )}
    </>
  );
}
