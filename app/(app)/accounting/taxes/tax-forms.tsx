"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import type { TaxRate } from "@/lib/tax";

import type { ActionState } from "../actions";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

/**
 * The VAT rate charged on new invoices.
 *
 * Changing it never touches an invoice already raised: each one stamps the
 * rate it was billed at onto itself and its lines, so last year's invoices
 * keep last year's VAT however often this is edited.
 */
export function VatRateForm({
  action,
  rate,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  rate: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="field" style={{ maxWidth: "10rem" }}>
          <span className="label">VAT rate</span>
          <div className="flex items-center gap-2">
            <input
              name="vat_rate"
              type="number"
              step="0.001"
              min="0"
              max="100"
              required
              defaultValue={rate}
              className="input tabular-nums"
              style={{ textAlign: "right" }}
            />
            <span className="text-sm muted">%</span>
          </div>
        </label>
        <Submit label="Save VAT rate" />
      </div>
      <FormError message={state.error} />
      {state.success ? (
        <p className="text-sm" style={{ color: "var(--success)" }}>
          {state.success}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The withholding rates, edited together.
 *
 * Saving writes every row at once because they are read as a set: a company
 * changing one rate usually got a circular that changed several.
 */
export function WithholdingRatesForm({
  action,
  rates,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  rates: TaxRate[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Rate</th>
              <th style={{ width: "7rem" }}>ATC</th>
              <th className="text-right" style={{ width: "8rem" }}>
                Percentage
              </th>
              <th style={{ width: "5rem" }}>In use</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((row) => (
              <tr key={row.id}>
                <td>
                  <span className="text-sm font-medium">{row.label}</span>
                  {row.note ? (
                    <span className="block text-xs muted">{row.note}</span>
                  ) : null}
                </td>
                <td className="text-xs tabular-nums">{row.atc ?? "—"}</td>
                <td>
                  <div className="flex items-center gap-1">
                    <input
                      name={`rate:${row.id}`}
                      type="number"
                      step="0.001"
                      min="0"
                      max="100"
                      required
                      defaultValue={row.rate}
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                    />
                    <span className="text-xs muted">%</span>
                  </div>
                </td>
                <td>
                  <input
                    type="checkbox"
                    name={`active:${row.id}`}
                    aria-label={`${row.label} in use`}
                    defaultChecked={row.is_active}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Save rates" />
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
