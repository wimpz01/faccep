"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "../actions";

export type AccountOption = { id: string; code: string; name: string };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
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
 * Sets up one non-stock item.
 *
 * The account is asked for here rather than on every purchase line, which is
 * the whole point: set it once and the same service is charged to the same
 * place every time, by whoever raises the order.
 */
export function NonStockItemForm({
  action,
  accounts,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  accounts: AccountOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-6">
      <div className="sm:col-span-6">
        <label className="label" htmlFor="ns-code">
          Item code
        </label>
        <input id="ns-code" className="input" placeholder="Issued on save" disabled />
      </div>

      <div className="sm:col-span-6">
        <label className="label" htmlFor="ns-name">
          Item name *
        </label>
        <input
          id="ns-name"
          name="name"
          className="input"
          required
          placeholder="Security services"
        />
      </div>

      <div className="sm:col-span-6">
        <label className="label" htmlFor="ns-description">
          Description
        </label>
        <input
          id="ns-description"
          name="description"
          className="input"
          placeholder="Monthly guard service, two posts"
        />
      </div>

      <div className="sm:col-span-6">
        <label className="label" htmlFor="ns-account">
          Expense account *
        </label>
        <select
          id="ns-account"
          name="expense_account_id"
          className="select"
          required
          defaultValue=""
        >
          <option value="" disabled>
            Choose where it is charged…
          </option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} — {account.name}
            </option>
          ))}
        </select>
        <p className="text-xs muted mt-1">
          Every purchase of this item is charged here, so it never has to be
          picked again on a line.
        </p>
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="ns-uom">
          Unit of measure *
        </label>
        <input
          id="ns-uom"
          name="unit_of_measure"
          className="input"
          defaultValue="lot"
          required
        />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="ns-cost">
          Usual cost (₱)
        </label>
        <input
          id="ns-cost"
          name="default_cost"
          type="number"
          step="0.0001"
          min="0"
          className="input"
          defaultValue="0"
        />
      </div>

      <div className="sm:col-span-6 flex items-center gap-3 flex-wrap">
        <Submit label="Add non-stock item" />
        <Result state={state} />
      </div>
    </form>
  );
}

/** Repoints one record at a different account, from its row in the list. */
export function AccountPicker({
  action,
  idField,
  idValue,
  fieldName,
  accounts,
  current,
  allowNone,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  idField: string;
  idValue: string;
  fieldName: string;
  accounts: AccountOption[];
  current: string | null;
  allowNone?: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex items-center gap-2 flex-wrap">
      <input type="hidden" name={idField} value={idValue} />
      <select
        name={fieldName}
        className="select"
        defaultValue={current ?? ""}
        style={{ minWidth: "14rem" }}
      >
        {allowNone ? <option value="">Company default</option> : null}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} — {account.name}
          </option>
        ))}
      </select>
      <Submit label="Save" />
      <Result state={state} />
    </form>
  );
}
