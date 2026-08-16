"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";

export type UnitOption = {
  id: string;
  code: string;
  monthly_rate: string;
  locationName: string;
};
export type TenantOption = { id: string; company_name: string };

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

export function InquiryForm({
  action,
  units,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  units: UnitOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [unitId, setUnitId] = useState("");

  const unit = units.find((candidate) => candidate.id === unitId);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="inq-contact">
          Contact person *
        </label>
        <input id="inq-contact" name="contact_person" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="inq-company">
          Company
        </label>
        <input id="inq-company" name="company_name" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="inq-mobile">
          Mobile
        </label>
        <input id="inq-mobile" name="mobile_number" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="inq-email">
          Email
        </label>
        <input id="inq-email" name="email" type="email" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="inq-source">
          How they found you
        </label>
        <input
          id="inq-source"
          name="source"
          className="input"
          placeholder="Walk-in, referral, signage"
        />
      </div>
      <div>
        <label className="label" htmlFor="inq-followup">
          Follow up on
        </label>
        <input id="inq-followup" name="follow_up_on" type="date" className="input" />
      </div>

      <div>
        <label className="label" htmlFor="inq-unit">
          Unit of interest
        </label>
        <select
          id="inq-unit"
          name="unit_id"
          className="select"
          value={unitId}
          onChange={(event) => setUnitId(event.currentTarget.value)}
        >
          <option value="">Not decided</option>
          {units.map((option) => (
            <option key={option.id} value={option.id}>
              {option.locationName} · {option.code}
            </option>
          ))}
        </select>
        {unit ? (
          <p className="text-xs muted mt-1">Listed at {money(unit.monthly_rate)}</p>
        ) : null}
      </div>
      <div>
        <label className="label" htmlFor="inq-rent">
          Proposed rent (₱)
        </label>
        <input
          id="inq-rent"
          name="proposed_rent"
          type="number"
          step="0.01"
          min="0"
          className="input"
          defaultValue={unit?.monthly_rate ?? ""}
          key={unitId}
        />
      </div>
      <div>
        <label className="label" htmlFor="inq-term">
          Proposed term (years)
        </label>
        <input
          id="inq-term"
          name="proposed_term_years"
          type="number"
          min="1"
          className="input"
          defaultValue="1"
        />
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="inq-requirement">
          What they are looking for
        </label>
        <textarea
          id="inq-requirement"
          name="requirement"
          className="textarea"
          rows={2}
        />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Log inquiry" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function InquiryStatusForm({
  action,
  inquiryId,
  status,
  followUp,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  inquiryId: string;
  status: string;
  followUp: string | null;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <input type="hidden" name="id" value={inquiryId} />
      <div>
        <label className="label" htmlFor="inq-status">
          Status
        </label>
        <select id="inq-status" name="status" className="select" defaultValue={status}>
          <option value="new">New</option>
          <option value="contacted">Contacted</option>
          <option value="viewing">Viewing arranged</option>
          <option value="proposal_sent">Proposal sent</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="inq-next">
          Next follow-up
        </label>
        <input
          id="inq-next"
          name="follow_up_on"
          type="date"
          className="input"
          defaultValue={followUp ?? ""}
        />
      </div>
      <div>
        <label className="label" htmlFor="inq-note">
          Note
        </label>
        <input id="inq-note" name="note" className="input" />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Update" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ComplaintForm({
  action,
  tenants,
  units,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tenants: TenantOption[];
  units: UnitOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="cmp-subject">
          Subject *
        </label>
        <input
          id="cmp-subject"
          name="subject"
          className="input"
          required
          placeholder="Aircon dripping into the stockroom"
        />
      </div>
      <div>
        <label className="label" htmlFor="cmp-tenant">
          Tenant
        </label>
        <select id="cmp-tenant" name="tenant_id" className="select" defaultValue="">
          <option value="">Not specific</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.company_name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="cmp-unit">
          Unit
        </label>
        <select id="cmp-unit" name="unit_id" className="select" defaultValue="">
          <option value="">Not specific</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.locationName} · {unit.code}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="cmp-details">
          Details
        </label>
        <input id="cmp-details" name="details" className="input" />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Log complaint" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ComplaintUpdateForm({
  action,
  complaintId,
  status,
  resolution,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  complaintId: string;
  status: string;
  resolution: string | null;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [value, setValue] = useState(status);
  const needsResolution = value === "resolved" || value === "closed";

  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-4">
      <input type="hidden" name="id" value={complaintId} />
      <div>
        <select
          name="status"
          className="select"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          aria-label="Status"
        >
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <input
          name="resolution"
          className="input"
          placeholder={needsResolution ? "How it was resolved *" : "Resolution"}
          required={needsResolution}
          defaultValue={resolution ?? ""}
        />
      </div>
      <div>
        <Submit label="Update" />
      </div>
      <div className="sm:col-span-4">
        <Result state={state} />
      </div>
    </form>
  );
}

