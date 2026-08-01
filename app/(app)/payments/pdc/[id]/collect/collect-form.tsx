"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { money } from "@/lib/format";

import type { ActionState } from "../../../actions";
import type { OpenInvoice } from "../../../payment-forms";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Posting…" : "Post collection"}
    </button>
  );
}

export function CollectChequeForm({
  action,
  chequeId,
  chequeAmount,
  invoices,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  chequeId: string;
  chequeAmount: number;
  invoices: OpenInvoice[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [applied, setApplied] = useState<Record<string, string>>({});

  const appliedTotal = round2(
    Object.values(applied).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );
  const unapplied = round2(chequeAmount - appliedTotal);
  const overApplied = appliedTotal > chequeAmount;

  function toggle(invoice: OpenInvoice, checked: boolean) {
    setApplied((current) => {
      if (!checked) {
        const next = { ...current };
        delete next[invoice.id];
        return next;
      }
      const alreadyApplied = round2(
        Object.entries(current)
          .filter(([id]) => id !== invoice.id)
          .reduce((sum, [, value]) => sum + (Number(value) || 0), 0),
      );
      const remaining = round2(chequeAmount - alreadyApplied);
      const take = Math.max(0, Math.min(remaining, invoice.balance));
      return { ...current, [invoice.id]: take.toFixed(2) };
    });
  }

  /** Oldest first, until the cheque runs out. */
  function applyOldestFirst() {
    let remaining = chequeAmount;
    const next: Record<string, string> = {};
    for (const invoice of [...invoices].sort((a, b) =>
      a.due_date.localeCompare(b.due_date),
    )) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, invoice.balance);
      next[invoice.id] = take.toFixed(2);
      remaining = round2(remaining - take);
    }
    setApplied(next);
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="cheque_id" value={chequeId} />

      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <p className="label" style={{ marginBottom: 0 }}>
          Attach invoices — tick the ones this cheque settles
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={applyOldestFirst}
            disabled={invoices.length === 0}
          >
            Apply oldest first
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setApplied({})}
            disabled={Object.keys(applied).length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      {invoices.length === 0 ? (
        <p className="empty-state">
          This tenant has no open invoices. Generate or release one first.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "5rem" }}>Attach</th>
                <th>Invoice</th>
                <th>Due</th>
                <th className="text-right">Balance</th>
                <th className="text-right" style={{ width: "11rem" }}>
                  Amount applied
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => {
                const value = applied[invoice.id] ?? "";
                const isOn = invoice.id in applied;
                const overBalance = Number(value) > invoice.balance;
                return (
                  <tr key={invoice.id}>
                    <td>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-brand-600)]"
                        checked={isOn}
                        onChange={(event) => {
                          // currentTarget is null by the time the updater
                          // runs, so take the value now.
                          const checked = event.currentTarget.checked;
                          toggle(invoice, checked);
                        }}
                      />
                    </td>
                    <td className="text-sm">{invoice.invoice_no}</td>
                    <td className="text-xs muted">{invoice.due_date}</td>
                    <td className="text-right tabular-nums">
                      {money(invoice.balance)}
                    </td>
                    <td className="text-right">
                      {isOn ? (
                        <>
                          <input
                            name={`apply:${invoice.id}`}
                            type="number"
                            step="0.01"
                            min="0"
                            className="input tabular-nums"
                            style={{ textAlign: "right" }}
                            value={value}
                            onChange={(event) => {
                              const next = event.currentTarget.value;
                              setApplied((current) => ({
                                ...current,
                                [invoice.id]: next,
                              }));
                            }}
                          />
                          {overBalance ? (
                            <p className="text-xs" style={{ color: "var(--danger)" }}>
                              more than the balance
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-xs muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td colSpan={3} className="text-right font-semibold">
                  Cheque {money(chequeAmount)} · applied / unapplied
                </td>
                <td
                  className="text-right tabular-nums font-semibold"
                  style={overApplied ? { color: "var(--danger)" } : undefined}
                >
                  {money(appliedTotal)}
                </td>
                <td className="text-right tabular-nums font-semibold">
                  {money(unapplied)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {unapplied > 0 && appliedTotal > 0 ? (
        <p className="text-xs muted mt-2">
          {money(unapplied)} will sit as an unapplied credit on this tenant.
        </p>
      ) : null}

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <Submit />
        <FormError message={state.error} />
      </div>
    </form>
  );
}
