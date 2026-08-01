"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Changing…" : "Change password"}
    </button>
  );
}

export function ChangePasswordForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="current_password">
          Current password *
        </label>
        <input
          id="current_password"
          name="current_password"
          type="password"
          autoComplete="current-password"
          className="input"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="new_password">
          New password *
        </label>
        <input
          id="new_password"
          name="new_password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          className="input"
          required
        />
        <p className="text-xs muted mt-1">At least 6 characters.</p>
      </div>
      <div>
        <label className="label" htmlFor="confirm_password">
          Repeat new password *
        </label>
        <input
          id="confirm_password"
          name="confirm_password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          className="input"
          required
        />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
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
