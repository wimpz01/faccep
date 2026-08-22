"use client";

import { useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * The company mark shown at the head of printed documents.
 *
 * Uploaded straight to storage from the browser and then recorded, which is
 * how every other attachment in the system is handled: the file never passes
 * through the server, so a large one does not have to be held in memory there.
 *
 * Kept apart from the layout form on purpose. The layout is a set of choices
 * saved together when the form is submitted; the logo is a file that takes
 * effect the moment it lands, and pretending otherwise would mean holding an
 * uploaded file in limbo until something else was saved.
 */
export function LogoUpload({
  companyId,
  currentUrl,
  onSaved,
  onRemoved,
}: {
  companyId: string;
  currentUrl: string | null;
  /** Records the new path against the company. */
  onSaved: (path: string) => Promise<{ error?: string } | void>;
  onRemoved: () => Promise<{ error?: string } | void>;
}) {
  const [preview, setPreview] = useState<string | null>(currentUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      if (!file.type.startsWith("image/")) {
        setError("Choose an image — PNG, JPEG or WebP.");
        return;
      }
      // A mark on a billing head is small; anything larger is a photograph
      // that will print as a grey smear and bloat every page.
      if (file.size > 2 * 1024 * 1024) {
        setError("That image is over 2MB. A logo should be far smaller.");
        return;
      }

      const supabase = createClient();
      const safeName = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${companyId}/branding/logo-${Date.now()}-${safeName}`;

      const { error: failed } = await supabase.storage
        .from("documents")
        .upload(path, file, { upsert: false });

      if (failed) {
        setError(failed.message);
        return;
      }

      const result = await onSaved(path);
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      // Shown from the file in hand rather than waiting on a signed URL.
      setPreview(URL.createObjectURL(file));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div>
      <p className="label">Company logo</p>

      {preview ? (
        <div className="flex items-center gap-3 flex-wrap">
          {/* Plain img: the file is a signed URL or a blob, neither of which
              the image optimiser can take. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="Company logo"
            style={{
              maxHeight: "48px",
              maxWidth: "180px",
              objectFit: "contain",
              border: "1px solid var(--border)",
              borderRadius: "2px",
              padding: "4px",
              background: "#ffffff",
            }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            Replace
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await onRemoved();
              if (result && "error" in result && result.error) {
                setError(result.error);
              } else {
                setPreview(null);
              }
              setBusy(false);
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Uploading…" : "Upload a logo"}
        </button>
      )}

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void upload(file);
        }}
      />

      <p className="text-xs muted mt-1">
        Shown at the head of the billing when the box below is ticked. A wide,
        short image prints best. Takes effect as soon as it is uploaded.
      </p>
      {error ? (
        <p className="text-xs mt-1" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
