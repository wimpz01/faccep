"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { formatDate, money } from "@/lib/format";

import { ALL_LOCATIONS, STATUS_BADGE } from "./constants";

import type { ActionState } from "./actions";

function Submit({
  label,
  danger,
  disabled,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={danger ? "btn btn-danger" : "btn btn-primary"}
      disabled={pending || disabled}
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

/**
 * Billing is scoped to one property, or deliberately to all of them.
 *
 * There is no default: the box opens empty and the run cannot start until a
 * choice is made, so billing the whole portfolio is something chosen rather
 * than something that happens by leaving a field alone.
 */
export function GenerateForm({
  action,
  locations,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  locations: { id: string; code: string; name: string }[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [choice, setChoice] = useState("");
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const named = locations.find((location) => location.id === choice);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="period_start">
          Billing month *
        </label>
        <input
          id="period_start"
          name="period_start"
          type="date"
          className="input"
          required
          defaultValue={defaultMonth}
        />
        <p className="text-xs muted mt-1">
          Any date in the month; the whole calendar month is billed.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="location-picker">
          Location *
        </label>
        <select
          id="location-picker"
          name="location_ids"
          className="select"
          required
          value={choice}
          disabled={locations.length === 0}
          onChange={(event) => {
            // Read now: React clears currentTarget once the handler returns.
            const next = event.currentTarget.value;
            setChoice(next);
          }}
        >
          <option value="">
            {locations.length === 0
              ? "No active locations to bill"
              : "Choose…"}
          </option>
          {locations.length > 0 ? (
            <option value={ALL_LOCATIONS}>All locations</option>
          ) : null}
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.code} — {location.name}
            </option>
          ))}
        </select>
        <p className="text-xs muted mt-1">
          {choice === ""
            ? "One property, or all of them."
            : choice === ALL_LOCATIONS
              ? `Billing all ${locations.length} locations.`
              : `Billing ${named?.code} only.`}
        </p>
      </div>

      <div className="flex items-end gap-3 flex-wrap pb-1">
        <Submit label="Generate drafts" disabled={choice === ""} />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ReleaseForm({
  action,
  invoiceId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="id" value={invoiceId} />
      <Submit label="Release invoice" />
      <Result state={state} />
    </form>
  );
}

export function CancelRequestForm({
  action,
  invoiceId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={invoiceId} />
      <div>
        <label className="label" htmlFor="cancel-reason">
          Reason *
        </label>
        <input
          id="cancel-reason"
          name="reason"
          className="input"
          required
          placeholder="Billed against the wrong contract"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Request cancellation" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

export function CancelDraftForm({
  action,
  invoiceId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={invoiceId} />
      <div>
        <label className="label" htmlFor="draft-cancel-reason">
          Reason *
        </label>
        <input
          id="draft-cancel-reason"
          name="reason"
          className="input"
          required
          placeholder="Tenant moved out before the billing month started"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Cancel this draft" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

export function CreditMemoForm({
  action,
  invoiceId,
  maxAmount,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  invoiceId: string;
  maxAmount: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <div>
        <label className="label" htmlFor="memo-amount">
          Amount (₱) *
        </label>
        <input
          id="memo-amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          max={maxAmount}
          className="input"
          required
        />
        <p className="text-xs muted mt-1">
          Up to {maxAmount.toFixed(2)} uncredited.
        </p>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="memo-reason">
          Reason *
        </label>
        <input
          id="memo-reason"
          name="reason"
          className="input"
          required
          placeholder="Overbilled water for March"
        />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Issue credit memo" />
        <Result state={state} />
      </div>
    </form>
  );
}

export type InvoiceListRow = {
  id: string;
  invoice_no: string;
  tenant: string;
  location: string;
  invoice_date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
  isOverdue: boolean;
};

/**
 * The invoice list, with selection for releasing a month in one go.
 *
 * Only drafts can be ticked: releasing posts to the ledger and locks the
 * invoice, so anything already out is not selectable rather than silently
 * ignored.
 */
/** A column heading that sorts, showing which way it is sorted now. */
function SortHeader({
  label,
  href,
  sorted,
  ascending,
  className,
}: {
  label: string;
  href: string;
  sorted: boolean;
  ascending: boolean;
  className?: string;
}) {
  return (
    <th className={className}>
      <Link
        href={href}
        style={{ color: "inherit" }}
        title={
          !sorted
            ? `Sort by ${label.toLowerCase()}`
            : ascending
              ? "Sorted lowest first — click for highest first"
              : "Sorted highest first — click for lowest first"
        }
      >
        {label}{" "}
        <span
          style={{
            color: sorted ? "var(--color-brand-600)" : "var(--text-muted)",
            opacity: sorted ? 1 : 0.45,
          }}
        >
          {sorted ? (ascending ? "▲" : "▼") : "↕"}
        </span>
      </Link>
    </th>
  );
}

export function InvoiceTable({
  rows,
  action,
  canRelease,
  numberSortHref,
  dateSortHref,
  numberSorted,
  numberAscending,
  dateSorted,
  dateAscending,
}: {
  rows: InvoiceListRow[];
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  canRelease: boolean;
  numberSortHref: string;
  dateSortHref: string;
  numberSorted: boolean;
  numberAscending: boolean;
  dateSorted: boolean;
  dateAscending: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((invoice) => {
      const haystack = [
        // Matches both INV-2026-00006 and MOLO-2026-00001: the number is
        // searched as plain text, so neither format is privileged.
        invoice.invoice_no,
        invoice.tenant,
        invoice.location,
        invoice.status.replace("_", " "),
        invoice.invoice_date,
        invoice.due_date,
        formatDate(invoice.invoice_date),
        formatDate(invoice.due_date),
        invoice.total.toFixed(2),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    // terms is derived from query, which is the real dependency.
  }, [rows, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Selection counts only what is on screen: a filtered-out row is not in the
  // form, so counting it would promise to release something that will not be.
  const drafts = shown.filter((row) => row.status === "draft");
  const selected = drafts.filter((row) => picked[row.id]);
  const allPicked = drafts.length > 0 && selected.length === drafts.length;
  const selectedValue = selected.reduce((sum, row) => sum + row.total, 0);

  return (
    <form action={formAction}>
      <div
        className="card-body"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <label className="label" htmlFor="invoice-search">
          Search
        </label>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            id="invoice-search"
            type="search"
            className="input"
            style={{ flex: "1 1 22rem" }}
            value={query}
            autoComplete="off"
            placeholder="Tenant, invoice number, amount or date — e.g. sunrise aug"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter in a search box must not fire the release button.
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          {query ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setQuery("")}
            >
              Clear
            </button>
          ) : null}
        </div>
        <p className="text-xs muted mt-1">
          {terms.length > 0
            ? `${shown.length} of ${rows.length} shown. Narrows as you type.`
            : "Narrows as you type. Every word has to match, so two words narrow it further."}
        </p>
      </div>

      {canRelease && drafts.length > 0 ? (
        <div
          className="card-body flex items-center justify-between gap-3 flex-wrap"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div>
            <p className="text-sm font-semibold">
              {selected.length > 0
                ? `${selected.length} draft(s) selected — ${money(selectedValue)}`
                : "Tick drafts to release them together"}
            </p>
            <p className="text-xs muted">
              Releasing posts each invoice to the ledger and locks it.
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <ReleaseSelected count={selected.length} />
            <Result state={state} />
          </div>
        </div>
      ) : null}

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              {canRelease ? (
                <th style={{ width: "3rem" }}>
                  <input
                    type="checkbox"
                    checked={allPicked}
                    aria-label="Select every draft"
                    disabled={drafts.length === 0}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setPicked(
                        Object.fromEntries(drafts.map((row) => [row.id, on])),
                      );
                    }}
                  />
                </th>
              ) : null}
              <SortHeader
                label="Invoice"
                href={numberSortHref}
                sorted={numberSorted}
                ascending={numberAscending}
              />
              <th>Tenant</th>
              <th>Location</th>
              <SortHeader
                label="Date"
                href={dateSortHref}
                sorted={dateSorted}
                ascending={dateAscending}
              />
              <th>Due</th>
              <th className="text-right">Total</th>
              <th className="text-right">Balance</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((invoice) => (
              <tr key={invoice.id}>
                {canRelease ? (
                  <td>
                    {invoice.status === "draft" ? (
                      <input
                        type="checkbox"
                        name="ids"
                        value={invoice.id}
                        checked={Boolean(picked[invoice.id])}
                        aria-label={`Select ${invoice.invoice_no}`}
                        onChange={(event) => {
                          // Same reason as the location boxes above: the
                          // updater runs after currentTarget is gone.
                          const on = event.currentTarget.checked;
                          setPicked((current) => ({
                            ...current,
                            [invoice.id]: on,
                          }));
                        }}
                      />
                    ) : null}
                  </td>
                ) : null}
                <td>
                  <Link
                    href={`/billing/invoices/${invoice.id}`}
                    className="font-semibold"
                    style={{ color: "var(--color-brand-600)" }}
                  >
                    {invoice.invoice_no}
                  </Link>
                </td>
                <td className="text-sm">{invoice.tenant}</td>
                <td>
                  <span className="badge">{invoice.location}</span>
                </td>
                <td className="text-xs">{formatDate(invoice.invoice_date)}</td>
                <td className="text-xs">
                  {formatDate(invoice.due_date)}
                  {invoice.isOverdue ? (
                    <p style={{ color: "var(--danger)" }}>overdue</p>
                  ) : null}
                </td>
                <td className="text-right tabular-nums">{money(invoice.total)}</td>
                <td className="text-right tabular-nums">
                  {invoice.status === "cancelled" ? "—" : money(invoice.balance)}
                </td>
                <td>
                  <span className={STATUS_BADGE[invoice.status] ?? "badge"}>
                    {invoice.status.replace("_", " ")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length === 0 ? (
        <div className="card-body">
          <p className="text-sm muted" style={{ textAlign: "center" }}>
            No invoice matches &ldquo;{query}&rdquo;.
          </p>
        </div>
      ) : null}
    </form>
  );
}

function ReleaseSelected({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary"
      disabled={pending || count === 0}
    >
      {pending ? "Releasing…" : `Release ${count > 0 ? count : ""} selected`}
    </button>
  );
}
