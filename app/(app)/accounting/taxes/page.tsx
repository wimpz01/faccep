import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import type { TaxRate } from "@/lib/tax";

import { updateTaxRates, updateVatRate } from "../actions";
import { VatRateForm, WithholdingRatesForm } from "./tax-forms";

export const metadata: Metadata = { title: "Tax settings" };

export default async function TaxSettingsPage() {
  const context = await requirePermission(MODULE.accountingTax, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.accountingTax, "edit");

  const supabase = await createClient();
  const [{ data: settings }, { data: rateRows }, { data: account }] =
    await Promise.all([
      supabase
        .from("accounting_settings")
        .select("vat_rate, creditable_wht_id")
        .eq("company_id", companyId)
        .maybeSingle<{ vat_rate: string; creditable_wht_id: string | null }>(),
      supabase
        .from("tax_rates")
        .select("*")
        .eq("company_id", companyId)
        .order("kind")
        .order("sort")
        .returns<TaxRate[]>(),
      supabase
        .from("chart_of_accounts")
        .select("code, name")
        .eq("company_id", companyId)
        .eq("code", "1450")
        .maybeSingle<{ code: string; name: string }>(),
    ]);

  const rates = rateRows ?? [];
  const supplier = rates.filter((row) => row.kind === "supplier_withholding");
  const tenant = rates.filter((row) => row.kind === "tenant_withholding");
  const vatRate = Number(settings?.vat_rate ?? 12);

  return (
    <>
      <PageHeader
        title="Tax settings"
        description="The rates this company bills and withholds at. Changing a rate moves the next document and never an old one."
        action={
          <Link href="/reports/tax" className="btn btn-secondary btn-sm">
            Tax report
          </Link>
        }
      />

      <div className="card mb-6">
        <div className="card-body">
          <p className="text-sm muted">
            Every invoice records the VAT rate it was billed at, and every
            supplier bill records the withholding it was computed with. Editing
            a rate here therefore never changes a document that has already
            been raised — last year&rsquo;s invoices keep last year&rsquo;s
            figures.
          </p>
        </div>
      </div>

      <div className="mb-6">
        <Card
          title="VAT"
          description="Charged on invoices for VATable tenants. 12% under the NIRC as amended."
        >
          {canEdit ? (
            <VatRateForm action={updateVatRate} rate={vatRate} />
          ) : (
            <p className="text-sm">
              <strong className="tabular-nums">{vatRate}%</strong>
              <span className="muted"> — editing needs Edit on tax settings.</span>
            </p>
          )}
        </Card>
      </div>

      <div className="mb-6">
        <Card
          title="What we withhold from suppliers"
          description="Expanded withholding tax kept back when a supplier's bill is paid, and remitted to the BIR on their behalf. We issue them form 2307."
        >
          {canEdit ? (
            <WithholdingRatesForm action={updateTaxRates} rates={supplier} />
          ) : (
            <ul className="text-sm">
              {supplier.map((row) => (
                <li key={row.id}>
                  {row.label} — <span className="tabular-nums">{row.rate}%</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mb-6">
        <Card
          title="What tenants withhold from us"
          description="Kept back by a tenant who is a withholding agent when they pay their rent, and remitted to the BIR for us. They issue us form 2307, and it is creditable against our income tax."
        >
          <p className="text-sm muted mb-3">
            The 5% on rent is RR 2-98 §2.57.2(A)(8), computed on the amount net
            of VAT: on a rent of ₱10,000 inclusive of {vatRate}% VAT the base is
            ₱
            {(10000 / (1 + vatRate / 100)).toLocaleString("en-PH", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
            , so the tenant withholds ₱
            {((10000 / (1 + vatRate / 100)) * 0.05).toLocaleString("en-PH", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            and pays the rest. Government tenants withhold the VAT as well,
            creditable rather than final since 1 January 2021.
          </p>
          {canEdit ? (
            <WithholdingRatesForm action={updateTaxRates} rates={tenant} />
          ) : (
            <ul className="text-sm">
              {tenant.map((row) => (
                <li key={row.id}>
                  {row.label} — <span className="tabular-nums">{row.rate}%</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs muted mt-3">
            These rates only suggest a figure when a payment is applied. What
            gets recorded is what the tenant actually withheld. Mark a tenant as
            withholding on their own record.
          </p>
        </Card>
      </div>

      <Card
        title="Where withheld tax is held"
        description="Tax a tenant withholds from us is not lost — it is paid to the BIR on our behalf and credited against our income tax, so it is carried as an asset."
      >
        {account ? (
          <p className="text-sm">
            <strong>
              {account.code} {account.name}
            </strong>
            {settings?.creditable_wht_id ? null : (
              <span style={{ color: "var(--danger)" }}>
                {" "}
                — not yet linked in the accounting settings, so a collection
                with tax withheld will be refused until it is.
              </span>
            )}
          </p>
        ) : (
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            No Creditable Withholding Tax account exists on this company&rsquo;s
            chart.
          </p>
        )}
      </Card>
    </>
  );
}
