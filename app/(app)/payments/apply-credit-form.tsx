"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";

import type { ActionState } from "./actions";

export type OpenBill = {
  id: string;
  invoice_no: string;
  due_date: string;
  balance: number;
};

function Submit({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary btn-sm"
      disabled={pending || disabled}
    >
      {pending ? "Applying…" : label}
    </button>
  );
}

/**
 * Sets an unapplied credit against bills raised after it was taken.
 *
 * The amount per invoice is editable rather than all-or-nothing: a credit
 * rarely matches a bill exactly, and part-settling one is the ordinary case.
 * Nothing may be applied beyond what is left unapplied, which is checked here
 * and again on the server.
 */
export function ApplyCreditForm({
  action,
  paymentId,
  unapplied,
  invoices,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  paymentId: string;
  unapplied: number;
  invoices: OpenBill[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const total = round2(
    Object.values(amounts).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );
  const over = total > round2(unapplied);

  /** Fills the oldest bills first until the credit runs out. */
  function oldestFirst() {
    let left = unapplied;
    const next: Record<string, string> = {};
    for (const invoice of [...invoices].sort((a, b) =>
      a.due_date.localeCompare(b.due_date),
    )) {
      if (left <= 0) break;
      const take = Math.min(left, invoice.balance);
      next[invoice.id] = take.toFixed(2);
      left = round2(left - take);
    }
    setAmounts(next);
  }

  if (invoices.length === 0) {
    return (
      <p className="text-sm muted">
        This tenant has no open invoices to set the credit against. It stays on
        account until one is raised.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="payment_id" value={paymentId} />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={oldestFirst}
        >
          Apply oldest first
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setAmounts({})}
          disabled={total === 0}
        >
          Clear
        </button>
        <span className="text-xs muted">
          {money(unapplied)} unapplied
        </span>
      </div>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>Set</th>
              <th>Invoice</th>
              <th>Due</th>
              <th className="text-right">Balance</th>
              <th className="text-right" style={{ width: "10rem" }}>
                Amount applied
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const value = amounts[invoice.id] ?? "";
              const overBalance = Number(value) > invoice.balance;
              return (
                <tr key={invoice.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Set the credit against ${invoice.invoice_no}`}
                      checked={Number(value) > 0}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        setAmounts((current) => {
                          if (!on) {
                            const next = { ...current };
                            delete next[invoice.id];
                            return next;
                          }
                          const used = round2(
                            Object.entries(current)
                              .filter(([id]) => id !== invoice.id)
                              .reduce((sum, [, v]) => sum + (Number(v) || 0), 0),
                          );
                          const left = round2(unapplied - used);
                          const take = Math.min(
                            left > 0 ? left : 0,
                            invoice.balance,
                          );
                          return { ...current, [invoice.id]: take.toFixed(2) };
                        });
                      }}
                    />
                  </td>
                  <td className="text-sm">{invoice.invoice_no}</td>
                  <td className="text-xs">{formatDate(invoice.due_date)}</td>
                  <td className="text-right tabular-nums">
                    {money(invoice.balance)}
                  </td>
                  <td>
                    <input
                      name={`apply:${invoice.id}`}
                      type="number"
                      step="0.01"
                      min="0"
                      max={invoice.balance}
                      className="input tabular-nums"
                      style={{
                        textAlign: "right",
                        borderColor: overBalance ? "var(--danger)" : undefined,
                      }}
                      value={value}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setAmounts((current) => ({
                          ...current,
                          [invoice.id]: next,
                        }));
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit label={`Apply ${money(total)}`} disabled={total <= 0 || over} />
        {over ? (
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            That is {money(round2(total - unapplied))} more than is unapplied.
          </p>
        ) : null}
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
