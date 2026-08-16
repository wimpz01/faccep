import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { escalatedAmount, formatDate, money, monthsUntil } from "@/lib/format";
import { nextEscalation, rentForPeriod } from "@/lib/billing";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createContract, updateContract } from "@/app/(app)/contracts/actions";
import { ContractForm } from "@/app/(app)/contracts/contract-form";
import { FUND_STATUS } from "@/app/(app)/contracts/constants";
import { loadContractOptions } from "@/app/(app)/contracts/data";

import { deleteTenant, setTenantStatus, updateTenant } from "../actions";
import { TenantForm, TenantStatusForm } from "../tenant-form";

export const metadata: Metadata = { title: "Tenant" };

type ContractRow = {
  id: string;
  contract_no: string;
  status: string;
  start_date: string;
  end_date: string;
  term_years: number;
  monthly_rent: string;
  security_deposit: string;
  advance_payment: string;
  escalation_rate: string;
  rent_due_day: number;
  penalty_rate: string;
  water_billing_type: string;
  water_fixed_amount: string | null;
  water_minimum_amount: string | null;
  electric_billing_type: string;
  electric_fixed_amount: string | null;
  electric_minimum_amount: string | null;
  contract_units: {
    units: {
      id: string;
      code: string;
      area_sqm: string | null;
      monthly_rate: string;
      water_meter_serial: string | null;
      electric_meter_serial: string | null;
      locations: { code: string; name: string } | null;
    } | null;
  }[];
  contract_inclusions: {
    inclusion: string;
    label: string | null;
    amount: string | null;
    sort_order: number;
  }[];
};

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-brand",
  draft: "badge",
  expired: "badge",
  terminated: "badge",
};

const BILLING_TYPE_LABELS: Record<string, string> = {
  fixed: "Fixed amount",
  minimum_overage: "Minimum + overage",
  consumption: "Based on consumption",
};

const INCLUSION_LABELS: Record<string, string> = {
  rent: "Monthly rent",
  parking: "Parking",
  security_guard: "Security guard",
  water: "Water",
  electricity: "Electricity",
  other: "Other",
};

