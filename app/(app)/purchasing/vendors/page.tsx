import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createVendor, resendVendorApproval } from "../actions";
import { withholdingLabel } from "../constants";
import { ResendApprovalForm, VendorForm } from "../purchasing-forms";

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
  is_vatable: boolean;
  withholding: string;
  payment_terms: { name: string; days: number } | null;
};

export default async function VendorsPage() {
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
  ] = await Promise.all([
    supabase
      .from("vendors")
      .select(
        "id, vendor_no, name, status, tin, contact_person, contact_number, email, address, is_vatable, withholding, payment_terms(name, days)",
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
  ]);

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

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who you buy from, their TIN for withholding tax, and their payment terms."
        action={
          <Link href="/purchasing/terms" className="btn btn-secondary btn-sm">
            Payment terms
          </Link>
        }
      />

      {canEdit ? (
        <div className="mb-6">
          <Card title="Add a supplier">
            <VendorForm action={createVendor} terms={terms ?? []} />
          </Card>
        </div>
      ) : null}

      <Card
        title="Suppliers"
        description={
          pending.length > 0
            ? `${pending.length} awaiting approval — they cannot be ordered from or billed until signed off.`
            : "A code is issued on save. A new supplier is unusable until somebody with Approve signs them off."
        }
        bodyClassName=""
      >
        {vendors && vendors.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Supplier</th>
                  <th>TIN</th>
                  <th>Contact</th>
                  <th>Terms</th>
                  <th>Tax</th>
                  <th>Status</th>
                  {canEdit ? <th className="text-right">Move to</th> : null}
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => (
                  <tr key={vendor.id}>
                    <td>
                      <span className="font-semibold text-sm tabular-nums">
                        {vendor.vendor_no}
                      </span>
                    </td>
                    <td>
                      <span className="font-medium text-sm">{vendor.name}</span>
                      {vendor.address ? (
                        <p className="text-xs muted">{vendor.address}</p>
                      ) : null}
                    </td>
                    <td className="text-xs">{vendor.tin ?? "—"}</td>
                    <td className="text-xs">
                      {vendor.contact_person ?? "—"}
                      {vendor.contact_number ? (
                        <p className="muted">{vendor.contact_number}</p>
                      ) : null}
                    </td>
                    <td className="text-xs">
                      {vendor.payment_terms ? (
                        <>
                          {vendor.payment_terms.name}
                          <p className="muted">
                            {vendor.payment_terms.days === 0
                              ? "on delivery"
                              : `${vendor.payment_terms.days} days`}
                          </p>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-xs">
                      {vendor.is_vatable ? (
                        <>
                          <span className="badge">VAT</span>
                          <p className="muted mt-0.5">
                            {withholdingLabel(vendor.withholding)}
                          </p>
                        </>
                      ) : (
                        <span className="muted">non-VAT</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          vendor.status === "approved"
                            ? "badge badge-brand"
                            : "badge"
                        }
                        style={
                          vendor.status === "rejected"
                            ? { color: "var(--danger)" }
                            : undefined
                        }
                      >
                        {vendor.status === "pending"
                          ? "awaiting approval"
                          : vendor.status}
                      </span>
                      {owing.has(vendor.id) ? (
                        <p className="text-xs muted mt-0.5">
                          owed {money(owing.get(vendor.id) ?? 0)}
                        </p>
                      ) : null}
                    </td>
                    {canEdit ? (
                      <td className="text-right text-xs muted">
                        {vendor.status === "pending" ? (
                          queued.has(vendor.id) ? (
                            <Link
                              href="/approvals"
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              In the approvals queue
                            </Link>
                          ) : (
                            <ResendApprovalForm
                              action={resendVendorApproval}
                              vendorId={vendor.id}
                            />
                          )
                        ) : vendor.status === "rejected" ? (
                          "Declined — kept for the record"
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No suppliers recorded yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
