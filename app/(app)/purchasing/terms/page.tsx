import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createPaymentTerm, setPaymentTermActive } from "../actions";
import { PaymentTermForm, TermActiveForm } from "./terms-forms";

export const metadata: Metadata = { title: "Payment terms" };

type TermRow = {
  id: string;
  name: string;
  days: number;
  is_active: boolean;
  vendors: { id: string }[];
};

export default async function PaymentTermsPage() {
  const context = await requirePermission(MODULE.purchasingVendors, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.purchasingVendors, "edit");

  const supabase = await createClient();
  const { data: terms } = await supabase
    .from("payment_terms")
    .select("id, name, days, is_active, vendors(id)")
    .eq("company_id", companyId)
    .order("sort_order")
    .order("name")
    .returns<TermRow[]>();

  const rows = terms ?? [];

  return (
    <>
      <PageHeader
        title="Payment terms"
        description="How long each supplier gives you to pay. Picked from this list on the supplier record."
        action={
          <Link href="/purchasing/vendors" className="btn btn-secondary btn-sm">
            Back to suppliers
          </Link>
        }
      />

      {canEdit ? (
        <div className="mb-6">
          <Card title="Add a term">
            <PaymentTermForm action={createPaymentTerm} />
          </Card>
        </div>
      ) : null}

      <Card
        title="Terms"
        description="Retiring a term hides it from new suppliers. Anyone already on it keeps it."
        bodyClassName=""
      >
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Term</th>
                  <th className="text-right">Days to pay</th>
                  <th className="text-right">Suppliers</th>
                  <th>Status</th>
                  {canEdit ? <th className="text-right">Move to</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((term) => (
                  <tr key={term.id}>
                    <td className="text-sm font-medium">{term.name}</td>
                    <td className="text-right tabular-nums">
                      {term.days === 0 ? "on delivery" : term.days}
                    </td>
                    <td className="text-right tabular-nums">
                      {(term.vendors ?? []).length}
                    </td>
                    <td>
                      <span
                        className={term.is_active ? "badge badge-brand" : "badge"}
                      >
                        {term.is_active ? "in use" : "retired"}
                      </span>
                    </td>
                    {canEdit ? (
                      <td className="text-right">
                        <TermActiveForm
                          action={setPaymentTermActive}
                          termId={term.id}
                          isActive={term.is_active}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No payment terms yet. Add the first one above.</EmptyState>
        )}
      </Card>
    </>
  );
}
