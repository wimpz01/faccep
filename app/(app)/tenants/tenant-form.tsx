"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

export type TenantValues = {
  id?: string;
  company_name?: string | null;
  address?: string | null;
  company_number?: string | null;
  contact_person?: string | null;
  mobile_number?: string | null;
  email?: string | null;
  tin?: string | null;
  is_vatable?: boolean;
  notes?: string | null;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
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

export function TenantForm({
  action,
  tenant,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tenant?: TenantValues;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const key = tenant?.id ?? "new";

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      {tenant?.id ? <input type="hidden" name="id" value={tenant.id} /> : null}

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`name-${key}`}>
          Company name *
        </label>
        <input
          id={`name-${key}`}
          name="company_name"
          className="input"
          required
          defaultValue={tenant?.company_name ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`contact-${key}`}>
          Contact person / owner
        </label>
        <input
          id={`contact-${key}`}
          name="contact_person"
          className="input"
          defaultValue={tenant?.contact_person ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`mobile-${key}`}>
          Mobile number
        </label>
        <input
          id={`mobile-${key}`}
          name="mobile_number"
          className="input"
          placeholder="09xx xxx xxxx"
          defaultValue={tenant?.mobile_number ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`companynum-${key}`}>
          Company number
        </label>
        <input
          id={`companynum-${key}`}
          name="company_number"
          className="input"
          defaultValue={tenant?.company_number ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`email-${key}`}>
          Email
        </label>
        <input
          id={`email-${key}`}
          name="email"
          type="email"
          className="input"
          defaultValue={tenant?.email ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`tin-${key}`}>
          TIN
        </label>
        <input
          id={`tin-${key}`}
          name="tin"
          className="input"
          placeholder="000-000-000-000"
          defaultValue={tenant?.tin ?? ""}
        />
      </div>

      <div className="flex items-end">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="is_vatable"
            defaultChecked={tenant?.is_vatable ?? false}
            className="h-4 w-4 accent-[var(--color-brand-600)]"
          />
          VATable — VAT is added to this tenant&apos;s invoices
        </label>
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`address-${key}`}>
          Company address
        </label>
        <textarea
          id={`address-${key}`}
          name="address"
          className="textarea"
          rows={2}
          defaultValue={tenant?.address ?? ""}
        />
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`notes-${key}`}>
          Notes
        </label>
        <textarea
          id={`notes-${key}`}
          name="notes"
          className="textarea"
          rows={2}
          defaultValue={tenant?.notes ?? ""}
        />
      </div>

      <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
        <Submit label={submitLabel} />
        <Result state={state} />
      </div>
    </form>
  );
}

export function TenantStatusForm({
  action,
  tenantId,
  status,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tenantId: string;
  status: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [selected, setSelected] = useState(status);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="id" value={tenantId} />

      <div>
        <label className="label" htmlFor="tenant-status">
          Status
        </label>
        <select
          id="tenant-status"
          name="status"
          className="select"
          value={selected}
          onChange={(event) => setSelected(event.currentTarget.value)}
        >
          <option value="prospect">Prospect</option>
          <option value="active">Active</option>
          <option value="ended">Ended</option>
          <option value="blacklisted">Blacklisted</option>
        </select>
      </div>

      {selected === "blacklisted" ? (
        <div>
          <label className="label" htmlFor="blacklist-reason">
            Reason *
          </label>
          <input
            id="blacklist-reason"
            name="blacklist_reason"
            className="input"
            required
            placeholder="Vacated without notice"
          />
        </div>
      ) : (
        <div />
      )}

      <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
        <Submit label="Update status" />
        <Result state={state} />
        {selected === "blacklisted" ? (
          <p className="text-xs muted">
            Blacklisting blocks any new contract for this tenant until it is
            lifted.
          </p>
        ) : null}
      </div>
    </form>
  );
}