/** How a utility is charged, spelled out rather than left as an enum. */
function utilityLine(
  type: string,
  fixed: string | null,
  minimum: string | null,
) {
  if (type === "fixed") {
    return `${BILLING_TYPE_LABELS[type]} — ${money(fixed)} per month`;
  }
  if (type === "minimum_overage") {
    return `${BILLING_TYPE_LABELS[type]} — minimum ${money(minimum)}, then metered`;
  }
  return `${BILLING_TYPE_LABELS[type]} — sub-meter reading × the period's derived rate`;
}

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
          `id, contract_no, status, start_date, end_date, term_years,
           monthly_rent, security_deposit, advance_payment, escalation_rate,
           rent_due_day, penalty_rate,
           water_billing_type, water_fixed_amount, water_minimum_amount,
           electric_billing_type, electric_fixed_amount, electric_minimum_amount,
           contract_units(units(id, code, area_sqm, monthly_rate,
             water_meter_serial, electric_meter_serial, locations(code, name))),
           contract_inclusions(inclusion, label, amount, sort_order)`,
        )
        .eq("tenant_id", id)
        .order("start_date", { ascending: false })
        .returns<ContractRow[]>()
    : { data: null };

  const all = contracts ?? [];
  const hasContracts = all.length > 0;
  // The live agreement drives everything below; a draft stands in when there
  // is no active one yet, so a half-set-up tenant still shows its terms.
  const current =
    all.find((row) => row.status === "active") ??
    all.find((row) => row.status === "draft") ??
    null;

  /*
   * What the contract is actually worth today: the rent that applies now
   * rather than the one it opened at, and what is left of the money taken at
   * signing. The rent comes from the same function billing charges from, so
   * the figure here and the figure on the invoice cannot drift apart.
   */
  const today = new Date().toISOString().slice(0, 10);
  const currentRent = current
    ? rentForPeriod(
        Number(current.monthly_rent),
        Number(current.escalation_rate),
        current.start_date,
        today,
      )
    : null;
  const nextStep = current
    ? nextEscalation(
        Number(current.monthly_rent),
        Number(current.escalation_rate),
        current.start_date,
        current.end_date,
        today,
      )
    : null;

  const { data: funds } = current
    ? await supabase
        .from("contract_fund_status")
        .select(
          `deposit_taken, deposit_received, deposit_drawn, deposit_remaining, deposit_status,
           advance_taken, advance_drawn, advance_remaining, advance_status`,
        )
        .eq("contract_id", current.id)
        .maybeSingle<{
          deposit_taken: string;
          deposit_received: string;
          deposit_drawn: string;
          deposit_remaining: string;
          deposit_status: string;
          advance_taken: string;
          advance_drawn: string;
          advance_remaining: string;
          advance_status: string;
        }>()
    : { data: null };

  const units = (current?.contract_units ?? [])
    .map((link) => link.units)
    .filter((unit): unit is NonNullable<typeof unit> => Boolean(unit));

  const inclusions = [...(current?.contract_inclusions ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  // Options for the embedded set-up form. Units already on this contract stay
  // selectable even though they read as occupied.
  const { tenants: tenantOptions, units: unitOptions } = canEditContracts
    ? await loadContractOptions(
        companyId,
        units.map((unit) => unit.id),
      )
    : { tenants: [], units: [] };

  const schedule = current
    ? Array.from({ length: Math.min(current.term_years, 5) }, (_, index) => ({
        year: index + 1,
        rent: escalatedAmount(
          Number(current.monthly_rent),
          Number(current.escalation_rate),
          index,
        ),
        deposit: escalatedAmount(
          Number(current.security_deposit),
          Number(current.escalation_rate),
          index,
        ),
      }))
    : [];

  return (
    <>
      <PageHeader
        title={tenant.company_name}
        description={tenant.address ?? undefined}
        action={
          <div className="flex gap-2 flex-wrap">
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

      {/* The four questions asked most about a tenant, answered before any
          scrolling: what they are on, what they pay now, and what of their
          money we still hold. */}
      {current ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
          <StatTile
            label="Contract"
            value={current.contract_no}
            hint={`${formatDate(current.start_date)} → ${formatDate(current.end_date)} · ${current.status}`}
            href={`/contracts/${current.id}`}
          />
          <StatTile
            label="Current monthly rent"
            value={money(currentRent ?? 0)}
            tone="money"
            hint={
              Number(current.escalation_rate) > 0
                ? `From ${money(current.monthly_rent)} · ${Number(current.escalation_rate)}% a year${
                    nextStep
                      ? ` · next ${formatDate(nextStep.effectiveDate)}`
                      : " · no more rises"
                  }`
                : "No escalation on this contract"
            }
          />
          {/* The figure is what was receipted, less what has been drawn --
              not what the contract agreed. A deposit never collected shows
              zero held and says so. */}
          <StatTile
            label="Security deposit"
            value={money(funds?.deposit_remaining ?? 0)}
            hint={
              !funds
                ? "Held"
                : funds.deposit_status === "not_received"
                  ? `${money(funds.deposit_taken)} agreed — no receipt recorded`
                  : `${FUND_STATUS[funds.deposit_status] ?? funds.deposit_status}${
                      Number(funds.deposit_drawn) > 0
                        ? ` · ${money(funds.deposit_drawn)} of ${money(funds.deposit_received)} drawn`
                        : ` · ${money(funds.deposit_received)} received`
                    }`
            }
          />
          <StatTile
            label="Advance / prepayment"
            value={money(funds?.advance_remaining ?? current.advance_payment)}
            hint={
              funds
                ? `${FUND_STATUS[funds.advance_status] ?? funds.advance_status}${
                    Number(funds.advance_drawn) > 0
                      ? ` · ${money(funds.advance_drawn)} of ${money(funds.advance_taken)} used`
                      : ` · ${money(funds.advance_taken)} taken at signing`
                  }`
                : "Held"
            }
          />
        </div>
      ) : null}

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

      {/* ---- Everything the invoice run reads ------------------------------ */}
      {current ? (
        <div className="mb-6">
          <Card
            title={`Rental set-up — ${current.contract_no}`}
            description="These are the terms invoice generation reads each month."
            action={
              canSeeContracts ? (
                <Link
                  href={`/contracts/${current.id}`}
                  className="btn btn-secondary btn-sm"
                >
                  {canEditContracts ? "Edit terms" : "View contract"}
                </Link>
              ) : undefined
            }
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  <tr>
                    <th style={{ width: "16rem" }}>Status</th>
                    <td>
                      <span className={STATUS_BADGE[current.status] ?? "badge"}>
                        {current.status}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th>Location and units rented</th>
                    <td>
                      {units.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                          {units.map((unit) => (
                            <li key={unit.id} className="text-sm">
                              <span className="badge mr-2">{unit.code}</span>
                              {unit.locations?.name}
                              <span className="text-xs muted">
                                {unit.area_sqm
                                  ? ` · ${Number(unit.area_sqm)} sqm`
                                  : ""}
                                {" · listed "}
                                {money(unit.monthly_rate)}
                              </span>
                              <p className="text-xs muted">
                                Meters — water {unit.water_meter_serial ?? "—"},
                                electric {unit.electric_meter_serial ?? "—"}
                              </p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-sm" style={{ color: "var(--danger)" }}>
                          No units attached — nothing will bill.
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>Contract term</th>
                    <td className="text-sm">
                      {current.term_years} year
                      {current.term_years === 1 ? "" : "s"}
                    </td>
                  </tr>
                  <tr>
                    <th>Date started / end date</th>
                    <td className="text-sm">
                      {formatDate(current.start_date)} to{" "}
                      {formatDate(current.end_date)}
                      {(() => {
                        const months = monthsUntil(current.end_date);
                        return current.status === "active" &&
                          months !== null &&
                          months <= 6 ? (
                          <span style={{ color: "var(--danger)" }}>
                            {" — renewal notice due"}
                          </span>
                        ) : null;
                      })()}
                    </td>
                  </tr>
                  <tr>
                    <th>Monthly rental rate</th>
                    <td
                      className="tabular-nums font-semibold"
                      style={{ color: "var(--color-gold-500)" }}
                    >
                      {money(current.monthly_rent)}
                    </td>
                  </tr>
                  <tr>
                    <th>Security deposit</th>
                    <td className="tabular-nums">
                      {money(current.security_deposit)}
                    </td>
                  </tr>
                  <tr>
                    <th>Advance payment</th>
                    <td className="tabular-nums">
                      {money(current.advance_payment)}
                    </td>
                  </tr>
                  <tr>
                    <th>Escalation</th>
                    <td className="text-sm">
                      {Number(current.escalation_rate)}% a year
                      <span className="text-xs muted">
                        {" — applied to both rent and deposit"}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th>Rent due / late penalty</th>
                    <td className="text-sm">
                      Day {current.rent_due_day} of the month ·{" "}
                      {Number(current.penalty_rate)}% on unpaid utilities
                    </td>
                  </tr>
                  <tr>
                    <th>Taxable</th>
                    <td className="text-sm">
                      {tenant.is_vatable
                        ? "VATable — 12% VAT is added to invoices"
                        : "Non-VAT — no VAT on invoices"}
                    </td>
                  </tr>
                  <tr>
                    <th>Water billing</th>
                    <td className="text-sm">
                      {utilityLine(
                        current.water_billing_type,
                        current.water_fixed_amount,
                        current.water_minimum_amount,
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>Electricity billing</th>
                    <td className="text-sm">
                      {utilityLine(
                        current.electric_billing_type,
                        current.electric_fixed_amount,
                        current.electric_minimum_amount,
                      )}
                      <p className="text-xs muted">
                        Generator expense is shared out by kilowatt-hour usage.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <th>Billing inclusions</th>
                    <td>
                      {inclusions.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                          {inclusions.map((item, index) => (
                            <li key={index} className="text-sm">
                              {item.label ??
                                INCLUSION_LABELS[item.inclusion] ??
                                item.inclusion}
                              <span className="text-xs muted">
                                {item.amount
                                  ? ` — ${money(item.amount)}`
                                  : " — as metered or per the rate above"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-sm" style={{ color: "var(--danger)" }}>
                          Nothing ticked — the invoice would be empty.
                        </span>
                      )}
                      <p className="text-xs muted mt-1">
                        Only these appear on this tenant&apos;s invoice.
                      </p>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {schedule.length > 1 ? (
              <div className="table-scroll" style={{ borderTop: "1px solid var(--border)" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Contract year</th>
                      <th className="text-right">Monthly rent</th>
                      <th className="text-right">Security deposit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((row) => (
                      <tr key={row.year}>
                        <td className="text-sm">Year {row.year}</td>
                        <td className="text-right tabular-nums">
                          {money(row.rent)}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(row.deposit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>
        </div>
      ) : canSeeContracts ? (
        <div className="mb-6">
          <Card
            title="Rental set-up"
            description="No contract yet. Fill this in to set the rent, term, units, escalation, utility billing and inclusions — invoicing reads all of it."
          >
            {canEditContracts && tenant.status !== "blacklisted" ? (
              <ContractForm
                action={createContract}
                tenants={tenantOptions}
                units={unitOptions}
                submitLabel="Save rental set-up"
                lockTenant
                returnTo={`/tenants/${tenant.id}`}
                contract={{
                  tenant_id: tenant.id,
                  term_years: 1,
                  rent_due_day: 5,
                  penalty_rate: 2,
                  escalation_rate: 0,
                  advance_payment: 0,
                  water_billing_type: "consumption",
                  electric_billing_type: "consumption",
                }}
              />
            ) : (
              <EmptyState>
                No contract yet, so there are no rental terms to bill from.
              </EmptyState>
            )}
          </Card>
        </div>
      ) : null}

      {/* ---- Change the terms without leaving the tenant ------------------- */}
      {current && canEditContracts ? (
        <div className="mb-6">
          <details className="card">
            <summary className="card-header cursor-pointer">
              <div>
                <h2 className="font-semibold text-sm">
                  Change the rental set-up
                </h2>
                <p className="text-xs muted mt-0.5">
                  Escalation, utility billing, inclusions, units and dates — all
                  editable here.
                </p>
              </div>
              <span className="badge">{current.contract_no}</span>
            </summary>
            <div className="card-body">
              <ContractForm
                action={updateContract}
                tenants={tenantOptions}
                units={unitOptions}
                submitLabel="Save rental set-up"
                lockTenant
                returnTo={`/tenants/${tenant.id}`}
                contract={{
                  ...current,
                  tenant_id: tenant.id,
                  unitIds: units.map((unit) => unit.id),
                  inclusions,
                }}
              />
            </div>
          </details>
        </div>
      ) : null}

      <div className="mb-6">
        <Card
          title="Company details"
          description="Who the tenant is. These print on the contract and the invoice."
        >
          {canEdit ? (
            <TenantForm
              action={updateTenant}
              tenant={tenant}
              submitLabel="Save details"
            />
          ) : (
            <dl className="grid gap-3 sm:grid-cols-3 text-sm">
              <div>
                <dt className="label">Contact person / owner</dt>
                <dd>{tenant.contact_person ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">Mobile number</dt>
                <dd>{tenant.mobile_number ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">Company number</dt>
                <dd>{tenant.company_number ?? "—"}</dd>
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
                <dt className="label">Taxable</dt>
                <dd>{tenant.is_vatable ? "VATable" : "Non-VAT"}</dd>
              </div>
              <div className="sm:col-span-3">
                <dt className="label">Company address</dt>
                <dd>{tenant.address ?? "—"}</dd>
              </div>
            </dl>
          )}
        </Card>
      </div>

      {canSeeContracts ? (
        <div className="mb-6">
          <Card
            title="All contracts"
            description="A tenant can hold several over time; the live one drives billing."
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
                    {all.map((contract) => (
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
                        </td>
                        <td className="text-right tabular-nums">
                          {money(contract.monthly_rent)}
                        </td>
                        <td className="text-right tabular-nums">
                          {Number(contract.escalation_rate)}%
                        </td>
                        <td>
                          <span className={STATUS_BADGE[contract.status] ?? "badge"}>
                            {contract.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState>No contracts for this tenant yet.</EmptyState>
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
