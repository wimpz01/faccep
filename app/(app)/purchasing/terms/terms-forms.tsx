"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "../actions";

function Submit({ label, small }: { label: string; small?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={small ? "btn btn-secondary btn-sm" : "btn btn-primary"}
      disabled={pending}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function PaymentTermForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="term-name">
          Term *
        </label>
        <input
          id="term-name"
          name="name"
          className="input"
          required
          placeholder="30 days"
        />
      </div>
      <div>
        <label className="label" htmlFor="term-days">
          Days to pay *
        </label>
        <input
          id="term-days"
          name="days"
          type="number"
          min="0"
          step="1"
          className="input"
          required
          defaultValue="30"
        />
        <p className="text-xs muted mt-1">
          Counted from the invoice date. Zero means cash on delivery.
        </p>
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <Submit label="Add term" />
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

export function TermActiveForm({
  action,
  termId,
  isActive,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  termId: string;
  isActive: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={termId} />
      <input type="hidden" name="active" value={String(!isActive)} />
      <Submit label={isActive ? "Retire" : "Bring back"} small />
      {state.error ? (
        <p className="text-xs" style={{ color: "var(--danger)" }} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
