"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";

export type AccountOption = {
  id: string;
  code: string;
  name: string;
  account_type: string;
};

export const ACCOUNT_TYPES = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
] as const;

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

export function SeedChartForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <Submit label="Install standard chart" />
      <Result state={state} />
    </form>
  );
}

export function AccountForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <div>
        <label className="label" htmlFor="acct-code">
          Code *
        </label>
        <input id="acct-code" name="code" className="input" required placeholder="4400" />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="acct-name">
          Name *
        </label>
        <input id="acct-name" name="name" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="acct-type">
          Type *
        </label>
        <select id="acct-type" name="account_type" className="select" defaultValue="expense">
          {ACCOUNT_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
        <Submit label="Add account" />
        <Result state={state} />
      </div>
    </form>
  );
}

type JournalLine = { accountId: string; description: string; debit: string; credit: string };

const EMPTY_LINE: JournalLine = { accountId: "", description: "", debit: "", credit: "" };

export function JournalEntryForm({
  action,
  accounts,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  accounts: AccountOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [lines, setLines] = useState<JournalLine[]>([
    EMPTY_LINE,
    EMPTY_LINE,
  ]);

  function update(index: number, patch: Partial<JournalLine>) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  const totalDebit = round2(
    lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0),
  );
  const totalCredit = round2(
    lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0),
  );
  const balanced = totalDebit === totalCredit && totalDebit > 0;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="je-date">
            Entry date *
          </label>
          <input
            id="je-date"
            name="entry_date"
            type="date"
            className="input"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="je-memo">
            Memo
          </label>
          <input id="je-memo" name="memo" className="input" />
        </div>
      </div>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ minWidth: "16rem" }}>Account</th>
              <th>Description</th>
              <th className="text-right" style={{ width: "9rem" }}>
                Debit
              </th>
              <th className="text-right" style={{ width: "9rem" }}>
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>
                  <select
                    name="jl_account"
                    className="select"
                    value={line.accountId}
                    onChange={(event) =>
                      update(index, { accountId: event.currentTarget.value })
                    }
                  >
                    <option value="">Choose…</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} — {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    name="jl_desc"
                    className="input"
                    value={line.description}
                    onChange={(event) =>
                      update(index, { description: event.currentTarget.value })
                    }
                  />
                </td>
                <td>
                  <input
                    name="jl_debit"
                    type="number"
                    step="0.01"
                    min="0"
                    className="input tabular-nums"
                    style={{ textAlign: "right" }}
                    value={line.debit}
                    onChange={(event) =>
                      update(index, {
                        debit: event.currentTarget.value,
                        credit: event.currentTarget.value ? "" : line.credit,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    name="jl_credit"
                    type="number"
                    step="0.01"
                    min="0"
                    className="input tabular-nums"
                    style={{ textAlign: "right" }}
                    value={line.credit}
                    onChange={(event) =>
                      update(index, {
                        credit: event.currentTarget.value,
                        debit: event.currentTarget.value ? "" : line.debit,
                      })
                    }
                  />
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="text-right font-semibold">
                Totals
              </td>
              <td className="text-right tabular-nums font-semibold">
                {money(totalDebit)}
              </td>
              <td
                className="text-right tabular-nums font-semibold"
                style={{ color: balanced ? "var(--success)" : "var(--danger)" }}
              >
                {money(totalCredit)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setLines([...lines, EMPTY_LINE])}
        >
          Add line
        </button>
        {!balanced ? (
          <span className="text-xs muted">
            Debits and credits must be equal before this can be saved.
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Save draft entry" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function PostForm({
  action,
  entryId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  entryId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="id" value={entryId} />
      <Submit label="Post to the ledger" />
      <Result state={state} />
    </form>
  );
}

export function CancelDraftEntryForm({
  action,
  entryId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  entryId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={entryId} />
      <div>
        <label className="label" htmlFor="cancel-entry-reason">
          Reason *
        </label>
        <input
          id="cancel-entry-reason"
          name="reason"
          className="input"
          required
          placeholder="Raised in error"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Cancel this draft" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ReverseForm({
  action,
  entryId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  entryId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={entryId} />
      <div>
        <label className="label" htmlFor="reverse-reason">
          Reason *
        </label>
        <input
          id="reverse-reason"
          name="reason"
          className="input"
          required
          placeholder="Posted to the wrong account"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Reverse entry" danger />
        <Result state={state} />
      </div>
    </form>
  );
}

export type ReadinessRow = {
  severity: string;
  kind: string;
  item_count: number;
  detail: string;
};

/**
 * Close/reopen control that shows the readiness checklist inline, so the
 * reason a period will not close is visible before the button is pressed.
 */
export function PeriodStatusForm({
  action,
  periodId,
  periodName,
  status,
  readiness,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  periodId: string;
  periodName: string;
  status: string;
  readiness: ReadinessRow[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const blockers = readiness.filter((row) => row.severity === "blocker");
  const warnings = readiness.filter((row) => row.severity === "warning");
  const isOpen = status === "open";

  return (
    <div className="flex flex-col gap-2">
      {isOpen && readiness.length > 0 ? (
        <ul className="flex flex-col gap-1" style={{ minWidth: "18rem" }}>
          {blockers.map((row) => (
            <li key={row.kind} className="text-xs">
              <span className="badge" style={{ color: "var(--danger)" }}>
                blocks close
              </span>{" "}
              <strong>
                {row.kind} ({row.item_count})
              </strong>
              <p className="muted">{row.detail}</p>
            </li>
          ))}
          {warnings.map((row) => (
            <li key={row.kind} className="text-xs">
              <span className="badge">note</span>{" "}
              {row.kind} ({row.item_count})
              <p className="muted">{row.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {isOpen && blockers.length === 0 && warnings.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--success)" }}>
          Nothing outstanding — ready to close.
        </p>
      ) : null}

      <form action={formAction} className="flex items-center gap-2 flex-wrap">
        <input type="hidden" name="id" value={periodId} />
        <input type="hidden" name="status" value={isOpen ? "closed" : "open"} />
        <CloseButton
          label={isOpen ? `Close ${periodName}` : `Reopen ${periodName}`}
          blocked={isOpen && blockers.length > 0}
        />
      </form>

      <FormError message={state.error} />
      {state.success ? (
        <p className="text-xs" style={{ color: "var(--success)" }}>
          {state.success}
        </p>
      ) : null}
    </div>
  );
}

function CloseButton({ label, blocked }: { label: string; blocked: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-secondary btn-sm"
      disabled={pending || blocked}
      title={blocked ? "Clear the blocking items first" : undefined}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function PeriodForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <div>
        <label className="label" htmlFor="period-name">
          Name
        </label>
        <input id="period-name" name="name" className="input" placeholder="2026-07" />
      </div>
      <div>
        <label className="label" htmlFor="period-start">
          From *
        </label>
        <input
          id="period-start"
          name="start_date"
          type="date"
          className="input"
          required
          defaultValue={first}
        />
      </div>
      <div>
        <label className="label" htmlFor="period-end">
          To *
        </label>
        <input
          id="period-end"
          name="end_date"
          type="date"
          className="input"
          required
          defaultValue={last}
        />
      </div>
      <div className="flex items-end gap-3 flex-wrap pb-1">
        <Submit label="Open period" />
      </div>
      <div className="sm:col-span-4">
        <Result state={state} />
      </div>
    </form>
  );
}
