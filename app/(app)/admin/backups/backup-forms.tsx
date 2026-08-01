"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

export function BackupSettingsForm({
  action,
  settings,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  settings: { is_enabled: boolean; frequency: string; retain_count: number };
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [enabled, setEnabled] = useState(settings.is_enabled);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <p className="label">Scheduled backups</p>
        <label
          className="flex items-start gap-2 text-sm"
          style={{ cursor: "pointer", paddingTop: "0.5rem" }}
        >
          <input
            type="checkbox"
            name="is_enabled"
            className="h-4 w-4 accent-[var(--color-brand-600)]"
            style={{ marginTop: "0.15rem" }}
            checked={enabled}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
          <span>Take one automatically</span>
        </label>
      </div>

      <div>
        <label className="label" htmlFor="backup-frequency">
          How often
        </label>
        <select
          id="backup-frequency"
          name="frequency"
          className="select"
          defaultValue={settings.frequency}
          disabled={!enabled}
        >
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor="backup-retain">
          Archives to keep
        </label>
        <input
          id="backup-retain"
          name="retain_count"
          type="number"
          min="1"
          max="60"
          className="input"
          defaultValue={settings.retain_count}
        />
        <p className="text-xs muted mt-1">Older ones are deleted.</p>
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Save settings" busy="Saving…" />
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

export function RunBackupForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <Submit label="Back up now" busy="Reading the data…" />
      <FormError message={state.error} />
      {state.success ? (
        <p className="text-sm" style={{ color: "var(--success)" }}>
          {state.success}
        </p>
      ) : null}
    </form>
  );
}

/** Fetches a short-lived link, then hands the file to the browser. */
export function DownloadBackupButton({
  getUrl,
  storagePath,
}: {
  getUrl: (path: string) => Promise<string | null>;
  storagePath: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(undefined);
            const url = await getUrl(storagePath);
            if (!url) {
              setError("Could not create a download link.");
              return;
            }
            window.location.href = url;
          })
        }
      >
        {pending ? "Preparing…" : "Download"}
      </button>
      {error ? (
        <p className="text-xs" style={{ color: "var(--danger)" }} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DeleteBackupForm({
  action,
  backupId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  backupId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const { pending } = useFormStatus();

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={backupId} />
      <button type="submit" className="btn btn-danger btn-sm" disabled={pending}>
        Delete
      </button>
      {state.error ? (
        <p className="text-xs mt-1" style={{ color: "var(--danger)" }} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
