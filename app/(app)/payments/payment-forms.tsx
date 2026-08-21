"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";

import type { ActionState } from "./actions";

export type TenantOption = {
  id: string;
  company_name: string;
  withholds_tax: boolean;
  is_government: boolean;
};
export type OpenInvoice = {
  id: string;
  invoice_no: string;
  tenant_id: string;
  due_date: string;
  balance: number;
  /** What the configured rates say this tenant would withhold. Advisory. */
  suggestedTax: number;
  suggestedVat: number;
};

function Submit({
  label,
  danger,
  disabled,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={danger ? "btn btn-danger" : "btn btn-primary"}
      disabled={pending || disabled}
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

/** A contract of the chosen tenant, and where its deposit stands. */
export type DepositContract = {
  id: string;
  tenant_id: string;
  contract_no: string;
  unitLabel: string;
  agreed: number;
  received: number;
  remaining: number;
};

export function RecordPaymentForm({
  action,
  tenants,
  openInvoices,
  contracts = [],
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tenants: TenantOption[];
  openInvoices: OpenInvoice[];
  contracts?: DepositContract[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [tenantId, setTenantId] = useState("");
  const [contractId, setContractId] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("payment");
  const [mode, setMode] = useState("cash");
  const [fundKind, setFundKind] = useState("security_deposit");
  const [postdated, setPostdated] = useState(false);
  const [chequeDate, setChequeDate] = useState('');
  // Held because a cheque is postdated relative to this, not to today.
  const [date, setDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [chequeAmount, setChequeAmount] = useState('');
  const [applied, setApplied] = useState<Record<string, string>>({});
  /*
   * Tax the tenant kept back, per invoice. Not part of the payment amount --
   * that money never arrived, it went to the BIR for us -- so it settles the
   * invoice without ever counting against what is unapplied.
   */
  const [withheld, setWithheld] = useState<Record<string, string>>({});

  // Both modes carry a cheque, so both need its bank, number and date.
  const isCheque = mode === "check" || mode === "cash_check";
  const isSplit = mode === "cash_check";
  /*
   * A deposit is held against one contract, not against the tenant at large:
   * each unit is its own contract and carries its own deposit. A refund then
   * names the deposit it is returning, which is what lets the contract record
   * and the ledger stay in step.
   */
  const againstContract = kind === "deposit" || kind === "refund";
  const tenantContracts = useMemo(
    () => contracts.filter((row) => row.tenant_id === tenantId),
    [contracts, tenantId],
  );
  const chosenContract = tenantContracts.find((row) => row.id === contractId);
  /*
   * A cheque written for a later date is postdated by definition, so the
   * box ticks itself rather than waiting to be remembered. It stays
   * editable: a cheque dated today can still be held rather than banked.
   */
  const looksPostdated =
    isCheque && chequeDate !== '' && date !== '' && chequeDate > date;

  useEffect(() => {
    if (looksPostdated) setPostdated(true);
  }, [looksPostdated]);

  // A postdated cheque is a promise, not cash. It is tracked against the
  // tenant until it clears, so it settles nothing on the way in.
  const isPostdated = isCheque && postdated;

  /*
   * Cash only ever tops up a cheque that is money today. A postdated one
   * goes to the register on its own, so the split is refused here as well
   * as in the database.
   */
  const splitIsPostdated = isSplit && (looksPostdated || postdated);
  const cashPart =
    isSplit && amount !== '' && chequeAmount !== ''
      ? round2(Number(amount) - Number(chequeAmount))
      : null;

  const invoices = useMemo(
    () => openInvoices.filter((invoice) => invoice.tenant_id === tenantId),
    [openInvoices, tenantId],
  );

  const chosenTenant = tenants.find((row) => row.id === tenantId);
  const tenantWithholds = chosenTenant?.withholds_tax ?? false;
  const tenantIsGovernment = chosenTenant?.is_government ?? false;

  const totalWithheld = round2(
    Object.values(withheld).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );

  const totalApplied = round2(
    Object.values(applied).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );
  const unapplied = round2((Number(amount) || 0) - totalApplied);
  const selectedCount = Object.values(applied).filter(
    (value) => Number(value) > 0,
  ).length;

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

  /**
   * Ticking an invoice attaches it, filling in whatever is still unapplied up
   * to that invoice's balance. Unticking detaches it. The amount stays
   * editable underneath for a part payment.
   */
  function toggleInvoice(invoice: OpenInvoice, checked: boolean) {
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
      const stillUnapplied = round2((Number(amount) || 0) - alreadyApplied);
      /*
       * A withholding tenant settles the bill partly in cash and partly by
       * paying our tax, so the cash to attach is the balance less what they
       * kept back.
       */
      const keptBack = tenantWithholds
        ? Math.min(
            round2(invoice.suggestedTax + invoice.suggestedVat),
            invoice.balance,
          )
        : 0;
      const owing = round2(invoice.balance - keptBack);
      // With no amount entered yet, attach the full balance and let the total
      // drive the amount instead.
      const take = stillUnapplied > 0 ? Math.min(stillUnapplied, owing) : owing;

      return { ...current, [invoice.id]: take.toFixed(2) };
    });

    // The withheld portion follows the attachment, and is editable after.
    setWithheld((current) => {
      const next = { ...current };
      if (!checked || !tenantWithholds) {
        delete next[invoice.id];
        return next;
      }
      const keptBack = Math.min(
        round2(invoice.suggestedTax + invoice.suggestedVat),
        invoice.balance,
      );
      if (keptBack <= 0) {
        delete next[invoice.id];
        return next;
      }
      next[invoice.id] = keptBack.toFixed(2);
      return next;
    });
  }

  function selectAll() {
    let remaining = Number(amount) || Infinity;
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
            setContractId("");
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

      {againstContract ? (
        <div className="sm:col-span-2">
          <label className="label" htmlFor="contract_id">
            Contract * — which deposit
          </label>
          <select
            id="contract_id"
            name="contract_id"
            className="select"
            required
            value={contractId}
            onChange={(event) => setContractId(event.currentTarget.value)}
          >
            <option value="">
              {tenantId ? "Choose a contract…" : "Choose a tenant first"}
            </option>
            {tenantContracts.map((row) => (
              <option key={row.id} value={row.id}>
                {row.contract_no} — {row.unitLabel}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">
            {!chosenContract
              ? "A deposit belongs to one contract, and each unit has its own."
              : kind === "refund"
                ? `${money(chosenContract.remaining)} held on this contract — the most that can be returned.`
                : `Agreed ${money(chosenContract.agreed)} · received so far ${money(chosenContract.received)}.`}
          </p>
        </div>
      ) : null}

      {/* Which fund is going back. The deposit route goes through a settlement
          so the amount is already decided; an advance has nothing to deduct. */}
      {kind === "refund" ? (
        <div>
          <label className="label" htmlFor="fund_kind">
            Returning *
          </label>
          <select
            id="fund_kind"
            name="fund_kind"
            className="select"
            value={fundKind}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setFundKind(next);
            }}
          >
            <option value="security_deposit">Security deposit</option>
            <option value="advance_payment">Advance / prepayment</option>
          </select>
          <p className="text-xs muted mt-1">
            {fundKind === "security_deposit"
              ? "Needs an approved settlement; the refundable figure comes from it."
              : "Bounded by what is left of the advance."}
          </p>
        </div>
      ) : null}

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
          value={date}
          onChange={(event) => setDate(event.currentTarget.value)}
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
        <select
          id="payment_mode"
          name="payment_mode"
          className="select"
          value={mode}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setMode(next);
            // Only a cheque can be held rather than banked, and a split
            // never can, so the flag clears with the mode.
            if (next !== "check") setPostdated(false);
            if (next !== "cash_check") setChequeAmount("");
          }}
        >
          <option value="cash">Cash</option>
          <option value="gcash">GCash</option>
          <option value="check">Cheque</option>
          <option value="cash_check">Cash + cheque</option>
          <option value="bank_transfer">Bank transfer</option>
        </select>
        {isSplit ? (
          <p className="text-xs muted mt-1">
            For a cheque written short, with cash making up the balance.
          </p>
        ) : null}
      </div>

      <div>
        <label className="label" htmlFor="reference">
          {isCheque ? "Cheque number *" : "Reference"}
        </label>
        <input
          id="reference"
          name="reference"
          className="input"
          required={isCheque}
          placeholder={isCheque ? "000123456" : "GCash ref., transfer no."}
        />
      </div>

      {isCheque ? (
        <>
          <div>
            <label className="label" htmlFor="check_bank">
              Bank *
            </label>
            <input id="check_bank" name="check_bank" className="input" required />
          </div>

          {isSplit ? (
            <div>
              <label className="label" htmlFor="cheque_amount">
                Cheque amount (₱) *
              </label>
              <input
                id="cheque_amount"
                name="cheque_amount"
                type="number"
                step="0.01"
                min="0"
                required
                className="input tabular-nums"
                value={chequeAmount}
                onChange={(event) => setChequeAmount(event.currentTarget.value)}
              />
              {/* The cash is whatever the cheque does not cover, shown so the
                  drawer can be counted against the receipt. */}
              {cashPart === null ? (
                <p className="text-xs muted mt-1">
                  The rest of the amount is taken as cash.
                </p>
              ) : cashPart > 0 ? (
                <p className="text-xs muted mt-1">
                  Cash {money(cashPart)} · cheque {money(Number(chequeAmount))}
                </p>
              ) : (
                <p className="text-xs mt-1" style={{ color: "var(--danger)" }}>
                  The cheque must be less than the {money(Number(amount) || 0)}{' '}
                  total — record it as a cheque payment if no cash came with it.
                </p>
              )}
            </div>
          ) : null}

          <div>
            <label className="label" htmlFor="check_date">
              Cheque date *
            </label>
            <input
              id="check_date"
              name="check_date"
              type="date"
              className="input"
              required
              value={chequeDate}
              onChange={(event) => setChequeDate(event.currentTarget.value)}
            />
            <p className="text-xs muted mt-1">
              {looksPostdated
                ? 'Dated after the payment date, so this is a postdated cheque.'
                : 'The date written on the cheque.'}
            </p>
          </div>

          <div>
            <p className="label">Postdated</p>
            <label
              className="flex items-start gap-2 text-sm"
              style={{ cursor: "pointer", paddingTop: "0.5rem" }}
            >
              <input
                type="checkbox"
                name="postdated"
                className="h-4 w-4 accent-[var(--color-brand-600)]"
                style={{ marginTop: "0.15rem" }}
                checked={postdated}
                onChange={(event) => setPostdated(event.currentTarget.checked)}
              />
              <span>Not yet deposited</span>
            </label>
            {looksPostdated ? (
              <p className="text-xs muted mt-1">
                Ticked for you — the cheque is dated ahead.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {isPostdated ? (
        <div className="sm:col-span-3">
          <p className="text-sm" style={{ color: "var(--color-brand-600)" }}>
            This will be held under <strong>Postdated cheques</strong> rather than
            posted as a collection. It settles no invoice and adds nothing to
            this month&rsquo;s takings until it is deposited and cleared.
          </p>
        </div>
      ) : null}

      {tenantId && !isPostdated ? (
        <div className="sm:col-span-3">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <p className="label" style={{ marginBottom: 0 }}>
              Attach invoices — tick the ones this payment settles
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={selectAll}
                disabled={invoices.length === 0}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={autoApply}
                disabled={!amount || invoices.length === 0}
              >
                Apply oldest first
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setApplied({})}
                disabled={selectedCount === 0}
              >
                Clear
              </button>
            </div>
          </div>

          {tenantWithholds ? (
            <p className="text-xs muted mb-2">
              This tenant withholds tax from their rent, so attaching an
              invoice fills the cash and the withheld tax separately. The two
              together settle the bill in full
              {tenantIsGovernment
                ? " — as a government tenant they withhold VAT as well."
                : "."}{" "}
              Change either figure if what they actually withheld differs.
            </p>
          ) : null}

          {invoices.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>Attach</th>
                    <th>Invoice</th>
                    <th>Due</th>
                    <th className="text-right">Balance</th>
                    <th className="text-right" style={{ width: "10rem" }}>
                      Amount applied
                    </th>
                    <th className="text-right" style={{ width: "9rem" }}>
                      Tax withheld
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => {
                    const value = applied[invoice.id] ?? "";
                    // Cash and withheld tax together settle the bill, so it
                    // is the pair that decides whether this is a part
                    // payment and the pair that must not exceed the balance.
                    // Reading the cash alone would call a withholding
                    // tenant's payment in full a part payment.
                    const settling = round2(
                      (Number(value) || 0) + (Number(withheld[invoice.id]) || 0),
                    );
                    const attached = settling > 0;
                    const isPartial =
                      attached && settling < invoice.balance - 0.005;
                    const overBalance = Number(value) > invoice.balance;
                    const settlesOver = settling > invoice.balance + 0.005;
                    return (
                      <tr key={invoice.id}>
                        <td>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--color-brand-600)]"
                            checked={attached}
                            aria-label={`Attach ${invoice.invoice_no}`}
                            onChange={(event) =>
                              toggleInvoice(invoice, event.currentTarget.checked)
                            }
                          />
                        </td>
                        <td className="text-sm">
                          {invoice.invoice_no}
                          {isPartial ? (
                            <p className="text-xs muted">part payment</p>
                          ) : null}
                        </td>
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
                            style={{
                              textAlign: "right",
                              borderColor: overBalance
                                ? "var(--danger)"
                                : undefined,
                            }}
                            value={value}
                            onChange={(event) => {
                              // currentTarget is null by the time the updater
                              // runs, so take the value now.
                              const value = event.currentTarget.value;
                              setApplied((current) => ({
                                ...current,
                                [invoice.id]: value,
                              }));
                            }}
                          />
                          {overBalance ? (
                            <p
                              className="text-xs"
                              style={{ color: "var(--danger)" }}
                            >
                              more than the balance
                            </p>
                          ) : null}
                        </td>
                        <td className="text-right">
                          <input
                            name={`wht:${invoice.id}`}
                            type="number"
                            step="0.01"
                            min="0"
                            className="input tabular-nums"
                            style={{ textAlign: "right" }}
                            placeholder="0.00"
                            value={withheld[invoice.id] ?? ""}
                            onChange={(event) => {
                              // currentTarget is null by the time the
                              // updater runs, so take the value now.
                              const next = event.currentTarget.value;
                              setWithheld((current) => ({
                                ...current,
                                [invoice.id]: next,
                              }));
                            }}
                          />
                          {settlesOver ? (
                            <p
                              className="text-xs"
                              style={{ color: "var(--danger)" }}
                            >
                              cash + withheld is more than the balance
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td colSpan={3} className="text-right font-semibold">
                      {selectedCount} attached · applied / unapplied
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
                    <td className="text-right tabular-nums font-semibold">
                      {money(totalWithheld)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm muted">
              This tenant has no open invoices. Record it as a prepayment, or
              generate and release their invoice first.
            </p>
          )}

          {unapplied < 0 ? (
            <p className="form-error mt-2">
              You have attached {money(totalApplied)} but the payment is only{" "}
              {money(Number(amount) || 0)}. Reduce an amount or raise the
              payment.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="sm:col-span-3">
        <label className="label" htmlFor="notes">
          Notes
        </label>
        <input id="notes" name="notes" className="input" />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit
          label={isPostdated ? "Record postdated cheque" : "Record payment"}
          disabled={splitIsPostdated || (isSplit && cashPart !== null && cashPart <= 0)}
        />
        {/* A split cannot carry a promise: the receipt would count money
            that has not arrived. */}
        {splitIsPostdated ? (
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            That cheque is dated ahead, so it cannot be receipted with cash.
            Record the postdated cheque on its own and the cash separately.
          </p>
        ) : null}
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
          placeholder="Wrong amount — recording it again"
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
        <p className="text-xs muted mt-1">
          As printed by the bank. Ours is issued on save.
        </p>
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
