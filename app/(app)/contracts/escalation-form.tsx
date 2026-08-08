"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

function Button({ label, value }: { label: string; value: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="decision"
      value={value}
      className={value === "waived" ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"}
      disabled={pending}
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

/**
 * Rules on one anniversary's rent rise.
 *
 * Two buttons on one form, because applying and holding are the same decision
 * pointing different ways. A hold has to say why -- a rise given away without
 * a reason is the kind of thing nobody can explain a year later.
 */
export function EscalationDecisionForm({
  action,
  escalationId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  escalationId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex items-center gap-2 flex-wrap">
      <input type="hidden" name="escalation_id" value={escalationId} />
      <input
        name="reason"
        className="input"
        style={{ width: "14rem" }}
        placeholder="Reason, if holding it"
      />
      <Button label="Apply" value="applied" />
      <Button label="Hold" value="waived" />
      <FormError message={state.error} />
      {state.success ? (
        <span className="text-xs" style={{ color: "var(--success)" }}>
          {state.success}
        </span>
      ) : null}
    </form>
  );
}
