"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

import type { ActionState } from "./actions";

export type LocationOption = { id: string; code: string; name: string };
export type VendorOption = { id: string; name: string };
export type ItemOption = {
  id: string;
  name: string;
  unit_of_measure: string;
  quantity_on_hand: string;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Working…" : label}
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

export function NewJobForm({
  action,
  locations,
  vendors,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  locations: LocationOption[];
  vendors: VendorOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [kind, setKind] = useState("in_house");

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="job-title">
          What needs doing *
        </label>
        <input
          id="job-title"
          name="title"
          className="input"
          required
          placeholder="Leaking roof over unit 204"
        />
      </div>

      <div>
        <label className="label" htmlFor="job-location">
          Location
        </label>
        <select id="job-location" name="location_id" className="select" defaultValue="">
          <option value="">Not specific</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.code} — {location.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="job-kind">
          Carried out by *
        </label>
        <select
          id="job-kind"
          name="job_kind"
          className="select"
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value)}
        >
          <option value="in_house">In-house</option>
          <option value="contracted">Contracted</option>
        </select>
      </div>

      {kind === "contracted" ? (
        <>
          <div>
            <label className="label" htmlFor="job-vendor">
              Contractor *
            </label>
            <select
              id="job-vendor"
              name="vendor_id"
              className="select"
              required
              defaultValue=""
            >
              <option value="">Choose…</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="job-amount">
              Contract amount (₱)
            </label>
            <input
              id="job-amount"
              name="contract_amount"
              type="number"
              step="0.01"
              min="0"
              className="input"
              defaultValue="0"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="label" htmlFor="job-assignee">
            Assigned to
          </label>
          <input id="job-assignee" name="assigned_to" className="input" />
        </div>
      )}

      <div>
        <label className="label" htmlFor="job-scheduled">
          Scheduled for
        </label>
        <input id="job-scheduled" name="scheduled_for" type="date" className="input" />
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="job-description">
          Details
        </label>
        <textarea
          id="job-description"
          name="description"
          className="textarea"
          rows={2}
        />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Report job" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function AdvanceForm({
  action,
  jobId,
  next,
  label,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  jobId: string;
  next: string;
  label: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="id" value={jobId} />
      <input type="hidden" name="status" value={next} />
      <Submit label={label} />
      <Result state={state} />
    </form>
  );
}

export function JobPhotoUploader({
  jobId,
  companyId,
  onRecord,
}: {
  jobId: string;
  companyId: string;
  onRecord: (formData: FormData) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState("before");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function upload(file: File) {
    setError(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const safeName = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${companyId}/jobs/${jobId}/${stage}-${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(path, file, { upsert: false });
      if (uploadError) {
        setError(uploadError.message);
        return;
      }

      const formData = new FormData();
      formData.set("jobId", jobId);
      formData.set("stage", stage);
      formData.set("storagePath", path);
      startTransition(() => {
        void onRecord(formData);
      });
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-end gap-3 flex-wrap">
      <div>
        <label className="label" htmlFor="photo-stage">
          Stage
        </label>
        <select
          id="photo-stage"
          className="select"
          value={stage}
          onChange={(event) => setStage(event.currentTarget.value)}
        >
          <option value="before">Before</option>
          <option value="after">After</option>
          <option value="inspection">Inspection</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="photo-file">
          Photo
        </label>
        <input
          ref={inputRef}
          id="photo-file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="input"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      {busy ? <span className="text-xs muted pb-2">Uploading…</span> : null}
      <FormError message={error} />
    </div>
  );
}

export function MaterialRequestForm({
  action,
  jobId,
  items,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  jobId: string;
  items: ItemOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction}>
      <input type="hidden" name="job_id" value={jobId} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">On hand</th>
              <th className="text-right" style={{ width: "10rem" }}>
                Request
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="text-sm">{item.name}</td>
                <td className="text-right tabular-nums">
                  {Number(item.quantity_on_hand)} {item.unit_of_measure}
                </td>
                <td className="text-right">
                  <input
                    name={`qty:${item.id}`}
                    type="number"
                    step="0.001"
                    min="0"
                    className="input tabular-nums"
                    style={{ textAlign: "right" }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <Submit label="Raise material request" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function IssueForm({
  action,
  requestId,
  label,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  requestId: string;
  label: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="request_id" value={requestId} />
      <Submit label={label} />
      <Result state={state} />
    </form>
  );
}

export function UsageChecklistForm({
  action,
  requestId,
  lines,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  requestId: string;
  lines: {
    id: string;
    name: string;
    unit: string;
    issued: number;
  }[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [used, setUsed] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((line) => [line.id, String(line.issued)])),
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="request_id" value={requestId} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Issued</th>
              <th className="text-right" style={{ width: "9rem" }}>
                Actually used
              </th>
              <th className="text-right">Back to stock</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const usedValue = Number(used[line.id] ?? 0);
              const leftover = line.issued - (Number.isFinite(usedValue) ? usedValue : 0);
              return (
                <tr key={line.id}>
                  <td className="text-sm">{line.name}</td>
                  <td className="text-right tabular-nums">
                    {line.issued} {line.unit}
                  </td>
                  <td className="text-right">
                    <input
                      name={`used:${line.id}`}
                      type="number"
                      step="0.001"
                      min="0"
                      max={line.issued}
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                      value={used[line.id] ?? ""}
                      onChange={(event) =>
                        setUsed((current) => ({
                          ...current,
                          [line.id]: event.currentTarget.value,
                        }))
                      }
                    />
                  </td>
                  <td
                    className="text-right tabular-nums"
                    style={leftover > 0 ? { color: "var(--success)" } : undefined}
                  >
                    {leftover > 0 ? `${leftover} ${line.unit}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <Submit label="Close off and return leftovers" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ProgressForm({
  action,
  jobId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  jobId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <input type="hidden" name="job_id" value={jobId} />
      <div>
        <label className="label" htmlFor="progress-percent">
          Percent complete *
        </label>
        <input
          id="progress-percent"
          name="percent_complete"
          type="number"
          step="0.01"
          min="1"
          max="100"
          className="input"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="progress-amount">
          Tranche amount (₱) *
        </label>
        <input
          id="progress-amount"
          name="tranche_amount"
          type="number"
          step="0.01"
          min="0"
          className="input"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="progress-note">
          Note
        </label>
        <input id="progress-note" name="note" className="input" />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Certify progress" />
        <Result state={state} />
      </div>
    </form>
  );
}
