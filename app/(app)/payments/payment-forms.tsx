"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";

import type { ActionState } from "./actions";

export type TenantOption = { id: string; company_name: string };
export type OpenInvoice = {
  id: string;
  invoice_no: string;
  tenant_id: string;
  due_date: string;
  balance: number;
};

function Submit({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={danger ? "btn btn-danger" : "btn btn-primary"}
      disabled={pending}
    >
      {pending ? "Working…" : label}
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

export function RecordPaymentForm({
  action,
  tenants,
  openInvoices,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tenants: TenantOption[];
  openInvoices: OpenInvoice[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [tenantId, setTenantId] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("payment");
  const [applied, setApplied] = useState<Record<string, string>>({});

  const invoices = useMemo(
    () => openInvoices.filter((invoice) => invoice.tenant_id === tenantId),
    [openInvoices, tenantId],
  );

  const totalApplied = round2(
    Object.values(applied).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );
  const unapplied = round2((Number(amount) || 0) - totalApplied);

  /** Fills the invoices oldest-first until the payment runs out. */
  function autoApply() {
    let remaining = Number(amount) || 0;
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
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="tenant_id">
          Tenant *
        </label>
        <select
          id="tenant_id"
          name="tenant_id"
          className="select"
          required
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.currentTarget.value);
            setApplied({});
          }}
        >
          <option value="">Choose…</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.company_name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="amount">
          Amount (₱) *
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          className="input"
          required
          value={amount}
          onChange={(event) => setAmount(event.currentTarget.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="payment_date">
          Date *
        </label>
        <input
          id="payment_date"
          name="payment_date"
          type="date"
          className="input"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </div>

      <div>
        <label className="label" htmlFor="payment_kind">
          Type *
        </label>
        <select
          id="payment_kind"
          name="payment_kind"
          className="select"
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value)}
        >
          <option value="payment">Payment — settles invoices</option>
          <option value="prepayment">Prepayment — credit on account</option>
          <option value="deposit">Security deposit — held, refundable</option>
          <option value="refund">Refund — deposit returned</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor="payment_mode">
          Mode *
        </label>
        <select id="payment_mode" name="payment_mode" className="select" defaultValue="cash">
          <option value="cash">Cash</option>
          <option value="gcash">GCash</option>
          <option value="check">Cheque</option>
          <option value="bank_transfer">Bank transfer</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor="reference">
          Reference
        </label>
        <input
          id="reference"
          name="reference"
          className="input"
          placeholder="Cheque no., GCash ref."
        />
      </div>

      {tenantId ? (
        <div className="sm:col-span-3">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <p className="label" style={{ marginBottom: 0 }}>
              Apply to invoices
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={autoApply}
              disabled={!amount || invoices.length === 0}
            >
              Apply oldest first
            </button>
          </div>

          {invoices.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Due</th>
                    <th className="text-right">Balance</th>
                    <th className="text-right" style={{ width: "10rem" }}>
                      Apply
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td className="text-sm">{invoice.invoice_no}</td>
                      <td className="text-xs">{formatDate(invoice.due_date)}</td>
                      <td className="text-right tabular-nums">
                        {money(invoice.balance)}
                      </td>
                      <td className="text-right">
                        <input
                          name={`apply:${invoice.id}`}
                          type="number"
                          step="0.01"
                          min="0"
                          max={invoice.balance}
                          className="input tabular-nums"
                          style={{ textAlign: "right" }}
                          value={applied[invoice.id] ?? ""}
                          onChange={(event) =>
                            setApplied((current) => ({
                              ...current,
                              [invoice.id]: event.currentTarget.value,
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={2} className="text-right font-semibold">
                      Applied / unapplied
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(totalApplied)}
                    </td>
                    <td
                      className="text-right tabular-nums font-semibold"
                      style={{ color: unapplied < 0 ? "var(--danger)" : undefined }}
                    >
                      {money(unapplied)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm muted">
              This tenant has no open invoices. Record it as a prepayment.
            </p>
          )}
        </div>
      ) : null}

      <div className="sm:col-span-3">
        <label className="label" htmlFor="notes">
          Notes
        </label>
        <input id="notes" name="notes" className="input" />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Record payment" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function VoidRequestForm({
  action,
  paymentId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  paymentId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={paymentId} />
      <div>
        <label className="label" htmlFor="void-reason">
          Reason *
        </label>
        <input
          id="void-reason"
          name="reason"
          className="input"
          required
          placeholder="Cheque bounced"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Request void" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

export function PdcForm({
  action,
  tenants,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tenants: TenantOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="pdc_tenant">
          Tenant *
        </label>
        <select id="pdc_tenant" name="tenant_id" className="select" required defaultValue="">
          <option value="">Choose…</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.company_name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="pdc_bank">
          Bank *
        </label>
        <input id="pdc_bank" name="bank" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="pdc_check_no">
          Cheque number *
        </label>
        <input id="pdc_check_no" name="check_no" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="pdc_amount">
          Amount (₱) *
        </label>
        <input
          id="pdc_amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          className="input"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="pdc_maturity">
          Maturity date *
        </label>
        <input
          id="pdc_maturity"
          name="maturity_date"
          type="date"
          className="input"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="pdc_notes">
          Notes
        </label>
        <input id="pdc_notes" name="notes" className="input" />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Record cheque" />
        <Result state={state} />
      </div>
    </form>
  );
}
