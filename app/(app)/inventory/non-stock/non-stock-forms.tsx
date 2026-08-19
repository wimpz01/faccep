"use client";

import { useActionState, useState } from "react";
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


/**
 * The item's code, which opens the item.
 *
 * Editing happens over the page rather than inside the row. Inline forms grew
 * the row taller than everything around it and spilled past the table's edge,
 * so the list stopped being readable at exactly the moment somebody was trying
 * to correct it. The list now shows only what it is for -- reading -- and the
 * code is the way in.
 */
export function NonStockEditor({
  action,
  item,
  accounts,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  item: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    unit_of_measure: string;
    default_cost: string;
    expense_account_id: string | null;
  };
  accounts: AccountOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs tabular-nums font-semibold"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--color-brand-600)",
        }}
        title={`Edit ${item.code}`}
      >
        {item.code}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${item.code}`}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "3rem 1rem",
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <form
            action={formAction}
            className="card"
            style={{ width: "min(34rem, 100%)", textAlign: "left" }}
          >
            <div className="card-header">
              <div>
                <h2 className="font-semibold text-sm">{item.code}</h2>
                <p className="text-xs muted mt-0.5">
                  The code stays as it is — orders and bills already refer to it.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="card-body grid gap-3">
              <input type="hidden" name="id" value={item.id} />

              <div>
                <label className="label" htmlFor={`ns-name-${item.id}`}>
                  Item *
                </label>
                <input
                  id={`ns-name-${item.id}`}
                  name="name"
                  className="input"
                  required
                  autoFocus
                  defaultValue={item.name}
                />
              </div>

              <div>
                <label className="label" htmlFor={`ns-desc-${item.id}`}>
                  Description
                </label>
                <input
                  id={`ns-desc-${item.id}`}
                  name="description"
                  className="input"
                  defaultValue={item.description ?? ""}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor={`ns-unit-${item.id}`}>
                    Unit *
                  </label>
                  <input
                    id={`ns-unit-${item.id}`}
                    name="unit_of_measure"
                    className="input"
                    required
                    defaultValue={item.unit_of_measure}
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`ns-cost-${item.id}`}>
                    Usual cost (₱)
                  </label>
                  <input
                    id={`ns-cost-${item.id}`}
                    name="default_cost"
                    type="number"
                    step="0.01"
                    min="0"
                    className="input tabular-nums"
                    style={{ textAlign: "right" }}
                    defaultValue={item.default_cost}
                  />
                </div>
              </div>

              <div>
                <label className="label" htmlFor={`ns-account-${item.id}`}>
                  Charged to *
                </label>
                <select
                  id={`ns-account-${item.id}`}
                  name="expense_account_id"
                  className="select"
                  required
                  defaultValue={item.expense_account_id ?? ""}
                >
                  <option value="">Choose an account…</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs muted mt-1">
                  Applies to what is bought from now on. Bills already raised
                  keep the account they were charged to.
                </p>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <Submit label="Save changes" />
                <Result state={state} />
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
