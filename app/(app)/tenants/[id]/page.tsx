import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money, monthsUntil } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { deleteTenant, setTenantStatus, updateTenant } from "../actions";
import { TenantForm, TenantStatusForm } from "../tenant-form";

export const metadata: Metadata = { title: "Tenant" };

type ContractRow = {
  id: string;
  contract_no: string;
  status: string;
  start_date: string;
  end_date: string;
  monthly_rent: string;
  escalation_rate: string;
  contract_units: { units: { code: string } | null }[];
};

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-brand",
  draft: "badge",
  expired: "badge",
  terminated: "badge",
};

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.tenants, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.tenants, "edit");
  const canDelete = can(context.permissions, MODULE.tenants, "delete");
  const canSeeContracts = can(context.permissions, MODULE.contracts, "view");
  const canEditContracts = can(context.permissions, MODULE.contracts, "edit");

  const supabase = await createClient();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!tenant || tenant.company_id !== companyId) notFound();

  const { data: contracts } = canSeeContracts
    ? await supabase
        .from("contracts")
        .select(
          "id, contract_no, status, start_date, end_date, monthly_rent, escalation_rate, contract_units(units(code))",
        )
        .eq("tenant_id", id)
        .order("start_date", { ascending: false })
        .returns<ContractRow[]>()
    : { data: null };

  const hasContracts = (contracts?.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        title={tenant.company_name}
        description={tenant.address ?? undefined}
        action={
          <div className="flex gap-2">
            <Link href="/tenants" className="btn btn-secondary btn-sm">
              Back to tenants
            </Link>
            {canEditContracts && tenant.status !== "blacklisted" ? (
              <Link
                href={`/contracts/new?tenant=${tenant.id}`}
                className="btn btn-primary btn-sm"
              >
                New contract
              </Link>
            ) : null}
          </div>
        }
      />

      {tenant.status === "blacklisted" ? (
        <div className="card mb-6">
          <div className="card-body">
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              <strong>Blacklisted</strong>
              {tenant.blacklisted_at
                ? ` on ${formatDate(tenant.blacklisted_at)}`
                : ""}
              . {tenant.blacklist_reason}
            </p>
            <p className="text-xs muted mt-1">
              New contracts for this tenant are refused by the database until the
              status is changed.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mb-6">
        <Card title="Profile">
          {canEdit ? (
            <TenantForm
              action={updateTenant}
              tenant={tenant}
              submitLabel="Save profile"
            />
          ) : (
            <dl className="grid gap-3 sm:grid-cols-3 text-sm">
              <div>
                <dt className="label">Contact person</dt>
                <dd>{tenant.contact_person ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">Mobile</dt>
                <dd>{tenant.mobile_number ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">Email</dt>
                <dd className="break-all">{tenant.email ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">TIN</dt>
                <dd>{tenant.tin ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">VAT</dt>
                <dd>{tenant.is_vatable ? "VATable" : "Non-VAT"}</dd>
              </div>
              <div>
                <dt className="label">Status</dt>
                <dd>{tenant.status}</dd>
              </div>
            </dl>
          )}
        </Card>
      </div>

      {canSeeContracts ? (
        <div className="mb-6">
          <Card
            title="Contracts"
            description="Escalation applies annually to both rent and deposit."
            bodyClassName=""
          >
            {hasContracts ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Units</th>
                      <th>Term</th>
                      <th className="text-right">Monthly rent</th>
                      <th className="text-right">Escalation</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contracts!.map((contract) => {
                      const months = monthsUntil(contract.end_date);
                      const endingSoon =
                        contract.status === "active" &&
                        months !== null &&
                        months <= 6;
                      return (
                        <tr key={contract.id}>
                          <td>
                            <Link
                              href={`/contracts/${contract.id}`}
                              className="font-semibold"
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              {contract.contract_no}
                            </Link>
                          </td>
                          <td className="text-xs">
                            {(contract.contract_units ?? [])
                              .map((link) => link.units?.code)
                              .filter(Boolean)
                              .join(", ") || "—"}
                          </td>
                          <td className="text-xs">
                            {formatDate(contract.start_date)} –{" "}
                            {formatDate(contract.end_date)}
                            {endingSoon ? (
                              <p style={{ color: "var(--danger)" }}>
                                Ends in {months} month{months === 1 ? "" : "s"} —
                                send renewal notice
                              </p>
                            ) : null}
                          </td>
                          <td className="text-right tabular-nums">
                            {money(contract.monthly_rent)}
                          </td>
                          <td className="text-right tabular-nums">
                            {Number(contract.escalation_rate)}%
                          </td>
                          <td>
                            <span
                              className={STATUS_BADGE[contract.status] ?? "badge"}
                            >
                              {contract.status}
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
                No contracts for this tenant yet
                {canEditContracts && tenant.status !== "blacklisted"
                  ? " — use New contract above."
                  : "."}
              </EmptyState>
            )}
          </Card>
        </div>
      ) : null}

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Status"
            description="Blacklisting is for tenants who vacate without notice; belongings left behind are forfeited."
          >
            <TenantStatusForm
              action={setTenantStatus}
              tenantId={tenant.id}
              status={tenant.status}
            />
          </Card>
        </div>
      ) : null}

      {canDelete ? (
        <Card
          title="Delete this tenant"
          description={
            hasContracts
              ? "This tenant has contracts on file and cannot be deleted — the record is kept for audit."
              : "Permanent. Only possible while the tenant has no contracts."
          }
        >
          <form action={deleteTenant}>
            <input type="hidden" name="id" value={tenant.id} />
            <button
              type="submit"
              className="btn btn-danger"
              disabled={hasContracts}
            >
              Delete tenant
            </button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
