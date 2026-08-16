"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";

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

export type SettleableContract = {
  id: string;
  label: string;
  held: number;
};

/** Opens the settlement for a contract that still holds a deposit. */
export function OpenSettlementForm({
  action,
  contracts,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  contracts: SettleableContract[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [contractId, setContractId] = useState("");
  const chosen = contracts.find((row) => row.id === contractId);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4 items-end">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="settle-contract">
          Contract *
        </label>
        <select
          id="settle-contract"
          name="contract_id"
          className="select"
          required
          value={contractId}
          disabled={contracts.length === 0}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setContractId(next);
          }}
        >
          <option value="">
            {contracts.length === 0
              ? "No deposit is held on any contract"
              : "Choose a contract…"}
          </option>
          {contracts.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
        <p className="text-xs muted mt-1">
          {chosen
            ? `${money(chosen.held)} held on this contract.`
            : "Only contracts still holding a deposit can be settled."}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="settle-date">
          Settlement date
        </label>
        <input
          id="settle-date"
          name="settled_on"
          type="date"
          className="input"
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Open settlement" />
        <Result state={state} />
      </div>
    </form>
  );
}

export type OpenBill = { id: string; label: string; balance: number };

/**
 * One thing kept out of the deposit.
 *
 * Naming a bill is what tells the ledger to settle the receivable rather than
 * credit the repair cost, so the choice is made here and not guessed at later.
 */
export function AddLineForm({
  action,
  settlementId,
  invoices,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  settlementId: string;
  invoices: OpenBill[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [kind, setKind] = useState("deduction");

  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-6 items-end">
      <input type="hidden" name="settlement_id" value={settlementId} />

      <div className="sm:col-span-2">
        <label className="label" htmlFor="line-kind">
          What is being kept
        </label>
        <select
          id="line-kind"
          name="kind"
          className="select"
          value={kind}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setKind(next);
          }}
        >
          <option value="deduction">Deduction — repair, damage or a bill</option>
          <option value="forfeiture">Forfeiture — under the contract terms</option>
        </select>
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="line-description">
          For what *
        </label>
        <input
          id="line-description"
          name="description"
          className="input"
          required
          placeholder="Repair to shopfront glass"
        />
      </div>

      <div>
        <label className="label" htmlFor="line-amount">
          Amount (₱) *
        </label>
        <input
          id="line-amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          className="input"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="line-invoice">
          Settles a bill
        </label>
        <select
          id="line-invoice"
          name="invoice_id"
          className="select"
          disabled={kind === "forfeiture" || invoices.length === 0}
        >
          <option value="">
            {kind === "forfeiture" ? "Not applicable" : "No — a repair or damage"}
          </option>
          {kind === "forfeiture"
            ? null
            : invoices.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
        </select>
      </div>

      <div className="sm:col-span-6 flex items-center gap-3 flex-wrap">
        <Submit label="Add" />
        <Result state={state} />
        <span className="text-xs muted">
          {kind === "forfeiture"
            ? "Credited to Other Income. No invoice, so no VAT."
            : "A bill settles receivables; a repair is credited back to Repairs and Maintenance."}
        </span>
      </div>
    </form>
  );
}

/** The manager's act: everything below turns on this. */
export function ApproveSettlementForm({
  action,
  settlementId,
  refundable,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  settlementId: string;
  refundable: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="id" value={settlementId} />
      <Submit label={`Approve — ${money(refundable)} refundable`} />
      <Result state={state} />
    </form>
  );
}
