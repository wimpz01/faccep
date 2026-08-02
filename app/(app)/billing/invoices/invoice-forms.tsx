"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { formatDate, money } from "@/lib/format";

import { STATUS_BADGE } from "./constants";

import type { ActionState } from "./actions";

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

export function GenerateForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

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

      <div className="sm:col-span-2 flex items-end gap-3 flex-wrap pb-1">
        <Submit label="Generate drafts" />
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
export function InvoiceTable({
  rows,
  action,
  canRelease,
}: {
  rows: InvoiceListRow[];
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  canRelease: boolean;
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
        invoice.invoice_no,
        invoice.tenant,
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
              <th>Invoice</th>
              <th>Tenant</th>
              <th>Date</th>
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
                        onChange={(event) =>
                          setPicked((current) => ({
                            ...current,
                            [invoice.id]: event.currentTarget.checked,
                          }))
                        }
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
