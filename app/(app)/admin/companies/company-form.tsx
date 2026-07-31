"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

export type CompanyValues = {
  id?: string;
  name?: string | null;
  legal_name?: string | null;
  tin?: string | null;
  address?: string | null;
  contact_person?: string | null;
  contact_number?: string | null;
  email?: string | null;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export function CompanyForm({
  action,
  company,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  company?: CompanyValues;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      {company?.id ? (
        <input type="hidden" name="id" value={company.id} />
      ) : null}

      <div>
        <label className="label" htmlFor={`name-${company?.id ?? "new"}`}>
          Company name *
        </label>
        <input
          id={`name-${company?.id ?? "new"}`}
          name="name"
          className="input"
          required
          defaultValue={company?.name ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`legal-${company?.id ?? "new"}`}>
          Registered legal name
        </label>
        <input
          id={`legal-${company?.id ?? "new"}`}
          name="legal_name"
          className="input"
          defaultValue={company?.legal_name ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`tin-${company?.id ?? "new"}`}>
          TIN
        </label>
        <input
          id={`tin-${company?.id ?? "new"}`}
          name="tin"
          className="input"
          placeholder="000-000-000-000"
          defaultValue={company?.tin ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`contact-${company?.id ?? "new"}`}>
          Contact person
        </label>
        <input
          id={`contact-${company?.id ?? "new"}`}
          name="contact_person"
          className="input"
          defaultValue={company?.contact_person ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`number-${company?.id ?? "new"}`}>
          Contact number
        </label>
        <input
          id={`number-${company?.id ?? "new"}`}
          name="contact_number"
          className="input"
          defaultValue={company?.contact_number ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`email-${company?.id ?? "new"}`}>
          Email
        </label>
        <input
          id={`email-${company?.id ?? "new"}`}
          name="email"
          type="email"
          className="input"
          defaultValue={company?.email ?? ""}
        />
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`address-${company?.id ?? "new"}`}>
          Address
        </label>
        <textarea
          id={`address-${company?.id ?? "new"}`}
          name="address"
          className="textarea"
          rows={2}
          defaultValue={company?.address ?? ""}
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
