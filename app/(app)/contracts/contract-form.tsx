"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { defaultEndDate, escalatedAmount, money } from "@/lib/format";

import type { ActionState } from "./actions";
import { BILLING_TYPES, ESCALATION_RATES, INCLUSIONS } from "./constants";

export type UnitOption = {
  id: string;
  code: string;
  locationName: string;
  monthly_rate: string;
  status: string;
};

export type TenantOption = { id: string; company_name: string };

export type ContractValues = {
  id?: string;
  tenant_id?: string;
  contract_no?: string;
  start_date?: string;
  end_date?: string;
  term_years?: number;
  monthly_rent?: string | number;
  security_deposit?: string | number;
  advance_payment?: string | number;
  escalation_rate?: string | number;
  rent_due_day?: number;
  penalty_rate?: string | number;
  water_billing_type?: string;
  water_fixed_amount?: string | number | null;
  water_minimum_amount?: string | number | null;
  electric_billing_type?: string;
  electric_fixed_amount?: string | number | null;
  electric_minimum_amount?: string | number | null;
  repair_responsibility?: string | null;
  renewal_terms?: string | null;
  termination_grounds?: string | null;
  notes?: string | null;
  unitIds?: string[];
  inclusions?: { inclusion: string; label: string | null; amount: string | null }[];
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

function UtilityBlock({
  prefix,
  title,
  defaultType,
  defaultFixed,
  defaultMinimum,
}: {
  prefix: "water" | "electric";
  title: string;
  defaultType: string;
  defaultFixed: string;
  defaultMinimum: string;
}) {
  const [type, setType] = useState(defaultType);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor={`${prefix}_billing_type`}>
          {title} billing
        </label>
        <select
          id={`${prefix}_billing_type`}
          name={`${prefix}_billing_type`}
          className="select"
          value={type}
          onChange={(event) => setType(event.currentTarget.value)}
        >
          {BILLING_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`${prefix}_fixed_amount`}>
          Fixed amount (₱)
        </label>
        <input
          id={`${prefix}_fixed_amount`}
          name={`${prefix}_fixed_amount`}
          type="number"
          step="0.01"
          min="0"
          className="input"
          disabled={type !== "fixed"}
          required={type === "fixed"}
          defaultValue={defaultFixed}
        />
      </div>

      <div>
        <label className="label" htmlFor={`${prefix}_minimum_amount`}>
          Minimum charge (₱)
        </label>
        <input
          id={`${prefix}_minimum_amount`}
          name={`${prefix}_minimum_amount`}
          type="number"
          step="0.01"
          min="0"
          className="input"
          disabled={type !== "minimum_overage"}
          required={type === "minimum_overage"}
          defaultValue={defaultMinimum}
        />
      </div>
    </div>
  );
}

