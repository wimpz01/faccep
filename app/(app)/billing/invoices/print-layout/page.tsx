import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { readPrintSettings } from "@/lib/invoice-print";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  clearCompanyLogo,
  setCompanyLogo,
  updateInvoicePrintLayout,
} from "../actions";
import { PrintLayoutForm } from "./layout-form";

export const metadata: Metadata = { title: "Billing print layout" };

export default async function InvoicePrintLayoutPage() {
  const context = await requirePermission(MODULE.billingInvoices, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.billingInvoices, "edit");

  const supabase = await createClient();
  const [{ data: row }, { data: latest }, { data: company }] =
    await Promise.all([
      supabase
        .from("invoice_print_settings")
        .select("*")
        .eq("company_id", companyId)
        .maybeSingle(),
      // Something real to print, so the layout is judged on an actual billing
      // rather than on a specimen that never has awkward lines on it.
      supabase
        .from("invoices")
        .select("id")
        .eq("company_id", companyId)
        .neq("status", "draft")
        .order("invoice_date", { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string }>(),
      supabase
        .from("companies")
        .select("logo_path")
        .eq("id", companyId)
        .maybeSingle<{ logo_path: string | null }>(),
    ]);

  const settings = readPrintSettings(row);

  // Private bucket, so showing the current mark needs a short-lived URL.
  let logoUrl: string | null = null;
  if (company?.logo_path) {
    const { data: signed } = await supabase.storage
      .from("documents")
      .createSignedUrl(company.logo_path, 3600);
    logoUrl = signed?.signedUrl ?? null;
  }

  return (
    <>
      <PageHeader
        title="Billing print layout"
        description="The sheet a billing prints on, and what appears on it. Changes the paper only — no invoice is altered."
        action={
          <Link href="/billing/invoices" className="btn btn-secondary btn-sm">
            Back to invoices
          </Link>
        }
      />

      <Card>
        {canEdit ? (
          <PrintLayoutForm
            action={updateInvoicePrintLayout}
            settings={settings}
            previewHref={
              latest ? `/billing/invoices/${latest.id}/document` : null
            }
            companyId={companyId}
            logoUrl={logoUrl}
            onLogoSaved={setCompanyLogo}
            onLogoRemoved={clearCompanyLogo}
          />
        ) : (
          <p className="text-sm muted">
            Changing the print layout needs Edit on invoices.
          </p>
        )}
      </Card>
    </>
  );
}
