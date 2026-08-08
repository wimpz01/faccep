"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";
import { PROPERTY_TYPES } from "./constants";

export type LocationValues = {
  id?: string;
  code?: string | null;
  name?: string | null;
  property_type?: string | null;
  address?: string | null;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export function LocationForm({
  action,
  location,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  location?: LocationValues;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const key = location?.id ?? "new";

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      {location?.id ? (
        <input type="hidden" name="id" value={location.id} />
      ) : null}

      <div>
        <label className="label" htmlFor={`code-${key}`}>
          Code *
        </label>
        <input
          id={`code-${key}`}
          name="code"
          className="input"
          required
          maxLength={20}
          placeholder="BLDG-A"
          defaultValue={location?.code ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`name-${key}`}>
          Location name *
        </label>
        <input
          id={`name-${key}`}
          name="name"
          className="input"
          required
          defaultValue={location?.name ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`type-${key}`}>
          Property type *
        </label>
        <select
          id={`type-${key}`}
          name="property_type"
          className="select"
          defaultValue={location?.property_type ?? "commercial_building"}
        >
          {PROPERTY_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`address-${key}`}>
          Address
        </label>
        <input
          id={`address-${key}`}
          name="address"
          className="input"
          defaultValue={location?.address ?? ""}
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
