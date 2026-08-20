"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

/**
 * Records one cheque at a time.
 *
 * Shut until asked for, and it stays open after a save so a run of twelve can
 * be entered without reaching for the button between each. The bank and the
 * date carry over, because a batch handed across at signing is almost always
 * one chequebook stepping a month at a time -- everything stays editable, and
 * nothing is written until Add is pressed.
 */
export function ChequeReceiptForm({
  action,
  contractId,
  defaultAmount,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  contractId: string;
  defaultAmount: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [open, setOpen] = useState(false);
  const [bank, setBank] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen(true)}
      >
        + Add cheque
      </button>
    );
  }

  return (
    <form action={formAction} className="grid gap-2 sm:grid-cols-5 items-end">
      <input type="hidden" name="contract_id" value={contractId} />

      <div className="sm:col-span-2">
        <label className="label" htmlFor="cheque-bank">
          Bank *
        </label>
        <input
          id="cheque-bank"
          name="bank"
          className="input"
          required
          autoFocus
          placeholder="BDO"
          value={bank}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setBank(next);
          }}
        />
      </div>

      <div>
        <label className="label" htmlFor="cheque-no">
          Cheque number *
        </label>
        <input
          id="cheque-no"
          name="cheque_no"
          className="input"
          required
          placeholder="000123456"
        />
      </div>

      <div>
        <label className="label" htmlFor="cheque-amount">
          Amount (₱) *
        </label>
        <input
          id="cheque-amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          className="input tabular-nums"
          style={{ textAlign: "right" }}
          required
          defaultValue={defaultAmount}
        />
      </div>

      <div>
        <label className="label" htmlFor="cheque-date">
          Cheque date *
        </label>
        <input
          id="cheque-date"
          name="cheque_date"
          type="date"
          className="input"
          required
        />
      </div>

      <div className="sm:col-span-5 flex items-center gap-3 flex-wrap">
        <Submit label="Add" />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(false)}
        >
          Done
        </button>
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
