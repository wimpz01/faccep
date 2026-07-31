"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

import type { ActionState } from "./actions";

export type UnitValues = {
  id?: string;
  code?: string | null;
  floor?: string | null;
  area_sqm?: string | number | null;
  monthly_rate?: string | number | null;
  description?: string | null;
  appliances?: string[] | null;
  water_meter_serial?: string | null;
  electric_meter_serial?: string | null;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export function UnitForm({
  action,
  locationId,
  unit,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  locationId: string;
  unit?: UnitValues;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const key = unit?.id ?? "new";

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <input type="hidden" name="locationId" value={locationId} />
      {unit?.id ? <input type="hidden" name="id" value={unit.id} /> : null}

      <div>
        <label className="label" htmlFor={`code-${key}`}>
          Unit code *
        </label>
        <input
          id={`code-${key}`}
          name="code"
          className="input"
          required
          maxLength={30}
          placeholder="101"
          defaultValue={unit?.code ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`floor-${key}`}>
          Floor
        </label>
        <input
          id={`floor-${key}`}
          name="floor"
          className="input"
          placeholder="Ground"
          defaultValue={unit?.floor ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`area-${key}`}>
          Area (sqm)
        </label>
        <input
          id={`area-${key}`}
          name="area_sqm"
          type="number"
          step="0.01"
          min="0"
          className="input"
          defaultValue={unit?.area_sqm != null ? String(unit.area_sqm) : ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`rate-${key}`}>
          Monthly rate (₱) *
        </label>
        <input
          id={`rate-${key}`}
          name="monthly_rate"
          type="number"
          step="0.01"
          min="0"
          required
          className="input"
          defaultValue={unit?.monthly_rate != null ? String(unit.monthly_rate) : "0"}
        />
      </div>

      <div>
        <label className="label" htmlFor={`water-${key}`}>
          Water sub-meter serial
        </label>
        <input
          id={`water-${key}`}
          name="water_meter_serial"
          className="input"
          defaultValue={unit?.water_meter_serial ?? ""}
        />
      </div>

      <div>
        <label className="label" htmlFor={`electric-${key}`}>
          Electric sub-meter serial
        </label>
        <input
          id={`electric-${key}`}
          name="electric_meter_serial"
          className="input"
          defaultValue={unit?.electric_meter_serial ?? ""}
        />
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor={`appliances-${key}`}>
          Included appliances
        </label>
        <input
          id={`appliances-${key}`}
          name="appliances"
          className="input"
          placeholder="bed, TV, ref"
          defaultValue={(unit?.appliances ?? []).join(", ")}
        />
        <p className="text-xs muted mt-1">Separate with commas.</p>
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor={`description-${key}`}>
          Description
        </label>
        <textarea
          id={`description-${key}`}
          name="description"
          className="textarea"
          rows={2}
          defaultValue={unit?.description ?? ""}
        />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
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

/**
 * Uploads straight from the browser to Storage, then records the path through a
 * server action. Sending the binary through a server action would mean holding
 * the whole file in memory on the server for no benefit.
 */
export function UnitPhotoUploader({
  unitId,
  companyId,
  locationId,
  onRecord,
}: {
  unitId: string;
  companyId: string;
  locationId: string;
  onRecord: (formData: FormData) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function upload(file: File) {
    setError(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const safeName = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${companyId}/${unitId}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("unit-photos")
        .upload(path, file, { upsert: false });

      if (uploadError) {
        setError(uploadError.message);
        return;
      }

      const formData = new FormData();
      formData.set("unitId", unitId);
      formData.set("storagePath", path);
      formData.set("locationId", locationId);
      startTransition(() => {
        void onRecord(formData);
      });
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="input"
        style={{ maxWidth: "20rem" }}
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void upload(file);
        }}
      />
      {busy ? <span className="text-xs muted">Uploading…</span> : null}
      <FormError message={error} />
    </div>
  );
}
