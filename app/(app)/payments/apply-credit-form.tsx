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
  /** What the configured rates say this tenant would withhold. Advisory. */
  suggestedTax: number;
  suggestedVat: number;
};

type Line = { amount: string; tax: string; vat: string; form: string };

const EMPTY: Line = { amount: "", tax: "", vat: "", form: "" };

function num(value: string) {
  return Number(value) || 0;
}

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
 *
 * A withholding tenant pays less than the invoice on purpose, so each line
 * carries what they withheld beside what they paid. The two together are what
 * settles the bill: on a 10,000 rent a tenant hands over 9,553.57 and remits
 * 446.43 to the BIR for us, and the invoice is paid in full. Ticking the box
 * fills both at the configured rate, and both stay editable -- what is
 * recorded is what the tenant actually withheld, not what we expected.
 */
export function ApplyCreditForm({
  action,
  paymentId,
  unapplied,
  invoices,
  tenantWithholds,
  tenantIsGovernment,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  paymentId: string;
  unapplied: number;
  invoices: OpenBill[];
  tenantWithholds: boolean;
  tenantIsGovernment: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [lines, setLines] = useState<Record<string, Line>>({});

  const line = (id: string) => lines[id] ?? EMPTY;

  const cashTotal = round2(
    Object.values(lines).reduce((sum, row) => sum + num(row.amount), 0),
  );
  const withheldTotal = round2(
    Object.values(lines).reduce((sum, row) => sum + num(row.tax) + num(row.vat), 0),
  );
  const over = cashTotal > round2(unapplied);

  function set(id: string, patch: Partial<Line>) {
    setLines((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY), ...patch },
    }));
  }

  /** Cash still unspent, ignoring one invoice's own line. */
  function cashLeftExcluding(current: Record<string, Line>, exceptId: string) {
    const used = round2(
      Object.entries(current)
        .filter(([id]) => id !== exceptId)
        .reduce((sum, [, row]) => sum + num(row.amount), 0),
    );
    return round2(unapplied - used);
  }

  /** Fills the oldest bills first until the credit runs out. */
  function oldestFirst() {
    let left = unapplied;
    const next: Record<string, Line> = {};
    for (const invoice of [...invoices].sort((a, b) =>
      a.due_date.localeCompare(b.due_date),
    )) {
      if (left <= 0) break;
      const withheld = tenantWithholds
        ? Math.min(round2(invoice.suggestedTax + invoice.suggestedVat), invoice.balance)
        : 0;
      const take = Math.min(left, round2(invoice.balance - withheld));
      if (take <= 0 && withheld <= 0) continue;
      next[invoice.id] = {
        amount: take.toFixed(2),
        tax: tenantWithholds && invoice.suggestedTax > 0 ? invoice.suggestedTax.toFixed(2) : "",
        vat: tenantIsGovernment && invoice.suggestedVat > 0 ? invoice.suggestedVat.toFixed(2) : "",
        form: "",
      };
      left = round2(left - take);
    }
    setLines(next);
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
          onClick={() => setLines({})}
          disabled={cashTotal === 0 && withheldTotal === 0}
        >
          Clear
        </button>
        <span className="text-xs muted">{money(unapplied)} unapplied</span>
      </div>

      {tenantWithholds ? (
        <p className="text-xs muted">
          This tenant withholds tax from their rent. Ticking an invoice fills
          the cash and the withheld tax at the configured rate — change either
          if what they actually withheld differs.
        </p>
      ) : null}

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>Set</th>
              <th>Invoice</th>
              <th>Due</th>
              <th className="text-right">Balance</th>
              <th className="text-right" style={{ width: "9rem" }}>
                Cash applied
              </th>
              <th className="text-right" style={{ width: "9rem" }}>
                Tax withheld
              </th>
              {tenantIsGovernment ? (
                <th className="text-right" style={{ width: "9rem" }}>
                  VAT withheld
                </th>
              ) : null}
              <th className="text-right">Settles</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const row = line(invoice.id);
              const settles = round2(num(row.amount) + num(row.tax) + num(row.vat));
              const overBalance = settles > invoice.balance + 0.005;
              const withheldHere = round2(num(row.tax) + num(row.vat));
              return (
                <tr key={invoice.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Set the credit against ${invoice.invoice_no}`}
                      checked={settles > 0}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        setLines((current) => {
                          if (!on) {
                            const next = { ...current };
                            delete next[invoice.id];
                            return next;
                          }
                          const withheld = tenantWithholds
                            ? Math.min(
                                round2(invoice.suggestedTax + invoice.suggestedVat),
                                invoice.balance,
                              )
                            : 0;
                          const left = cashLeftExcluding(current, invoice.id);
                          const take = Math.min(
                            left > 0 ? left : 0,
                            round2(invoice.balance - withheld),
                          );
                          return {
                            ...current,
                            [invoice.id]: {
                              amount: take.toFixed(2),
                              tax:
                                tenantWithholds && invoice.suggestedTax > 0
                                  ? invoice.suggestedTax.toFixed(2)
                                  : "",
                              vat:
                                tenantIsGovernment && invoice.suggestedVat > 0
                                  ? invoice.suggestedVat.toFixed(2)
                                  : "",
                              form: "",
                            },
                          };
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
                      style={{ textAlign: "right" }}
                      value={row.amount}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        set(invoice.id, { amount: next });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      name={`wht:${invoice.id}`}
                      type="number"
                      step="0.01"
                      min="0"
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                      placeholder="0.00"
                      value={row.tax}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        set(invoice.id, { tax: next });
                      }}
                    />
                    {withheldHere > 0 ? (
                      <input
                        name={`form2307:${invoice.id}`}
                        type="text"
                        className="input mt-1"
                        style={{ fontSize: "0.75rem" }}
                        placeholder="2307 ref (optional)"
                        value={row.form}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          set(invoice.id, { form: next });
                        }}
                      />
                    ) : null}
                  </td>
                  {tenantIsGovernment ? (
                    <td>
                      <input
                        name={`vat:${invoice.id}`}
                        type="number"
                        step="0.01"
                        min="0"
                        className="input tabular-nums"
                        style={{ textAlign: "right" }}
                        placeholder="0.00"
                        value={row.vat}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          set(invoice.id, { vat: next });
                        }}
                      />
                    </td>
                  ) : null}
                  <td
                    className="text-right tabular-nums text-sm"
                    style={{ color: overBalance ? "var(--danger)" : undefined }}
                  >
                    {money(settles)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit
          label={`Apply ${money(cashTotal)}`}
          disabled={(cashTotal <= 0 && withheldTotal <= 0) || over}
        />
        {withheldTotal > 0 ? (
          <span className="text-xs muted">
            plus {money(withheldTotal)} withheld — settling{" "}
            {money(round2(cashTotal + withheldTotal))} of invoices
          </span>
        ) : null}
        {over ? (
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            That is {money(round2(cashTotal - unapplied))} more cash than is
            unapplied.
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