export function ContractForm({
  action,
  tenants,
  units,
  contract,
  submitLabel,
  lockTenant = false,
  returnTo,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tenants: TenantOption[];
  units: UnitOption[];
  contract?: ContractValues;
  submitLabel: string;
  lockTenant?: boolean;
  /** Where to land after saving. Lets the same form serve the tenant set-up. */
  returnTo?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  const [startDate, setStartDate] = useState(contract?.start_date ?? "");
  const [termYears, setTermYears] = useState(String(contract?.term_years ?? 1));
  const [endDate, setEndDate] = useState(contract?.end_date ?? "");
  const [rent, setRent] = useState(String(contract?.monthly_rent ?? ""));
  const [deposit, setDeposit] = useState(String(contract?.security_deposit ?? ""));
  const [escalation, setEscalation] = useState(
    String(Number(contract?.escalation_rate ?? 0)),
  );
  const [selectedUnits, setSelectedUnits] = useState<string[]>(
    contract?.unitIds ?? [],
  );

  // Recompute the end date whenever the start or term changes, unless the user
  // has typed one in themselves.
  function syncEndDate(nextStart: string, nextTerm: string) {
    const years = Number(nextTerm);
    if (nextStart && Number.isFinite(years) && years > 0) {
      setEndDate(defaultEndDate(nextStart, years));
    }
  }

  const inclusionDefaults = useMemo(() => {
    const map = new Map(
      (contract?.inclusions ?? []).map((item) => [
        item.inclusion === "other" ? "other" : item.inclusion,
        item,
      ]),
    );
    return map;
  }, [contract?.inclusions]);

  const grouped = useMemo(() => {
    const map = new Map<string, UnitOption[]>();
    for (const unit of units) {
      const list = map.get(unit.locationName) ?? [];
      list.push(unit);
      map.set(unit.locationName, list);
    }
    return [...map.entries()];
  }, [units]);

  const schedule = useMemo(() => {
    const years = Number(termYears);
    const baseRent = Number(rent);
    const baseDeposit = Number(deposit);
    const rate = Number(escalation);
    if (!Number.isFinite(years) || years < 1 || !Number.isFinite(baseRent)) {
      return [];
    }
    return Array.from({ length: Math.min(years, 10) }, (_, index) => ({
      year: index + 1,
      rent: escalatedAmount(baseRent, rate, index),
      deposit: escalatedAmount(baseDeposit || 0, rate, index),
    }));
  }, [termYears, rent, deposit, escalation]);

  const selectedTotal = units
    .filter((unit) => selectedUnits.includes(unit.id))
    .reduce((sum, unit) => sum + Number(unit.monthly_rate), 0);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {contract?.id ? <input type="hidden" name="id" value={contract.id} /> : null}
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}

      <section className="card">
        <div className="card-header">
          <h3 className="font-semibold text-sm">Parties and term</h3>
        </div>
        <div className="card-body grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="tenant_id">
              Tenant *
            </label>
            {lockTenant && contract?.tenant_id ? (
              <>
                <input type="hidden" name="tenant_id" value={contract.tenant_id} />
                <p className="text-sm font-medium pt-1.5">
                  {tenants.find((t) => t.id === contract.tenant_id)?.company_name ??
                    "Selected tenant"}
                </p>
              </>
            ) : (
              <select
                id="tenant_id"
                name="tenant_id"
                className="select"
                required
                defaultValue={contract?.tenant_id ?? ""}
              >
                <option value="">Choose a tenant…</option>
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.company_name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <p className="label">Contract number</p>
            {contract?.contract_no ? (
              <p className="text-sm font-semibold tabular-nums pt-2">
                {contract.contract_no}
              </p>
            ) : (
              <p className="text-sm muted pt-2">Issued on save.</p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="term_years">
              Term (years) *
            </label>
            <input
              id="term_years"
              name="term_years"
              type="number"
              min="1"
              max="30"
              className="input"
              required
              value={termYears}
              onChange={(event) => {
                setTermYears(event.currentTarget.value);
                syncEndDate(startDate, event.currentTarget.value);
              }}
            />
          </div>

          <div>
            <label className="label" htmlFor="start_date">
              Start date *
            </label>
            <input
              id="start_date"
              name="start_date"
              type="date"
              className="input"
              required
              value={startDate}
              onChange={(event) => {
                setStartDate(event.currentTarget.value);
                syncEndDate(event.currentTarget.value, termYears);
              }}
            />
          </div>

          <div>
            <label className="label" htmlFor="end_date">
              End date *
            </label>
            <input
              id="end_date"
              name="end_date"
              type="date"
              className="input"
              required
              value={endDate}
              onChange={(event) => setEndDate(event.currentTarget.value)}
            />
            <p className="text-xs muted mt-1">Filled from the term; editable.</p>
          </div>

          <div>
            <label className="label" htmlFor="rent_due_day">
              Rent due day *
            </label>
            <input
              id="rent_due_day"
              name="rent_due_day"
              type="number"
              min="1"
              max="28"
              className="input"
              required
              defaultValue={contract?.rent_due_day ?? 5}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h3 className="font-semibold text-sm">Units</h3>
          <span className="text-xs muted tabular-nums">
            {selectedUnits.length} selected · listed rate {money(selectedTotal)}
          </span>
        </div>
        <div className="card-body flex flex-col gap-4">
          {grouped.length === 0 ? (
            <p className="text-sm muted">
              No units available. Add units under Properties first.
            </p>
          ) : (
            grouped.map(([locationName, locationUnits]) => (
              <div key={locationName}>
                <p className="label">{locationName}</p>
                <div className="flex flex-wrap gap-2">
                  {locationUnits.map((unit) => {
                    const checked = selectedUnits.includes(unit.id);
                    return (
                      <label
                        key={unit.id}
                        className="badge"
                        style={{
                          cursor: "pointer",
                          padding: "0.4rem 0.6rem",
                          borderColor: checked
                            ? "var(--color-brand-500)"
                            : "var(--border)",
                          color: checked ? "var(--color-brand-600)" : undefined,
                        }}
                      >
                        <input
                          type="checkbox"
                          name="unit_ids"
                          value={unit.id}
                          checked={checked}
                          className="h-3.5 w-3.5 accent-[var(--color-brand-600)] mr-1"
                          onChange={(event) => {
                            // Read before the setter: React nulls
                            // currentTarget once the handler returns, and the
                            // updater runs later during batching.
                            const checked = event.currentTarget.checked;
                            setSelectedUnits((current) =>
                              checked
                                ? [...current, unit.id]
                                : current.filter((id) => id !== unit.id),
                            );
                          }}
                        />
                        {unit.code} · {money(unit.monthly_rate)}
                        {unit.status === "occupied" && !checked ? " (occupied)" : ""}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h3 className="font-semibold text-sm">Money</h3>
        </div>
        <div className="card-body grid gap-4 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="monthly_rent">
              Monthly rent (₱) *
            </label>
            <input
              id="monthly_rent"
              name="monthly_rent"
              type="number"
              step="0.01"
              min="0"
              className="input"
              required
              value={rent}
              onChange={(event) => setRent(event.currentTarget.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="security_deposit">
              Security deposit (₱) *
            </label>
            <input
              id="security_deposit"
              name="security_deposit"
              type="number"
              step="0.01"
              min="0"
              className="input"
              required
              value={deposit}
              onChange={(event) => setDeposit(event.currentTarget.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="advance_payment">
              Advance payment (₱) *
            </label>
            <input
              id="advance_payment"
              name="advance_payment"
              type="number"
              step="0.01"
              min="0"
              className="input"
              required
              defaultValue={String(contract?.advance_payment ?? 0)}
            />
          </div>

          <div>
            <label className="label" htmlFor="escalation_rate">
              Escalation *
            </label>
            <select
              id="escalation_rate"
              name="escalation_rate"
              className="select"
              value={escalation}
              onChange={(event) => setEscalation(event.currentTarget.value)}
            >
              {ESCALATION_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}%
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="penalty_rate">
              Late penalty (%) *
            </label>
            <input
              id="penalty_rate"
              name="penalty_rate"
              type="number"
              step="0.01"
              min="0"
              className="input"
              required
              defaultValue={String(contract?.penalty_rate ?? 2)}
            />
            <p className="text-xs muted mt-1">
              On water and electricity unpaid a week after billing.
            </p>
          </div>

          {schedule.length > 0 ? (
            <div className="sm:col-span-3">
              <p className="label">Escalation schedule</p>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th className="text-right">Monthly rent</th>
                      <th className="text-right">Security deposit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((row) => (
                      <tr key={row.year}>
                        <td>Year {row.year}</td>
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
            </div>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h3 className="font-semibold text-sm">Billing inclusions</h3>
          <span className="text-xs muted">
            Only ticked items appear on this tenant&apos;s invoice.
          </span>
        </div>
        <div className="card-body grid gap-3 sm:grid-cols-2">
          {INCLUSIONS.map((item) => {
            const existing = inclusionDefaults.get(item.value);
            return (
              <div key={item.value} className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm flex-1">
                  <input
                    type="checkbox"
                    name={`inclusion_${item.value}`}
                    defaultChecked={Boolean(existing)}
                    className="h-4 w-4 accent-[var(--color-brand-600)]"
                  />
                  {item.label}
                </label>
                <input
                  name={`inclusion_${item.value}_amount`}
                  type="number"
                  step="0.01"
                  min="0"
                  className="input"
                  style={{ maxWidth: "9rem" }}
                  placeholder="Amount"
                  defaultValue={existing?.amount ?? ""}
                />
              </div>
            );
          })}

          <div className="flex items-center gap-3 sm:col-span-2">
            <input
              name="inclusion_other_label"
              className="input flex-1"
              placeholder="Other inclusion (leave blank if none)"
              defaultValue={inclusionDefaults.get("other")?.label ?? ""}
            />
            <input
              name="inclusion_other_amount"
              type="number"
              step="0.01"
              min="0"
              className="input"
              style={{ maxWidth: "9rem" }}
              placeholder="Amount"
              defaultValue={inclusionDefaults.get("other")?.amount ?? ""}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h3 className="font-semibold text-sm">Utilities</h3>
        </div>
        <div className="card-body flex flex-col gap-4">
          <UtilityBlock
            prefix="water"
            title="Water"
            defaultType={contract?.water_billing_type ?? "consumption"}
            defaultFixed={
              contract?.water_fixed_amount != null
                ? String(contract.water_fixed_amount)
                : ""
            }
            defaultMinimum={
              contract?.water_minimum_amount != null
                ? String(contract.water_minimum_amount)
                : ""
            }
          />
          <UtilityBlock
            prefix="electric"
            title="Electricity"
            defaultType={contract?.electric_billing_type ?? "consumption"}
            defaultFixed={
              contract?.electric_fixed_amount != null
                ? String(contract.electric_fixed_amount)
                : ""
            }
            defaultMinimum={
              contract?.electric_minimum_amount != null
                ? String(contract.electric_minimum_amount)
                : ""
            }
          />
          <p className="text-xs muted">
            On <strong>consumption</strong>, the rate is not set here — it comes
            from the provider&rsquo;s actual bill each month. Enter that bill and
            the meter readings under{" "}
            <Link
              href="/billing/periods"
              style={{ color: "var(--color-brand-600)" }}
            >
              Billing → Utility periods
            </Link>
            , where the charge is distributed across the metered units and the
            unrecovered balance is shown.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h3 className="font-semibold text-sm">Terms</h3>
        </div>
        <div className="card-body grid gap-4">
          <div>
            <label className="label" htmlFor="repair_responsibility">
              Repair responsibility
            </label>
            <textarea
              id="repair_responsibility"
              name="repair_responsibility"
              className="textarea"
              rows={2}
              defaultValue={contract?.repair_responsibility ?? ""}
            />
          </div>
          <div>
            <label className="label" htmlFor="renewal_terms">
              Renewal terms
            </label>
            <textarea
              id="renewal_terms"
              name="renewal_terms"
              className="textarea"
              rows={2}
              defaultValue={contract?.renewal_terms ?? ""}
            />
          </div>
          <div>
            <label className="label" htmlFor="termination_grounds">
              Grounds for termination
            </label>
            <textarea
              id="termination_grounds"
              name="termination_grounds"
              className="textarea"
              rows={2}
              defaultValue={contract?.termination_grounds ?? ""}
            />
          </div>
          <div>
            <label className="label" htmlFor="notes">
              Internal notes
            </label>
            <textarea
              id="notes"
              name="notes"
              className="textarea"
              rows={2}
              defaultValue={contract?.notes ?? ""}
            />
          </div>
        </div>
      </section>

      <div
        className="sticky bottom-0 py-3 flex items-center gap-3 flex-wrap border-t"
        style={{ background: "var(--canvas)", borderColor: "var(--border)" }}
      >
        <Submit label={submitLabel} />
        <FormError message={state.error} />
        {state.success ? (
          <p className="text-sm" style={{ color: "var(--success)" }}>
            {state.success}
          </p>
        ) : null}
      </div>
    </form>
  );
}
