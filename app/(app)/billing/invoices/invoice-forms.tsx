"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

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

export function GenerateForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="period_start">
          Billing month *
        </label>
        <input
          id="period_start"
          name="period_start"
          type="date"
          className="input"
          required
          defaultValue={defaultMonth}
        />
        <p className="text-xs muted mt-1">
          Any date in the month; the whole calendar month is billed.
        </p>
      </div>

      <div className="sm:col-span-2 flex items-end gap-3 flex-wrap pb-1">
        <Submit label="Generate drafts" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ReleaseForm({
  action,
  invoiceId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="id" value={invoiceId} />
      <Submit label="Release invoice" />
      <Result state={state} />
    </form>
  );
}

export function CancelRequestForm({
  action,
  invoiceId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={invoiceId} />
      <div>
        <label className="label" htmlFor="cancel-reason">
          Reason *
        </label>
        <input
          id="cancel-reason"
          name="reason"
          className="input"
          required
          placeholder="Billed against the wrong contract"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Request cancellation" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

export function CancelDraftForm({
  action,
  invoiceId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={invoiceId} />
      <div>
        <label className="label" htmlFor="draft-cancel-reason">
          Reason *
        </label>
        <input
          id="draft-cancel-reason"
          name="reason"
          className="input"
          required
          placeholder="Tenant moved out before the billing month started"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Cancel this draft" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

export function CreditMemoForm({
  action,
  invoiceId,
  maxAmount,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
  maxAmount: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <div>
        <label className="label" htmlFor="memo-amount">
          Amount (₱) *
        </label>
        <input
          id="memo-amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          max={maxAmount}
          className="input"
          required
        />
        <p className="text-xs muted mt-1">
          Up to {maxAmount.toFixed(2)} uncredited.
        </p>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="memo-reason">
          Reason *
        </label>
        <input
          id="memo-reason"
          name="reason"
          className="input"
          required
          placeholder="Overbilled water for March"
        />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Issue credit memo" />
        <Result state={state} />
      </div>
    </form>
  );
}
