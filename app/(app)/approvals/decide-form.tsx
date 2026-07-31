"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

function Buttons() {
  const { pending } = useFormStatus();
  return (
    <div className="flex gap-2">
      <button
        type="submit"
        name="decision"
        value="approved"
        className="btn btn-primary btn-sm"
        disabled={pending}
      >
        {pending ? "Working…" : "Approve"}
      </button>
      <button
        type="submit"
        name="decision"
        value="rejected"
        className="btn btn-danger btn-sm"
        disabled={pending}
      >
        Reject
      </button>
    </div>
  );
}

export function DecideForm({
  action,
  requestId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  requestId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={requestId} />
      <input
        name="decision_note"
        className="input"
        placeholder="Note (optional)"
      />
      <Buttons />
      <FormError message={state.error} />
      {state.success ? (
        <p className="text-xs" style={{ color: "var(--success)" }}>
          {state.success}
        </p>
      ) : null}
    </form>
  );
}
