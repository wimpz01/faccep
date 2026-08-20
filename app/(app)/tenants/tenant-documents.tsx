"use client";

import { useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * The five papers a tenant is asked for, in the order they are asked for.
 *
 * The kind is fixed by the row, so nobody picks it twice: attaching under
 * "Mayor's permit" is what makes it a mayor's permit.
 */
export const TENANT_DOC_KINDS = [
  { kind: "mayors_permit", label: "Mayor's / Business permit" },
  { kind: "dti_registration", label: "DTI" },
  { kind: "bir_registration", label: "BIR" },
  { kind: "sec_registration", label: "SEC" },
  { kind: "valid_id", label: "ID" },
] as const;

const ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

type Attached = { path: string; fileName: string };

/**
 * Attaches a tenant's documents while the tenant is being created.
 *
 * The files go to storage as they are chosen, because the browser cannot hold
 * them until the form is submitted and a half-uploaded document is worse than
 * none. They land under a draft folder; the rows that tie them to the tenant
 * are written by the server once the tenant exists, so a form abandoned
 * halfway leaves files nobody has claimed rather than a tenant nobody meant.
 *
 * The expiry date is typed. Nothing here guesses at one.
 */
export function TenantDocuments({ companyId }: { companyId: string }) {
  // One folder per attempt, so two people filling the form in at once cannot
  // overwrite each other's files.
  const draftRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now()),
  );
  const [attached, setAttached] = useState<Record<string, Attached>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [noExpiry, setNoExpiry] = useState<Record<string, boolean>>({});

  async function upload(kind: string, file: File) {
    setBusy(kind);
    setErrors((current) => ({ ...current, [kind]: "" }));
    try {
      const supabase = createClient();
      const safeName = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${companyId}/tenants/${draftRef.current}/${kind}-${Date.now()}-${safeName}`;

      const { error } = await supabase.storage
        .from("documents")
        .upload(path, file, { upsert: false });

      if (error) {
        setErrors((current) => ({ ...current, [kind]: error.message }));
        return;
      }
      // Replacing simply points the row at the newer file; the earlier one is
      // left in storage rather than destroyed.
      setAttached((current) => ({
        ...current,
        [kind]: { path, fileName: file.name },
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sm:col-span-2">
      <p className="label">Tenant documents</p>
      <p className="text-xs muted mb-2">
        Optional. Attach what you have — the expiry date is typed from the
        document itself.
      </p>

      <div className="flex flex-col gap-2">
        {TENANT_DOC_KINDS.map(({ kind, label }) => {
          const file = attached[kind];
          const none = noExpiry[kind] ?? false;
          return (
            <div
              key={kind}
              className="flex items-center gap-3 flex-wrap"
              style={{
                borderTop: "1px solid var(--border)",
                paddingTop: "0.5rem",
              }}
            >
              <span className="text-sm" style={{ minWidth: "12rem" }}>
                {label}
              </span>

              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="file"
                  accept={ACCEPT}
                  className="input"
                  style={{ maxWidth: "15rem" }}
                  aria-label={`Attach ${label}`}
                  onChange={(event) => {
                    const chosen = event.currentTarget.files?.[0];
                    if (chosen) void upload(kind, chosen);
                  }}
                />
                {busy === kind ? (
                  <span className="text-xs muted">Uploading…</span>
                ) : file ? (
                  <span className="text-xs" style={{ color: "var(--success)" }}>
                    Attached ✓ {file.fileName}
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-xs muted" htmlFor={`exp-${kind}`}>
                  Expiry date
                </label>
                <input
                  id={`exp-${kind}`}
                  name={`doc_expiry:${kind}`}
                  type="date"
                  className="input"
                  style={{ maxWidth: "11rem" }}
                  disabled={none}
                />
                <label className="text-xs flex items-center gap-1">
                  <input
                    type="checkbox"
                    name={`doc_no_expiry:${kind}`}
                    checked={none}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setNoExpiry((current) => ({ ...current, [kind]: on }));
                    }}
                  />
                  No expiry
                </label>
              </div>

              {file ? (
                <>
                  <input
                    type="hidden"
                    name={`doc_path:${kind}`}
                    value={file.path}
                  />
                  <input
                    type="hidden"
                    name={`doc_name:${kind}`}
                    value={file.fileName}
                  />
                </>
              ) : null}

              {errors[kind] ? (
                <span className="text-xs" style={{ color: "var(--danger)" }}>
                  {errors[kind]}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
