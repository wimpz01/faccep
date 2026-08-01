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

type StagedPhoto = { file: File; previewUrl: string };

export function UnitForm({
  action,
  locationId,
  companyId,
  unit,
  submitLabel,
  onRecordPhoto,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  locationId: string;
  companyId: string;
  unit?: UnitValues;
  submitLabel: string;
  onRecordPhoto: (formData: FormData) => Promise<void>;
}) {
  const key = unit?.id ?? "new";
  const isNew = !unit?.id;
  const formRef = useRef<HTMLFormElement>(null);

  const [appliances, setAppliances] = useState<string[]>(unit?.appliances ?? []);
  const [draft, setDraft] = useState("");
  const [staged, setStaged] = useState<StagedPhoto[]>([]);

  function addAppliance() {
    const value = draft.trim();
    if (!value) return;
    setAppliances((current) =>
      current.includes(value) ? current : [...current, value],
    );
    setDraft("");
  }

  // Photos belong to a unit id that does not exist until the insert returns, so
  // the upload runs after the action rather than as part of the submitted form.
  // Keeping it inside the action means useFormStatus stays pending throughout.
  const [state, formAction] = useActionState<ActionState, FormData>(
    async (previous, formData) => {
      const result = await action(previous, formData);
      if (!result.unitId) return result;

      const photos = staged;
      const supabase = createClient();

      for (const photo of photos) {
        const safeName = photo.file.name.replace(/[^\w.-]+/g, "_");
        const path = `${companyId}/${result.unitId}/${Date.now()}-${safeName}`;

        const { error } = await supabase.storage
          .from("unit-photos")
          .upload(path, photo.file, { upsert: false });

        if (error) {
          return {
            ...result,
            error: `Unit saved, but a photo failed to upload: ${error.message}`,
          };
        }

        const record = new FormData();
        record.set("unitId", result.unitId);
        record.set("storagePath", path);
        record.set("locationId", locationId);
        await onRecordPhoto(record);
      }

      // Clear down so the form is ready for the next unit.
      photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
      setStaged([]);
      setAppliances([]);
      setDraft("");
      formRef.current?.reset();

      return {
        ...result,
        success:
          photos.length > 0
            ? `${result.success} ${photos.length} photo${
                photos.length === 1 ? "" : "s"
              } uploaded.`
            : result.success,
      };
    },
    {},
  );

  return (
    <form ref={formRef} action={formAction} className="grid gap-4 sm:grid-cols-3">
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
        <div className="flex gap-2 flex-wrap">
          <input
            id={`appliances-${key}`}
            className="input"
            style={{ maxWidth: "18rem" }}
            placeholder="bed"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter means "add this one", not "submit the unit".
              if (event.key !== "Enter") return;
              event.preventDefault();
              addAppliance();
            }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={addAppliance}
            disabled={draft.trim() === ""}
          >
            Add
          </button>
        </div>

        {appliances.length > 0 ? (
          <ul className="flex gap-2 flex-wrap mt-2">
            {appliances.map((item) => (
              <li
                key={item}
                className="badge"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}
              >
                <input type="hidden" name="appliances" value={item} />
                {item}
                <button
                  type="button"
                  aria-label={`Remove ${item}`}
                  onClick={() =>
                    setAppliances((current) =>
                      current.filter((entry) => entry !== item),
                    )
                  }
                  style={{ fontWeight: 700, lineHeight: 1 }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs muted mt-1">
            Add them one at a time — none listed yet.
          </p>
        )}
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

      {isNew ? (
        <div className="sm:col-span-3">
          <label className="label" htmlFor={`photos-${key}`}>
            Photos
          </label>
          <input
            id={`photos-${key}`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="input"
            style={{ maxWidth: "22rem" }}
            onChange={(event) => {
              const chosen = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (chosen.length === 0) return;
              setStaged((current) => [
                ...current,
                ...chosen.map((file) => ({
                  file,
                  previewUrl: URL.createObjectURL(file),
                })),
              ]);
            }}
          />
          <p className="text-xs muted mt-1">
            Uploaded once the unit is created. JPEG, PNG or WebP.
          </p>

          {staged.length > 0 ? (
            <div className="flex gap-3 flex-wrap mt-3">
              {staged.map((photo) => (
                <figure key={photo.previewUrl} className="w-32">
                  {
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={photo.previewUrl}
                      alt={photo.file.name}
                      className="w-32 h-24 object-cover rounded-lg border"
                      style={{ borderColor: "var(--border)" }}
                    />
                  }
                  <button
                    type="button"
                    className="btn btn-danger btn-sm w-full mt-1"
                    onClick={() =>
                      setStaged((current) => {
                        URL.revokeObjectURL(photo.previewUrl);
                        return current.filter(
                          (entry) => entry.previewUrl !== photo.previewUrl,
                        );
                      })
                    }
                  >
                    Remove
                  </button>
                </figure>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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
