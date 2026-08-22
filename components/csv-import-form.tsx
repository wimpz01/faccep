"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

export type ImportState = { error?: string; success?: string };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Importing…" : label}
    </button>
  );
}

/**
 * A spreadsheet in, one kind of record out.
 *
 * Generalised from the tenant importer, which had all of this written into it.
 * The four lists a property business starts with -- tenants, properties, units
 * and contracts -- are loaded the same way and differ only in their columns,
 * so a second copy of the file picker and the paste box would be three copies
 * to keep in step.
 *
 * A file and a paste box both, because both happen: a file for a list somebody
 * keeps, a paste for a dozen rows out of an email.
 */
export function CsvImportForm({
  action,
  idPrefix,
  templateHref,
  exportHref,
  placeholder,
  requiredNote,
  submitLabel,
}: {
  action: (state: ImportState, formData: FormData) => Promise<ImportState>;
  /** Distinguishes the fields when two of these ever share a page. */
  idPrefix: string;
  templateHref: string;
  /** Absent where there is nothing yet worth exporting back out. */
  exportHref?: string;
  placeholder: string;
  requiredNote: React.ReactNode;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<ImportState, FormData>(action, {});
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");

  const rowCount = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="csv" value={csv} />

      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="label" htmlFor={`${idPrefix}-file`}>
            Spreadsheet (.csv)
          </label>
          <input
            id={`${idPrefix}-file`}
            type="file"
            accept=".csv,text/csv"
            className="input"
            style={{ maxWidth: "20rem" }}
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              if (!file) return;
              setFileName(file.name);
              setCsv(await file.text());
            }}
          />
        </div>
        <a href={templateHref} className="btn btn-secondary btn-sm">
          Download template
        </a>
        {exportHref ? (
          <a href={exportHref} className="btn btn-secondary btn-sm">
            Export what is on file
          </a>
        ) : null}
      </div>

      <div>
        <label className="label" htmlFor={`${idPrefix}-csv`}>
          {fileName
            ? `From ${fileName} — check it, then import`
            : "Or paste the rows"}
        </label>
        <textarea
          id={`${idPrefix}-csv`}
          className="textarea"
          rows={fileName ? 8 : 4}
          placeholder={placeholder}
          value={csv}
          onChange={(event) => setCsv(event.currentTarget.value)}
        />
        <p className="text-xs muted mt-1">
          First row is the header. {requiredNote} Nothing is written unless
          every row is good, so a typo on line 40 cannot leave 39 half-imported.
          {rowCount > 1 ? ` ${rowCount - 1} row(s) ready.` : ""}
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
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
