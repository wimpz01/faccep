"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";

export type EditableLine = {
  id: string;
  description: string;
  quantity: string;
  unit_price: string;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Saving…" : "Save prices"}
    </button>
  );
}

/**
 * Prices an order that has gone out before the supplier said what things cost.
 *
 * Shut until asked for, because most orders are priced when they are raised
 * and the list is read far more often than it is corrected. The running total
 * updates as figures are typed, so the order's worth is visible before it is
 * committed rather than after.
 */
export function OrderLineForm({
  action,
  orderId,
  lines,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  orderId: string;
  lines: EditableLine[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, { qty: string; price: string }>>(
    Object.fromEntries(
      lines.map((line) => [
        line.id,
        { qty: String(Number(line.quantity)), price: String(Number(line.unit_price)) },
      ]),
    ),
  );

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen(true)}
      >
        Edit quantities and prices
      </button>
    );
  }

  const total = round2(
    lines.reduce((sum, line) => {
      const row = draft[line.id];
      return sum + (Number(row?.qty) || 0) * (Number(row?.price) || 0);
    }, 0),
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="order_id" value={orderId} />

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right" style={{ width: "8rem" }}>
                Quantity
              </th>
              <th className="text-right" style={{ width: "10rem" }}>
                Unit price (₱)
              </th>
              <th className="text-right" style={{ width: "9rem" }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const row = draft[line.id] ?? { qty: "", price: "" };
              return (
                <tr key={line.id}>
                  <td className="text-sm">{line.description}</td>
                  <td>
                    <input
                      name={`line_qty:${line.id}`}
                      type="number"
                      step="0.001"
                      min="0.001"
                      required
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                      value={row.qty}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setDraft((current) => ({
                          ...current,
                          [line.id]: { ...current[line.id], qty: next },
                        }));
                      }}
                    />
                  </td>
                  <td>
                    <input
                      name={`line_price:${line.id}`}
                      type="number"
                      step="0.0001"
                      min="0"
                      required
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                      value={row.price}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setDraft((current) => ({
                          ...current,
                          [line.id]: { ...current[line.id], price: next },
                        }));
                      }}
                    />
                  </td>
                  <td className="text-right tabular-nums">
                    {money(
                      round2((Number(row.qty) || 0) * (Number(row.price) || 0)),
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3} className="text-right">
                Order total
              </th>
              <th className="text-right tabular-nums">{money(total)}</th>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <span className="text-xs muted">
          Only while nothing has been received.
        </span>
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
