"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { derivedRate, expenseShare, reconcile, round2, round3 } from "@/lib/billing";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

function Result({ state }: { state: ActionState }) {
  return (
    <>
      <FormError message={state.error} />
      {state.success ? (
        <p className="text-sm" style={{ color: "var(--success)" }}>
          {state.success}
        </p>
      ) : null}
    </>
  );
}

export type LocationOption = { id: string; name: string; code: string };

export function NewPeriodForm({
  action,
  locations,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  locations: LocationOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [utility, setUtility] = useState("electric");

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="location_id">
          Location *
        </label>
        <select id="location_id" name="location_id" className="select" required defaultValue="">
          <option value="">Choose…</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.code} — {location.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="utility">
          Utility *
        </label>
        <select
          id="utility"
          name="utility"
          className="select"
          value={utility}
          onChange={(event) => setUtility(event.currentTarget.value)}
        >
          <option value="electric">Electricity</option>
          <option value="water">Water</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="period_start">
            From *
          </label>
          <input
            id="period_start"
            name="period_start"
            type="date"
            className="input"
            required
            defaultValue={iso(firstOfMonth)}
          />
        </div>
        <div>
          <label className="label" htmlFor="period_end">
            To *
          </label>
          <input
            id="period_end"
            name="period_end"
            type="date"
            className="input"
            required
            defaultValue={iso(lastOfMonth)}
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="provider_amount">
          Provider bill total (₱)
        </label>
        <input
          id="provider_amount"
          name="provider_amount"
          type="number"
          step="0.01"
          min="0"
          className="input"
          defaultValue="0"
        />
      </div>

      <div>
        <label className="label" htmlFor="provider_consumption">
          Provider total {utility === "water" ? "cu.m" : "kWh"}
        </label>
        <input
          id="provider_consumption"
          name="provider_consumption"
          type="number"
          step="0.001"
          min="0"
          className="input"
          defaultValue="0"
        />
      </div>

      {/* Both utilities carry a building cost the per-unit rate does not
          recover, so this is one field under two names. */}
      <div>
        <label className="label" htmlFor="extra_expense">
          {utility === "water" ? "Water expense (₱)" : "Genset expense (₱)"}
        </label>
        <input
          id="extra_expense"
          name="extra_expense"
          type="number"
          step="0.01"
          min="0"
          className="input"
          defaultValue="0"
        />
        <p className="text-xs muted mt-1">
          {utility === "water"
            ? "Pumping, tanks and treatment; split by cubic metre consumption."
            : "Generator fuel and servicing; split by kWh consumption."}
        </p>
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Open period" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ProviderBillForm({
  action,
  period,
  tenantConsumption,
  isLocked,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  period: {
    id: string;
    utility: string;
    provider_amount: string;
    provider_consumption: string;
    manual_rate: number | null;
    extra_expense: string;
    notes: string | null;
  };
  tenantConsumption: number;
  isLocked: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [amount, setAmount] = useState(period.provider_amount);
  const [consumption, setConsumption] = useState(period.provider_consumption);
  // numeric columns come back as JSON numbers, and the input state is text.
  const [manual, setManual] = useState(
    period.manual_rate === null ? "" : String(period.manual_rate),
  );

  const derived = derivedRate(Number(amount), Number(consumption));
  /*
   * The rate tenants are actually charged. Charging the derived rate recovers
   * the provider's bill and not a peso more, so every unit the sub-meters
   * missed -- corridors, pumps, line loss -- is absorbed. A rate set here is
   * what recovers it.
   */
  const rate = manual.trim() === "" ? derived : Number(manual);
  const check = reconcile(Number(consumption), tenantConsumption);
  const unit = period.utility === "water" ? "cu.m" : "kWh";

  // What the sub-metered consumption is worth at the rate being charged, and
  // the gap against what the provider billed. Signed the same way as
  // reconcile(): negative is money the company absorbs, positive is money in.
  const recovered = round2(tenantConsumption * rate);
  const shortfall = round2(recovered - (Number(amount) || 0));

  // The rate that would leave nothing absorbed, offered rather than imposed.
  const breakEven =
    tenantConsumption > 0 ? (Number(amount) || 0) / tenantConsumption : 0;

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <input type="hidden" name="id" value={period.id} />

      <div>
        <label className="label" htmlFor="provider_amount">
          Provider bill total (₱)
        </label>
        <input
          id="provider_amount"
          name="provider_amount"
          type="number"
          step="0.01"
          min="0"
          className="input"
          disabled={isLocked}
          value={amount}
          onChange={(event) => setAmount(event.currentTarget.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="provider_consumption">
          Provider total {unit}
        </label>
        <input
          id="provider_consumption"
          name="provider_consumption"
          type="number"
          step="0.001"
          min="0"
          className="input"
          disabled={isLocked}
          value={consumption}
          onChange={(event) => setConsumption(event.currentTarget.value)}
        />
      </div>

      <div>
        <p className="label">Derived rate</p>
        <p
          className="text-lg font-bold tabular-nums"
          style={{
            color: manual.trim()
              ? "var(--text-muted)"
              : "var(--color-gold-500)",
            textDecoration: manual.trim() ? "line-through" : undefined,
          }}
        >
          {derived ? `₱${derived.toFixed(4)}` : "—"}
        </p>
        <p className="text-xs muted">
          per {unit}
          {breakEven > 0
            ? ` · ₱${breakEven.toFixed(4)} recovers the loss`
            : ""}
        </p>
      </div>

      {/* Leave it empty and the derived rate stands. Set it and that is what
          tenants are charged, which is how the unmetered use is recovered. */}
      <div>
        <label className="label" htmlFor="manual_rate">
          Rate charged (₱)
        </label>
        <input
          id="manual_rate"
          name="manual_rate"
          type="number"
          step="0.0001"
          min="0"
          className="input"
          disabled={isLocked}
          placeholder={derived ? derived.toFixed(4) : "0.0000"}
          value={manual}
          onChange={(event) => setManual(event.currentTarget.value)}
        />
        <p className="text-xs muted mt-1">
          {manual.trim() === ""
            ? "Empty — charging the derived rate."
            : `Overriding: tenants charged ₱${Number(manual).toFixed(4)} per ${unit}.`}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="extra_expense">
          {period.utility === "water"
            ? "Water expense (₱)"
            : "Genset expense (₱)"}
        </label>
        <input
          id="extra_expense"
          name="extra_expense"
          type="number"
          step="0.01"
          min="0"
          className="input"
          disabled={isLocked}
          defaultValue={period.extra_expense}
        />
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="notes">
          Notes
        </label>
        <input
          id="notes"
          name="notes"
          className="input"
          disabled={isLocked}
          defaultValue={period.notes ?? ""}
        />
      </div>

      <div className="sm:col-span-4">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Recovery</th>
                <th className="text-right">Consumption</th>
                <th className="text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-sm">
                  Billed by the provider
                  <p className="text-xs muted">What the building was charged.</p>
                </td>
                <td className="text-right tabular-nums">
                  {round3(check.providerConsumption)} {unit}
                </td>
                <td className="text-right tabular-nums">
                  {money(Number(amount) || 0)}
                </td>
              </tr>
              <tr>
                <td className="text-sm">
                  Recovered from tenants
                  <p className="text-xs muted">
                    Sum of the sub-meters at ₱{rate.toFixed(4)} per {unit}.
                  </p>
                </td>
                <td className="text-right tabular-nums">
                  {round3(check.tenantConsumptionTotal)} {unit}
                </td>
                <td className="text-right tabular-nums">
                  {money(recovered)}
                </td>
              </tr>
              <tr>
                <td className="font-semibold">
                  {shortfall <= 0 ? "Unrecovered — system loss and common areas" : "Over-recovered"}
                  <p className="text-xs muted">
                    {shortfall <= 0
                      ? "Absorbed by the company unless it is billed some other way."
                      : manual.trim() !== ""
                        ? "The rate set here recovers more than the provider billed."
                        : "Tenants were charged more than the provider billed. Check the readings."}
                  </p>
                </td>
                <td
                  className="text-right tabular-nums font-semibold"
                  style={{
                    color:
                      Math.abs(check.percentage) > 15 ? "var(--danger)" : undefined,
                  }}
                >
                  {round3(check.difference)} {unit}
                  <p className="text-xs muted">{check.percentage}%</p>
                </td>
                <td
                  className="text-right tabular-nums font-semibold"
                  style={{
                    color:
                      Math.abs(check.percentage) > 15 ? "var(--danger)" : undefined,
                  }}
                >
                  {money(shortfall)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {!isLocked ? (
        <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
          <Submit label="Save provider bill" />
          <Result state={state} />
        </div>
      ) : (
        <p className="sm:col-span-4 text-sm muted">
          Locked — invoices have been released from this period.
        </p>
      )}
    </form>
  );
}

export type ReadingRow = {
  unitId: string;
  unitCode: string;
  tenantName: string | null;
  previous: number;
  present: number | null;
};

export function ReadingGrid({
  action,
  periodId,
  utility,
  rows,
  rate,
  extraExpense,
  isLocked,
  canEdit,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  periodId: string;
  utility: string;
  rows: ReadingRow[];
  rate: number;
  extraExpense: number;
  isLocked: boolean;
  canEdit: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((row) => [row.unitId, row.present === null ? "" : String(row.present)]),
    ),
  );

  const unit = utility === "water" ? "cu.m" : "kWh";

  const computed = useMemo(() => {
    const perUnit = rows.map((row) => {
      const raw = values[row.unitId];
      const present = raw === "" || raw === undefined ? null : Number(raw);
      const consumption =
        present === null ? null : Math.max(0, present - row.previous);
      return { ...row, present, consumption };
    });
    const total = perUnit.reduce((sum, row) => sum + (row.consumption ?? 0), 0);
    return {
      perUnit: perUnit.map((row) => ({
        ...row,
        charge: row.consumption === null ? null : row.consumption * rate,
        // Both utilities carry one now, so the share is worked out from the
        // consumption alone rather than from which utility this is.
        share:
          row.consumption === null
            ? null
            : expenseShare(row.consumption, total, extraExpense),
      })),
      total,
    };
  }, [rows, values, rate, extraExpense]);

  return (
    <form action={formAction}>
      <input type="hidden" name="periodId" value={periodId} />

      <div className="flex items-end gap-3 flex-wrap mb-3">
        <div>
          <label className="label" htmlFor="reading_date">
            Reading date
          </label>
          <input
            id="reading_date"
            name="reading_date"
            type="date"
            className="input"
            disabled={isLocked || !canEdit}
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
        </div>
        <p className="text-xs muted pb-2">
          Leave a reading blank to skip that unit. Consumption and the peso
          charge are computed, never typed.
        </p>
      </div>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Tenant</th>
              <th className="text-right">Previous</th>
              <th className="text-right" style={{ minWidth: "8rem" }}>
                Present
              </th>
              <th className="text-right">Consumption</th>
              <th className="text-right">Charge</th>
              {extraExpense > 0 ? (
                <th className="text-right">
                  {utility === "water" ? "Water expense" : "Genset"} share
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {computed.perUnit.map((row) => (
              <tr key={row.unitId}>
                <td>
                  <span className="badge">{row.unitCode}</span>
                </td>
                <td className="text-xs">{row.tenantName ?? "—"}</td>
                <td className="text-right tabular-nums">
                  {row.previous}
                  <input
                    type="hidden"
                    name={`previous:${row.unitId}`}
                    value={row.previous}
                  />
                </td>
                <td className="text-right">
                  <input
                    name={`reading:${row.unitId}`}
                    type="number"
                    step="0.001"
                    min="0"
                    className="input tabular-nums"
                    style={{ textAlign: "right" }}
                    disabled={isLocked || !canEdit}
                    value={values[row.unitId] ?? ""}
                    onChange={(event) => {
                      // currentTarget is null by the time the updater runs,
                      // so take the value now.
                      const value = event.currentTarget.value;
                      setValues((current) => ({
                        ...current,
                        [row.unitId]: value,
                      }));
                    }}
                  />
                </td>
                <td className="text-right tabular-nums">
                  {row.consumption === null ? "—" : round3(row.consumption)}
                </td>
                <td className="text-right tabular-nums">
                  {row.charge === null ? "—" : money(row.charge)}
                </td>
                {extraExpense > 0 ? (
                  <td className="text-right tabular-nums">
                    {row.share === null ? "—" : money(row.share)}
                  </td>
                ) : null}
              </tr>
            ))}
            <tr>
              <td colSpan={4} className="font-semibold text-right">
                Total sub-metered
              </td>
              <td className="text-right tabular-nums font-semibold">
                {round3(computed.total)} {unit}
              </td>
              <td className="text-right tabular-nums font-semibold">
                {money(computed.total * rate)}
              </td>
              {extraExpense > 0 ? (
                <td className="text-right tabular-nums font-semibold">
                  {money(extraExpense)}
                </td>
              ) : null}
            </tr>
          </tbody>
        </table>
      </div>

      {canEdit && !isLocked ? (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <Submit label="Save readings" />
          <Result state={state} />
        </div>
      ) : null}
    </form>
  );
}
