import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { supplierRateMap, type TaxRate } from "@/lib/tax";

import {
  createVendor,
  resendVendorApproval,
  updateVendorTaxDetails,
} from "../actions";
import { withholdingLabel } from "../constants";
import { VendorForm } from "../purchasing-forms";
import { VendorList } from "../vendor-list";

export const metadata: Metadata = { title: "Suppliers" };

type VendorRow = {
  id: string;
  vendor_no: string;
  name: string;
  status: string;
  tin: string | null;
  contact_person: string | null;
  contact_number: string | null;
  email: string | null;
  address: string | null;
  zip_code: string | null;
  atc_code: string | null;
  is_vatable: boolean;
  withholding: string;
  payment_terms: { name: string; days: number } | null;
};

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string }>;
}) {
  const { add } = await searchParams;
  const context = await requirePermission(MODULE.purchasingVendors, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.purchasingVendors, "edit");

  const supabase = await createClient();
  // Suppliers on hold stay listed -- their history and unpaid bills do not
  // disappear just because nothing new may be raised against them.
  const [
    { data: vendors },
    { data: openBills },
    { data: terms },
    { data: openRequests },
    { data: rateRows },
  ] = await Promise.all([
    supabase
      .from("vendors")
      .select(
        "id, vendor_no, name, status, tin, contact_person, contact_number, email, address, zip_code, atc_code, is_vatable, withholding, payment_terms(name, days)",
      )
      .eq("company_id", companyId)
      .order("status")
      .order("name")
      .returns<VendorRow[]>(),
    supabase
      .from("supplier_invoices")
      .select("vendor_id, total, amount_paid")
      .eq("company_id", companyId)
      .neq("status", "cancelled")
      .returns<{ vendor_id: string; total: string; amount_paid: string }[]>(),
    supabase
      .from("payment_terms")
      .select("id, name, days")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
    supabase
      .from("approval_requests")
      .select("entity_id")
      .eq("company_id", companyId)
      .eq("entity_table", "vendors")
      .eq("action", "approve")
      .eq("status", "pending"),
    // The rates in force, so a label never claims a percentage that has been
    // edited since this code was written.
    supabase
      .from("tax_rates")
      .select("*")
      .eq("company_id", companyId)
      .returns<TaxRate[]>(),
  ]);

  const withholdingRates = supplierRateMap(rateRows ?? []);

  // A pending supplier with nothing in the queue is stranded: unusable because
  // it is pending, unapprovable because there is nothing to decide.
  const queued = new Set(
    (openRequests ?? []).map((row) => row.entity_id as string),
  );

  // What is still owed each supplier, shown so a pending decision is made with
  // the exposure visible.
  const owing = new Map<string, number>();
  for (const bill of openBills ?? []) {
    const balance = Number(bill.total) - Number(bill.amount_paid);
    if (balance <= 0) continue;
    owing.set(bill.vendor_id, (owing.get(bill.vendor_id) ?? 0) + balance);
  }

  const pending = (vendors ?? []).filter((row) => row.status === "pending");
  const adding = canEdit && add === "1";

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who you buy from, their TIN for withholding tax, and their payment terms."
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/purchasing/terms" className="btn btn-secondary btn-sm">
              Payment terms
            </Link>
            {canEdit ? (
              adding ? (
                <Link
                  href="/purchasing/vendors"
                  className="btn btn-secondary btn-sm"
                >
                  Close
                </Link>
              ) : (
                <Link
                  href="/purchasing/vendors?add=1"
                  className="btn btn-primary btn-sm"
                >
                  + New supplier
                </Link>
              )
            ) : null}
          </div>
        }
      />

      {adding ? (
        <div className="mb-6">
          <Card title="Add a supplier">
            <VendorForm
              action={createVendor}
              terms={terms ?? []}
              withholdingRates={withholdingRates}
            />
          </Card>
        </div>
      ) : null}

      <VendorList
        rows={(vendors ?? []).map((vendor) => ({
          id: vendor.id,
          vendor_no: vendor.vendor_no,
          name: vendor.name,
          address: vendor.address,
          zip_code: vendor.zip_code,
          atc_code: vendor.atc_code,
          tin: vendor.tin,
          contact_person: vendor.contact_person,
          contact_number: vendor.contact_number,
          termsName: vendor.payment_terms?.name ?? null,
          termsDays: vendor.payment_terms?.days ?? null,
          is_vatable: vendor.is_vatable,
          withholdingLabel: withholdingLabel(vendor.withholding, withholdingRates),
          status: vendor.status,
          owed: owing.get(vendor.id) ?? 0,
          queued: queued.has(vendor.id),
        }))}
        canEdit={canEdit}
        pendingCount={pending.length}
        resendAction={resendVendorApproval}
        taxDetailsAction={updateVendorTaxDetails}
      />
    </>
  );
}
