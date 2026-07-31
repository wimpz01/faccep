import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money, monthsUntil } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { CONTRACT_STATUS_BADGE } from "./constants";

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

export default async function ContractsPage() {
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
        <StatTile label="Active" value={active.length} hint="Currently running" />
        <StatTile label="Drafts" value={drafts.length} hint="Not yet activated" />
        <StatTile
          label="Renewals due"
          value={renewalsDue.length}
          hint="Ending within 6 months"
        />
        <StatTile
          label="Contracted rent"
          value={money(contractedRent)}
          hint="Monthly, active contracts"
          tone="money"
        />
      </div>

      <Card title="All contracts" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Tenant</th>
                  <th>Units</th>
                  <th>Term</th>
                  <th className="text-right">Monthly rent</th>
                  <th className="text-right">Escalation</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const months = monthsUntil(row.end_date);
                  const endingSoon =
                    row.status === "active" && months !== null && months <= 6;
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link
                          href={`/contracts/${row.id}`}
                          className="font-semibold"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {row.contract_no}
                        </Link>
                      </td>
                      <td className="text-sm">{row.tenants?.company_name ?? "—"}</td>
                      <td className="text-xs">
                        {(row.contract_units ?? [])
                          .map((link) => link.units?.code)
                          .filter(Boolean)
                          .join(", ") || "—"}
                      </td>
                      <td className="text-xs">
                        {formatDate(row.start_date)} – {formatDate(row.end_date)}
                        {endingSoon ? (
                          <p style={{ color: "var(--danger)" }}>
                            Renewal notice due
                          </p>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(row.monthly_rent)}
                      </td>
                      <td className="text-right tabular-nums">
                        {Number(row.escalation_rate)}%
                      </td>
                      <td>
                        <span className={CONTRACT_STATUS_BADGE[row.status] ?? "badge"}>
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No contracts yet
            {canEdit ? " — create one from a tenant profile or above." : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
