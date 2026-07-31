import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createTenant } from "./actions";
import { TenantForm } from "./tenant-form";

export const metadata: Metadata = { title: "Tenants" };

type TenantRow = {
  id: string;
  company_name: string;
  contact_person: string | null;
  mobile_number: string | null;
  is_vatable: boolean;
  status: string;
  contracts: {
    id: string;
    status: string;
    end_date: string;
    monthly_rent: string;
  }[];
};

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-brand",
  prospect: "badge",
  ended: "badge",
  blacklisted: "badge",
};

export default async function TenantsPage() {
  const context = await requirePermission(MODULE.tenants, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.tenants, "edit");

  const supabase = await createClient();
  const { data: tenants } = await supabase
    .from("tenants")
    .select(
      "id, company_name, contact_person, mobile_number, is_vatable, status, contracts(id, status, end_date, monthly_rent)",
    )
    .eq("company_id", companyId)
    .order("company_name")
    .returns<TenantRow[]>();

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Tenant companies, their VAT status and their live contracts."
      />

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Add a tenant"
            description="You will land on the tenant profile, where you can raise their contract."
          >
            <TenantForm action={createTenant} submitLabel="Create tenant" />
          </Card>
        </div>
      ) : null}

      <Card
        title={`${tenants?.length ?? 0} tenant${tenants?.length === 1 ? "" : "s"}`}
        bodyClassName=""
      >
        {tenants && tenants.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Contact</th>
                  <th>VAT</th>
                  <th>Status</th>
                  <th className="text-right">Monthly rent</th>
                  <th>Contract ends</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => {
                  const active = (tenant.contracts ?? []).find(
                    (contract) => contract.status === "active",
                  );
                  return (
                    <tr key={tenant.id}>
                      <td>
                        <Link
                          href={`/tenants/${tenant.id}`}
                          className="font-semibold"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {tenant.company_name}
                        </Link>
                      </td>
                      <td className="text-xs">
                        {tenant.contact_person ?? "—"}
                        {tenant.mobile_number ? (
                          <p className="muted">{tenant.mobile_number}</p>
                        ) : null}
                      </td>
                      <td>
                        {tenant.is_vatable ? (
                          <span className="badge badge-brand">VATable</span>
                        ) : (
                          <span className="badge">Non-VAT</span>
                        )}
                      </td>
                      <td>
                        <span className={STATUS_BADGE[tenant.status] ?? "badge"}>
                          {tenant.status}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {active ? money(active.monthly_rent) : "—"}
                      </td>
                      <td className="text-xs">
                        {active ? formatDate(active.end_date) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No tenants yet
            {canEdit ? " — add the first one above." : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
