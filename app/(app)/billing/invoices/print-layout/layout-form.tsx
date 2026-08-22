"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { LogoUpload } from "./logo-upload";
import {
  PAGE_PRESETS,
  type InvoicePrintSettings,
} from "@/lib/invoice-print";

import type { ActionState } from "../actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Saving…" : "Save layout"}
    </button>
  );
}

function Toggle({
  name,
  label,
  hint,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm" style={{ cursor: "pointer" }}>
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 accent-[var(--color-brand-600)]"
        style={{ marginTop: "0.2rem" }}
      />
      <span>
        {label}
        <span className="block text-xs muted">{hint}</span>
      </span>
    </label>
  );
}

/**
 * The sheet a billing prints on.
 *
 * Held in state rather than left to the form so the outline beside it can show
 * the shape of the page as the numbers change. Nothing here is applied until
 * it is saved -- the preview is the page, not the billing.
 */
export function PrintLayoutForm({
  action,
  settings,
  previewHref,
  companyId,
  logoUrl,
  onLogoSaved,
  onLogoRemoved,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  settings: InvoicePrintSettings;
  previewHref: string | null;
  companyId: string;
  logoUrl: string | null;
  onLogoSaved: (path: string) => Promise<{ error?: string } | void>;
  onLogoRemoved: () => Promise<{ error?: string } | void>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [form, setForm] = useState(settings);

  const set = <K extends keyof InvoicePrintSettings>(
    key: K,
    value: InvoicePrintSettings[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const activePreset = PAGE_PRESETS.find(
    (preset) =>
      Math.abs(preset.width - form.page_width_in) < 0.02 &&
      Math.abs(preset.height - form.page_height_in) < 0.02,
  );

  // The outline is drawn to scale so a wide short sheet looks wide and short.
  const previewWidth = 260;
  const previewHeight = Math.round(
    (previewWidth * form.page_height_in) / form.page_width_in,
  );

  return (
    <form action={formAction} className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 flex flex-col gap-5">
        <div>
          <p className="label">Sheet</p>
          <div className="flex gap-2 flex-wrap mb-3">
            {PAGE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={
                  activePreset?.label === preset.label
                    ? "btn btn-primary btn-sm"
                    : "btn btn-secondary btn-sm"
                }
                onClick={() => {
                  set("page_width_in", preset.width);
                  set("page_height_in", preset.height);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="field">
              <span className="label">Width (in)</span>
              <input
                name="page_width_in"
                type="number"
                step="0.01"
                min="3"
                max="24"
                required
                className="input tabular-nums"
                value={form.page_width_in}
                onChange={(event) =>
                  set("page_width_in", Number(event.currentTarget.value))
                }
              />
            </label>
            <label className="field">
              <span className="label">Height (in)</span>
              <input
                name="page_height_in"
                type="number"
                step="0.01"
                min="3"
                max="24"
                required
                className="input tabular-nums"
                value={form.page_height_in}
                onChange={(event) =>
                  set("page_height_in", Number(event.currentTarget.value))
                }
              />
            </label>
            <label className="field">
              <span className="label">Margin (in)</span>
              <input
                name="margin_in"
                type="number"
                step="0.05"
                min="0"
                max="2"
                required
                className="input tabular-nums"
                value={form.margin_in}
                onChange={(event) =>
                  set("margin_in", Number(event.currentTarget.value))
                }
              />
            </label>
          </div>
        </div>

        <div>
          <p className="label">Type size</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span className="label">Body (pt)</span>
              <input
                name="body_font_pt"
                type="number"
                step="0.5"
                min="5"
                max="16"
                required
                className="input tabular-nums"
                value={form.body_font_pt}
                onChange={(event) =>
                  set("body_font_pt", Number(event.currentTarget.value))
                }
              />
            </label>
            <label className="field">
              <span className="label">Table (pt)</span>
              <input
                name="table_font_pt"
                type="number"
                step="0.5"
                min="5"
                max="16"
                required
                className="input tabular-nums"
                value={form.table_font_pt}
                onChange={(event) =>
                  set("table_font_pt", Number(event.currentTarget.value))
                }
              />
            </label>
          </div>
          <p className="text-xs muted mt-1">
            A shorter sheet needs smaller type. Around 8pt suits half letter;
            11pt suits A4.
          </p>
        </div>

        <LogoUpload
          companyId={companyId}
          currentUrl={logoUrl}
          onSaved={onLogoSaved}
          onRemoved={onLogoRemoved}
        />

        <div>
          <p className="label">What appears on the billing</p>
          <div className="flex flex-col gap-3 mt-1">
            <Toggle
              name="show_logo"
              label="Company logo"
              hint="The mark at the head of the sheet. Turn it off when printing onto letterhead that already carries one."
              checked={form.show_logo}
              onChange={(value) => set("show_logo", value)}
            />
            <Toggle
              name="show_company_header"
              label="Company name and address"
              hint="The name, address, TIN and phone printed beside the logo. Turn it off on letterhead that already carries them."
              checked={form.show_company_header}
              onChange={(value) => set("show_company_header", value)}
            />
            <Toggle
              name="show_meter_columns"
              label="Previous, present and usage columns"
              hint="The meter readings behind a utility charge. Three columns — the first thing to drop on a narrow sheet."
              checked={form.show_meter_columns}
              onChange={(value) => set("show_meter_columns", value)}
            />
            <Toggle
              name="show_meter_dates"
              label="Meter reading dates"
              hint="The provider's own cycle under each utility line. The billing period at the top already says which month the bill is for."
              checked={form.show_meter_dates}
              onChange={(value) => set("show_meter_dates", value)}
            />
            <Toggle
              name="show_vat_column"
              label="VAT column"
              hint="The VAT split per line. The VAT total still prints at the foot either way."
              checked={form.show_vat_column}
              onChange={(value) => set("show_vat_column", value)}
            />
            <Toggle
              name="show_payment_note"
              label="Due date and penalty note"
              hint="The paragraph about late payment on water and electricity."
              checked={form.show_payment_note}
              onChange={(value) => set("show_payment_note", value)}
            />
            <Toggle
              name="show_signatures"
              label="Prepared by / Received by"
              hint="The two signature lines at the foot of the sheet."
              checked={form.show_signatures}
              onChange={(value) => set("show_signatures", value)}
            />
          </div>
        </div>

        <label className="field">
          <span className="label">Footer note</span>
          <textarea
            name="footer_note"
            rows={2}
            className="textarea"
            placeholder="Optional — your own wording, printed under the signatures."
            value={form.footer_note ?? ""}
            onChange={(event) => set("footer_note", event.currentTarget.value)}
          />
        </label>

        <div className="flex items-center gap-3 flex-wrap">
          <Submit />
          <FormError message={state.error} />
          {state.success ? (
            <p className="text-sm" style={{ color: "var(--success)" }}>
              {state.success}
            </p>
          ) : null}
        </div>
      </div>

      {/*
        * The sheet drawn to scale, so a wide short page looks wide and short
        * before any paper is used. Deliberately an outline rather than a
        * rendering of the billing: the billing itself is one click away and is
        * the only honest preview of how the type will sit.
        */}
      <div>
        <p className="label">Sheet shape</p>
        <div
          style={{
            width: previewWidth,
            height: previewHeight,
            border: "1px solid var(--border)",
            background: "#ffffff",
            position: "relative",
            borderRadius: "2px",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: `${(form.margin_in / form.page_height_in) * previewHeight}px ${
                (form.margin_in / form.page_width_in) * previewWidth
              }px`,
              border: "1px dashed #cbd5e1",
            }}
          />
        </div>
        <p className="text-xs muted mt-2">
          {form.page_width_in}in wide × {form.page_height_in}in tall, with a{" "}
          {form.margin_in}in margin.
        </p>

        {previewHref ? (
          <p className="text-xs mt-3">
            <a
              href={previewHref}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--color-brand-600)" }}
            >
              Open a real billing to print →
            </a>
            <span className="block muted mt-1">
              Save first. Then use the browser&rsquo;s print preview to see the
              sheet as it will come out.
            </span>
          </p>
        ) : (
          <p className="text-xs muted mt-3">
            No billing has been raised yet, so there is nothing to preview.
          </p>
        )}
      </div>
    </form>
  );
}
