import type { Metadata } from "next";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createVendor } from "../actions";
import { VendorForm } from "../purchasing-forms";

export const metadata: Metadata = { title: "Suppliers" };

type VendorRow = {
  id: string;
  name: string;
  tin: string | null;
  contact_person: string | null;
  contact_number: string | null;
  email: string | null;
  payment_terms: string | null;
  address: string | null;
};

export default async function VendorsPage() {
  const context = await requirePermission(MODULE.purchasingVendors, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.purchasingVendors, "edit");

  const supabase = await createClient();
  const { data: vendors } = await supabase
    .from("vendors")
    .select(
      "id, name, tin, contact_person, contact_number, email, payment_terms, address",
    )
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("name")
    .returns<VendorRow[]>();

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Who you buy from, their TIN for withholding tax, and their payment terms."
      />

      {canEdit ? (
        <div className="mb-6">
          <Card title="Add a supplier">
            <VendorForm action={createVendor} />
          </Card>
        </div>
      ) : null}

      <Card title="Suppliers" bodyClassName="">
        {vendors && vendors.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>TIN</th>
                  <th>Contact</th>
                  <th>Terms</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => (
                  <tr key={vendor.id}>
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
                    <td className="text-xs">{vendor.payment_terms ?? "—"}</td>
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
