import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createTenant } from "./actions";
import { TenantForm } from "./tenant-form";
import { TenantList } from "./tenant-list";

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

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string }>;
}) {
  const { add } = await searchParams;
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

  const all = tenants ?? [];
  const adding = canEdit && add === "1";

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Tenant companies, their VAT status and their live contracts."
        action={
          canEdit ? (
            adding ? (
              <Link href="/tenants" className="btn btn-secondary btn-sm">
                Close
              </Link>
            ) : (
              <Link href="/tenants?add=1" className="btn btn-primary btn-sm">
                + New tenant
              </Link>
            )
          ) : null
        }
      />

      {adding ? (
        <div className="mb-6">
          <Card
            title="Add a tenant"
            description="You will land on the tenant profile, where you can raise their contract."
          >
            <TenantForm action={createTenant} submitLabel="Create tenant" />
          </Card>
        </div>
      ) : null}

      <TenantList
        rows={all.map((tenant) => {
          const active = (tenant.contracts ?? []).find(
            (contract) => contract.status === "active",
          );
          return {
            id: tenant.id,
            company_name: tenant.company_name,
            contact_person: tenant.contact_person,
            mobile_number: tenant.mobile_number,
            is_vatable: tenant.is_vatable,
            status: tenant.status,
            monthly_rent: active ? Number(active.monthly_rent) : null,
            contract_ends: active ? active.end_date : null,
          };
        })}
      />
    </>
  );
}
