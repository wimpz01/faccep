import type { Metadata } from "next";
import Link from "next/link";

import { Card, FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money, monthsUntil } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { ContractList } from "./contract-list";

export const metadata: Metadata = { title: "Contracts" };

type ContractRow = {
  id: string;
  contract_no: string;
  status: string;
  start_date: string;
  end_date: string;
  monthly_rent: string;
  escalation_rate: string;
  tenants: { company_name: string } | null;
  contract_units: { units: { code: string } | null }[];
};

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const context = await requirePermission(MODULE.contracts, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.contracts, "edit");

  const supabase = await createClient();
  const { data: contracts } = await supabase
    .from("contracts")
    .select(
      "id, contract_no, status, start_date, end_date, monthly_rent, escalation_rate, tenants(company_name), contract_units(units(code))",
    )
    .eq("company_id", companyId)
    .order("start_date", { ascending: false })
    .returns<ContractRow[]>();

  const rows = contracts ?? [];
  const active = rows.filter((row) => row.status === "active");
  const drafts = rows.filter((row) => row.status === "draft");
  // Spec 3: alert six months before the end date so a renewal notice goes out.
  const renewalsDue = active.filter((row) => {
    const months = monthsUntil(row.end_date);
    return months !== null && months <= 6;
  });
  // Clicking a figure narrows the list below it to exactly what it counted.
  const shown =
    view === "active"
      ? active
      : view === "drafts"
        ? drafts
        : view === "renewals"
          ? renewalsDue
          : rows;
  const filterLabel =
    view === "active"
      ? "contracts currently running"
      : view === "drafts"
        ? "contracts not yet activated"
        : view === "renewals"
          ? "contracts ending within six months"
          : null;

  const contractedRent = active.reduce(
    (sum, row) => sum + Number(row.monthly_rent),
    0,
  );

  return (
    <>
      <PageHeader
        title="Contracts"
        description="Lease agreements, their terms and their renewal windows."
        action={
          canEdit ? (
            <Link href="/contracts/new" className="btn btn-primary btn-sm">
              New contract
            </Link>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Active"
          value={active.length}
          hint="Currently running"
          href="/contracts?view=active"
        />
        <StatTile
          label="Drafts"
          value={drafts.length}
          hint="Not yet activated"
          href="/contracts?view=drafts"
        />
        <StatTile
          label="Renewals due"
          value={renewalsDue.length}
          hint="Ending within 6 months"
          href="/contracts?view=renewals"
        />
        <StatTile
          label="Contracted rent"
          value={money(contractedRent)}
          hint="Monthly, active contracts"
          href="/contracts?view=active"
          tone="money"
        />
      </div>

      {filterLabel ? (
        <FilterNote label={filterLabel} count={shown.length} clearHref="/contracts" />
      ) : null}

      <Card title="All contracts" bodyClassName="">
        <ContractList
          rows={shown.map((row) => ({
            id: row.id,
            contract_no: row.contract_no,
            tenant: row.tenants?.company_name ?? "—",
            units:
              (row.contract_units ?? [])
                .map((link) => link.units?.code)
                .filter(Boolean)
                .join(", ") || "—",
            start_date: row.start_date,
            end_date: row.end_date,
            monthly_rent: row.monthly_rent,
            escalation_rate: row.escalation_rate,
            status: row.status,
          }))}
          emptyHint={
            canEdit
              ? "No contracts yet — create one from a tenant profile or above."
              : "No contracts yet."
          }
        />
      </Card>
    </>
  );
}