export function CalendarEventForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="cal-title">
          What *
        </label>
        <input id="cal-title" name="title" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="cal-date">
          When *
        </label>
        <input
          id="cal-date"
          name="event_date"
          type="date"
          className="input"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </div>
      {/* Optional: a reminder with no time is simply for that day. */}
      <div>
        <label className="label" htmlFor="cal-time">
          Time
        </label>
        <input id="cal-time" name="event_time" type="time" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="cal-remind">
          Remind (days before)
        </label>
        <input
          id="cal-remind"
          name="remind_days_before"
          type="number"
          min="0"
          className="input"
          defaultValue="0"
        />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="cal-details">
          Details
        </label>
        <input id="cal-details" name="details" className="input" />
      </div>
      <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
        <Submit label="Add" />
        <Result state={state} />
      </div>
    </form>
  );
}

/** The same fields as the add form, filled in, for editing one reminder. */
export function CalendarEventEditForm({
  action,
  event,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  event: {
    id: string;
    title: string;
    details: string | null;
    event_date: string;
    event_time: string | null;
    remind_days_before: number;
  };
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <input type="hidden" name="id" value={event.id} />
      <div className="sm:col-span-2">
        <label className="label" htmlFor="edit-title">
          What *
        </label>
        <input
          id="edit-title"
          name="title"
          className="input"
          required
          defaultValue={event.title}
        />
      </div>
      <div>
        <label className="label" htmlFor="edit-date">
          When *
        </label>
        <input
          id="edit-date"
          name="event_date"
          type="date"
          className="input"
          required
          defaultValue={event.event_date.slice(0, 10)}
        />
      </div>
      <div>
        <label className="label" htmlFor="edit-time">
          Time
        </label>
        <input
          id="edit-time"
          name="event_time"
          type="time"
          className="input"
          // Postgres returns HH:MM:SS; the input wants HH:MM.
          defaultValue={event.event_time ? event.event_time.slice(0, 5) : ""}
        />
      </div>
      <div>
        <label className="label" htmlFor="edit-remind">
          Remind (days before)
        </label>
        <input
          id="edit-remind"
          name="remind_days_before"
          type="number"
          min="0"
          className="input"
          defaultValue={event.remind_days_before}
        />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="edit-details">
          Details
        </label>
        <input
          id="edit-details"
          name="details"
          className="input"
          defaultValue={event.details ?? ""}
        />
      </div>
      <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
        <Submit label="Save reminder" />
        <Result state={state} />
      </div>
    </form>
  );
}

const DOC_KINDS = [
  { value: "business_permit", label: "Business permit" },
  { value: "dti_registration", label: "DTI registration" },
  { value: "mayors_permit", label: "Mayor's permit" },
  { value: "bir_registration", label: "BIR registration" },
  { value: "contract", label: "Signed contract" },
  { value: "letter", label: "Letter" },
  { value: "memo", label: "Memo" },
  { value: "other", label: "Other" },
];

export function DocumentUploader({
  companyId,
  tenants,
  onRecord,
}: {
  companyId: string;
  tenants: TenantOption[];
  onRecord: (formData: FormData) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function upload() {
    const form = formRef.current;
    const file = fileRef.current?.files?.[0];
    if (!form || !file) {
      setError("Choose a file first.");
      return;
    }

    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    if (!title) {
      setError("Give the document a title.");
      return;
    }

    setError(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const safeName = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${companyId}/documents/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(path, file, { upsert: false });
      if (uploadError) {
        setError(uploadError.message);
        return;
      }

      data.set("storagePath", path);
      startTransition(() => {
        void onRecord(data);
      });
      form.reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="doc-title">
          Title *
        </label>
        <input id="doc-title" name="title" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="doc-kind">
          Type
        </label>
        <select id="doc-kind" name="doc_kind" className="select" defaultValue="other">
          {DOC_KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="doc-tenant">
          Belongs to tenant
        </label>
        <select id="doc-tenant" name="tenant_id" className="select" defaultValue="">
          <option value="">Company-wide</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.company_name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="doc-issued">
          Issued on
        </label>
        <input id="doc-issued" name="issued_on" type="date" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="doc-expires">
          Expires on
        </label>
        <input id="doc-expires" name="expires_on" type="date" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="doc-file">
          File *
        </label>
        <input
          ref={fileRef}
          id="doc-file"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="input"
        />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="doc-notes">
          Notes
        </label>
        <input id="doc-notes" name="notes" className="input" />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void upload()}
        >
          {busy ? "Uploading…" : "File document"}
        </button>
        <FormError message={error} />
      </div>
    </form>
  );
}
