import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";

import { createContract } from "../actions";
import { ContractForm } from "../contract-form";
import { loadContractOptions } from "../data";

export const metadata: Metadata = { title: "New contract" };

export default async function NewContractPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
}) {
  const { tenant } = await searchParams;
  const context = await requirePermission(MODULE.contracts, "edit");
  const companyId = context.activeCompany!.companyId;

  const { tenants, units } = await loadContractOptions(companyId);

  const preselected = tenant && tenants.some((t) => t.id === tenant) ? tenant : undefined;

  return (
    <>
      <PageHeader
        title="New contract"
        description="Saves as a draft. Units are only committed once the contract is activated."
        action={
          <Link href="/contracts" className="btn btn-secondary btn-sm">
            Cancel
          </Link>
        }
      />

      <ContractForm
        action={createContract}
        tenants={tenants}
        units={units}
        submitLabel="Create draft contract"
        lockTenant={Boolean(preselected)}
        contract={{
          tenant_id: preselected,
          term_years: 1,
          rent_due_day: 5,
          penalty_rate: 2,
          escalation_rate: 0,
          advance_payment: 0,
          water_billing_type: "consumption",
          electric_billing_type: "consumption",
        }}
      />
    </>
  );
}
