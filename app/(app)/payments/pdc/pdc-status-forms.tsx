"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import type { ActionState } from "../actions";

export type StatusOption = { value: string; label: string };

function StatusSubmit({ option }: { option: StatusOption }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="status"
      value={option.value}
      className="btn btn-secondary btn-sm"
      disabled={pending}
    >
      {option.label}
    </button>
  );
}

/**
 * One form per cheque with a submit button per destination, so a refused move
 * reports back next to the button that was pressed rather than doing nothing.
 */
export function ChequeStatusActions({
  action,
  chequeId,
  options,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  chequeId: string;
  options: StatusOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={chequeId} />
      <div className="inline-flex gap-1 flex-wrap justify-end">
        {options.map((option) => (
          <StatusSubmit key={option.value} option={option} />
        ))}
      </div>
      {state.error ? (
        <p
          className="text-xs text-right"
          style={{ color: "var(--danger)", maxWidth: "18rem" }}
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function CancelSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-danger btn-sm" disabled={pending}>
      {pending ? "Requesting…" : "Request cancel"}
    </button>
  );
}

/**
 * Cancelling is approval-gated, so it asks for a reason rather than acting on
 * the click. The reason is what the approver sees in the queue.
 */
export function ChequeCancelRequest({
  action,
  chequeId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  chequeId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [open, setOpen] = useState(false);

  if (state.success) {
    return (
      <p className="text-xs text-right" style={{ maxWidth: "18rem" }}>
        <span className="badge">cancel requested</span>
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen(true)}
      >
        Cancel…
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={chequeId} />
      <input
        name="reason"
        className="input"
        style={{ maxWidth: "16rem" }}
        placeholder="Why is it being cancelled?"
        required
      />
      <div className="inline-flex gap-1">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(false)}
        >
          Back
        </button>
        <CancelSubmit />
      </div>
      {state.error ? (
        <p
          className="text-xs text-right"
          style={{ color: "var(--danger)", maxWidth: "18rem" }}
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function DepositSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Banking…" : label}
    </button>
  );
}

/** Banks one bank's slip and reports what happened. */
export function DepositSlipButton({
  action,
  chequeIds,
  label,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  chequeIds: string[];
  label: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="no-print mb-4">
      {chequeIds.map((id) => (
        <input key={id} type="hidden" name="chequeIds" value={id} />
      ))}
      <DepositSubmit label={label} />
      {state.error ? (
        <p className="text-xs mt-1" style={{ color: "var(--danger)" }} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
