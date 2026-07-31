"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

import type { ActionState } from "../actions";

function Submit({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={danger ? "btn btn-danger" : "btn btn-primary"}
      disabled={pending}
    >
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

export function ActivateForm({
  action,
  contractId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  contractId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="id" value={contractId} />
      <Submit label="Activate contract" />
      <Result state={state} />
    </form>
  );
}

export function TerminateForm({
  action,
  contractId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  contractId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="id" value={contractId} />
      <div className="sm:col-span-2">
        <label className="label" htmlFor="termination_reason">
          Reason *
        </label>
        <input
          id="termination_reason"
          name="termination_reason"
          className="input"
          required
          placeholder="Non-payment for 3 months"
        />
      </div>
      <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
        <Submit label="Terminate contract" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

/**
 * Uploads the scanned wet-signed contract straight to Storage, then records the
 * path server-side (spec 4.2 -- printed, signed by hand, scanned back in).
 */
export function SignedCopyUploader({
  contractId,
  companyId,
  onRecord,
}: {
  contractId: string;
  companyId: string;
  onRecord: (formData: FormData) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function upload(file: File) {
    setError(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const safeName = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${companyId}/contracts/${contractId}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(path, file, { upsert: false });

      if (uploadError) {
        setError(uploadError.message);
        return;
      }

      const formData = new FormData();
      formData.set("id", contractId);
      formData.set("storagePath", path);
      formData.set("signed_at", dateRef.current?.value ?? "");
      startTransition(() => {
        void onRecord(formData);
      });
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="signed-at">
          Date signed
        </label>
        <input ref={dateRef} id="signed-at" type="date" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="signed-file">
          Scanned copy (PDF or image)
        </label>
        <input
          ref={inputRef}
          id="signed-file"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="input"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      <div className="sm:col-span-2 flex items-center gap-3">
        {busy ? <span className="text-xs muted">Uploading…</span> : null}
        <FormError message={error} />
      </div>
    </div>
  );
}
