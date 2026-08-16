"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";

export type FundContractOption = {
  id: string;
  contract_no: string;
  tenant: string;
  depositRemaining: number;
  advanceRemaining: number;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Recording…" : "Record"}
    </button>
  );
}

/**
 * Sets money already held against a contract to some use.
 *
 * This belongs with the payments, not with the contract: taking an advance
 * against a month's bill is a transaction, and the contract screen is where
 * the terms live. What is left of each fund is shown as the contract is
 * chosen, because the database refuses anything larger and it is better to
 * know before pressing the button.
 */
export function FundApplicationForm({
  action,
  contracts,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  contracts: FundContractOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [contractId, setContractId] = useState("");
  const [fund, setFund] = useState("advance_payment");

  const contract = contracts.find((row) => row.id === contractId);
  const remaining = !contract
    ? null
    : fund === "security_deposit"
      ? contract.depositRemaining
      : contract.advanceRemaining;

  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-6 items-end">
      <div className="sm:col-span-3">
        <label className="label" htmlFor="fund-contract">
          Contract
        </label>
        <select
          id="fund-contract"
          name="contract_id"
          className="select"
          required
          value={contractId}
          onChange={(event) => setContractId(event.currentTarget.value)}
        >
          <option value="">Choose a contract…</option>
          {contracts.map((row) => (
            <option key={row.id} value={row.id}>
              {row.tenant} — {row.contract_no}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="fund-kind">
          Fund
        </label>
        <select
          id="fund-kind"
          name="fund_kind"
          className="select"
          value={fund}
          onChange={(event) => setFund(event.currentTarget.value)}
        >
          <option value="advance_payment">Advance / prepayment</option>
          <option value="security_deposit">Security deposit</option>
        </select>
        <p className="text-xs muted mt-1">
          {remaining === null
            ? "Choose a contract to see what is left."
            : `${money(remaining)} left`}
        </p>
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="fund-event">
          What happened
        </label>
        <select
          id="fund-event"
          name="event"
          className="select"
          defaultValue="applied"
        >
          {/* Refund and forfeiture are gone from here on purpose: both are
              now settlement decisions, and recording one here as well drew
              the deposit down twice and posted nothing to the ledger. */}
          <option value="applied">Deducted — repair, damage or a bill</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor="fund-amount">
          Amount (₱)
        </label>
        <input
          id="fund-amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          max={remaining ?? undefined}
          className="input"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="fund-date">
          Date
        </label>
        <input
          id="fund-date"
          name="applied_on"
          type="date"
          className="input"
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="fund-note">
          Note
        </label>
        <input
          id="fund-note"
          name="note"
          className="input"
          placeholder="Repair to shopfront glass"
        />
      </div>

      <div className="sm:col-span-6 flex items-center gap-3 flex-wrap">
        <Submit />
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
