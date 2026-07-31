"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

export type RoleValues = {
  id?: string;
  name?: string | null;
  description?: string | null;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export function RoleForm({
  action,
  role,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  role?: RoleValues;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const key = role?.id ?? "new";

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      {role?.id ? <input type="hidden" name="id" value={role.id} /> : null}

      <div>
        <label className="label" htmlFor={`role-name-${key}`}>
          Role name *
        </label>
        <input
          id={`role-name-${key}`}
          name="name"
          className="input"
          required
          placeholder="Billing Processor"
          defaultValue={role?.name ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`role-desc-${key}`}>
          Description
        </label>
        <input
          id={`role-desc-${key}`}
          name="description"
          className="input"
          placeholder="Enters billing invoices; cannot apply payments."
          defaultValue={role?.description ?? ""}
        />
      </div>

      <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
        <Submit label={submitLabel} />
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
