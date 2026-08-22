"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { money } from "@/lib/format";

import type { ActionState } from "./house-actions";

export type HouseMeterRow = {
  id: string;
  label: string;
  serial: string | null;
  direction: "consumption" | "supply";
  previous: number;
  present: number | null;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

function round3(value: number) {
  return Math.round(value * 1000) / 1000;
}

/**
 * The building's own meters over a period, and what they do to the balance.
 *
 * Shown beside the tenant readings rather than mixed into them: these are not
 * charged to anybody, and a row in the tenant grid that bills nothing would be
 * read as a mistake.
 *
 * The figures update as the readings are typed, because the reason for
 * entering them is to see where the provider's units went -- waiting for a
 * save to find out would make it a chore rather than an answer.
 */
export function HouseMeterGrid({
  action,
  addAction,
  periodId,
  utility,
  meters,
  providerConsumption,
  tenantConsumption,
  rate,
  isLocked,
  canEdit,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  addAction: (state: ActionState, formData: FormData) => Promise<ActionState>;
  periodId: string;
  utility: string;
  meters: HouseMeterRow[];
  providerConsumption: number;
  tenantConsumption: number;
  rate: number;
  isLocked: boolean;
  canEdit: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [addState, addFormAction] = useActionState<ActionState, FormData>(
    addAction,
    {},
  );
  const [adding, setAdding] = useState(false);
  /*
   * Both readings are held, not only the present one. Leaving previous to
   * the DOM meant the running totals were worked out from the figure that
   * came off the server rather than the one on screen, so correcting a
   * previous reading changed nothing until the page was reloaded -- and the
   * balance quietly disagreed with the boxes above it.
   */
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      meters.map((row) => [
        row.id,
        row.present === null ? "" : String(row.present),
      ]),
    ),
  );
  const [previous, setPrevious] = useState<Record<string, string>>(() =>
    Object.fromEntries(meters.map((row) => [row.id, String(row.previous)])),
  );

  const unit = utility === "water" ? "cu.m" : "kWh";

  const totals = useMemo(() => {
    let building = 0;
    let supply = 0;
    const rows = meters.map((meter) => {
      const raw = values[meter.id];
      const present = raw === "" || raw === undefined ? null : Number(raw);
      const before = Number(previous[meter.id] ?? meter.previous) || 0;
      const consumption =
        present === null ? null : Math.max(0, present - before);
      if (consumption !== null) {
        if (meter.direction === "supply") supply += consumption;
        else building += consumption;
      }
      return { ...meter, present, consumption };
    });
    return {
      rows,
      building: round3(building),
      supply: round3(supply),
      // What the provider gave plus what came in from elsewhere, against
      // everything measured. The remainder is loss, not a plug.
      loss: round3(
        providerConsumption + supply - tenantConsumption - building,
      ),
    };
  }, [meters, values, previous, providerConsumption, tenantConsumption]);

  const supplied = round3(providerConsumption + totals.supply);
  const lossPct =
    supplied > 0 ? Math.round((totals.loss / supplied) * 1000) / 10 : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* The balance first: it is the reason for the screen, and it reads
          before the detail rather than after it. */}
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Where the {unit} went</th>
              <th className="text-right">{unit}</th>
              <th className="text-right">At {money(rate)} / {unit}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="text-sm">Provider billed</td>
              <td className="text-right tabular-nums">{providerConsumption}</td>
              <td className="text-right tabular-nums muted">
                {money(providerConsumption * rate)}
              </td>
            </tr>
            {totals.supply > 0 ? (
              <tr>
                <td className="text-sm">
                  Supplied here
                  <span className="block text-xs muted">
                    Solar and anything else the provider did not bill
                  </span>
                </td>
                <td className="text-right tabular-nums">{totals.supply}</td>
                <td className="text-right tabular-nums muted">
                  {money(totals.supply * rate)}
                </td>
              </tr>
            ) : null}
            <tr style={{ fontWeight: 600 }}>
              <td className="text-sm">Total available</td>
              <td className="text-right tabular-nums">{supplied}</td>
              <td className="text-right tabular-nums">{money(supplied * rate)}</td>
            </tr>
            <tr>
              <td className="text-sm">Tenant sub-meters</td>
              <td className="text-right tabular-nums">{round3(tenantConsumption)}</td>
              <td className="text-right tabular-nums muted">
                {money(tenantConsumption * rate)}
              </td>
            </tr>
            <tr>
              <td className="text-sm">
                Building meters
                <span className="block text-xs muted">
                  Pump, lights and the rest — not charged to any tenant
                </span>
              </td>
              <td className="text-right tabular-nums">{totals.building}</td>
              <td className="text-right tabular-nums">
                {money(totals.building * rate)}
              </td>
            </tr>
            <tr
              style={{
                fontWeight: 600,
                color:
                  Math.abs(lossPct) > 10 ? "var(--danger)" : undefined,
              }}
            >
              <td className="text-sm">
                Unaccounted for
                <span className="block text-xs muted">
                  What no meter explains — line loss, or a meter not yet read
                </span>
              </td>
              <td className="text-right tabular-nums">
                {totals.loss} <span className="text-xs">({lossPct}%)</span>
              </td>
              <td className="text-right tabular-nums">
                {money(totals.loss * rate)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs muted">
        The building&rsquo;s own usage and whatever is unaccounted for are the two
        things no tenant is billed for. Their value at the rate above is what
        would have to be recovered to break even — set the rate on the provider
        bill to whatever you decide.
      </p>

      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="periodId" value={periodId} />

        {meters.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Building meter</th>
                  <th className="text-right" style={{ width: "9rem" }}>
                    Previous
                  </th>
                  <th className="text-right" style={{ width: "9rem" }}>
                    Present
                  </th>
                  <th className="text-right">Used</th>
                </tr>
              </thead>
              <tbody>
                {totals.rows.map((meter) => (
                  <tr key={meter.id}>
                    <td className="text-sm">
                      {meter.label}
                      <span className="block text-xs muted">
                        {meter.direction === "supply" ? "Supplies" : "Draws"}
                        {meter.serial ? ` · ${meter.serial}` : ""}
                      </span>
                    </td>
                    <td>
                      <input
                        name={`previous:${meter.id}`}
                        type="number"
                        step="0.001"
                        min="0"
                        className="input tabular-nums"
                        style={{ textAlign: "right" }}
                        value={previous[meter.id] ?? ""}
                        disabled={isLocked || !canEdit}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          setPrevious((current) => ({
                            ...current,
                            [meter.id]: next,
                          }));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        name={`present:${meter.id}`}
                        type="number"
                        step="0.001"
                        min="0"
                        className="input tabular-nums"
                        style={{ textAlign: "right" }}
                        value={values[meter.id] ?? ""}
                        disabled={isLocked || !canEdit}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          setValues((current) => ({
                            ...current,
                            [meter.id]: next,
                          }));
                        }}
                      />
                    </td>
                    <td className="text-right tabular-nums text-sm">
                      {meter.consumption === null ? (
                        <span className="muted">not read</span>
                      ) : (
                        `${meter.consumption} ${unit}`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm muted">
            No building meters recorded for this property yet. Add the pump, the
            hallway lights, the solar — whatever is metered but belongs to no
            tenant.
          </p>
        )}

        {canEdit && !isLocked ? (
          <div className="flex items-center gap-3 flex-wrap">
            {meters.length > 0 ? <Submit label="Save readings" /> : null}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setAdding((open) => !open)}
            >
              {adding ? "Close" : "+ Add a meter"}
            </button>
            <FormError message={state.error} />
            {state.success ? (
              <p className="text-sm" style={{ color: "var(--success)" }}>
                {state.success}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>

      {/*
        * Its own form, not a section of the one above: adding a meter and
        * saving readings are different acts, and nesting one form inside
        * another is not allowed in any case.
        */}
      {adding && canEdit && !isLocked ? (
        <form
          action={addFormAction}
          className="grid gap-3 sm:grid-cols-4 items-end"
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: "1rem",
          }}
        >
          <input type="hidden" name="periodId" value={periodId} />
          <label className="field">
            <span className="label">Meter name *</span>
            <input
              name="label"
              className="input"
              required
              placeholder="Hallway lights"
            />
          </label>
          <label className="field">
            <span className="label">Serial</span>
            <input name="serial" className="input" placeholder="Optional" />
          </label>
          <label className="field">
            <span className="label">This meter</span>
            <select name="direction" className="select" defaultValue="consumption">
              <option value="consumption">Draws — the building uses it</option>
              <option value="supply">Supplies — solar, or similar</option>
            </select>
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <Submit label="Add meter" />
          </div>
          <div className="sm:col-span-4">
            <FormError message={addState.error} />
            {addState.success ? (
              <p className="text-sm" style={{ color: "var(--success)" }}>
                {addState.success}
              </p>
            ) : null}
            <p className="text-xs muted mt-1">
              Belongs to the property, so once added it appears on every{" "}
              {utility === "water" ? "water" : "electricity"} period here.
            </p>
          </div>
        </form>
      ) : null}
    </div>
  );
}
