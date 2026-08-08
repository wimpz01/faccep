"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

export type CategoryChoice = { id: string; name: string };
export type AccountChoice = { id: string; code: string; name: string };

export type ItemSettings = {
  id: string;
  sku: string | null;
  name: string;
  category_id: string | null;
  unit_of_measure: string;
  reorder_level: string;
  unit_cost: string;
  is_active: boolean;
  inventory_account_id: string | null;
  adjustment_account_id: string | null;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Save changes"}
    </button>
  );
}

/**
 * An item's own setup: what it is, how it is counted, and where it belongs in
 * the accounts.
 *
 * What is on hand is not here on purpose -- that comes from the movement
 * ledger, and a box to type it into would let the two disagree.
 */
export function ItemSettingsForm({
  action,
  item,
  categories,
  assetAccounts,
  expenseAccounts,
  averageCost,
  canEdit,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  item: ItemSettings;
  categories: CategoryChoice[];
  assetAccounts: AccountChoice[];
  expenseAccounts: AccountChoice[];
  averageCost: string | null;
  canEdit: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-6">
      <input type="hidden" name="item_id" value={item.id} />

      <div className="sm:col-span-2">
        <label className="label" htmlFor="settings-sku">
          SKU #
        </label>
        <input
          id="settings-sku"
          className="input"
          value={item.sku ?? "—"}
          disabled
          readOnly
        />
        <p className="text-xs muted mt-1">Issued on save; never changes.</p>
      </div>

      <div className="sm:col-span-4">
        <label className="label" htmlFor="settings-name">
          Item name *
        </label>
        <input
          id="settings-name"
          name="name"
          className="input"
          defaultValue={item.name}
          required
          disabled={!canEdit}
        />
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="settings-category">
          Category
        </label>
        <select
          id="settings-category"
          name="category_id"
          className="select"
          defaultValue={item.category_id ?? ""}
          disabled={!canEdit}
        >
          <option value="">Uncategorised</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="settings-uom">
          Unit of measure *
        </label>
        <input
          id="settings-uom"
          name="unit_of_measure"
          className="input"
          defaultValue={item.unit_of_measure}
          required
          disabled={!canEdit}
        />
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="settings-reorder">
          Reorder level
        </label>
        <input
          id="settings-reorder"
          name="reorder_level"
          type="number"
          step="0.001"
          min="0"
          className="input"
          defaultValue={Number(item.reorder_level)}
          disabled={!canEdit}
        />
        <p className="text-xs muted mt-1">
          Zero means it never shows as needing replenishing.
        </p>
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="settings-cost">
          Standing unit cost (₱)
        </label>
        <input
          id="settings-cost"
          name="unit_cost"
          type="number"
          step="0.0001"
          min="0"
          className="input"
          defaultValue={Number(item.unit_cost)}
          disabled={!canEdit}
        />
        <p className="text-xs muted mt-1">
          {averageCost
            ? `Stock is valued at the average actually paid (₱${averageCost}). This figure is only used before anything has been received.`
            : "Used to value stock until the item has been received at a real price."}
        </p>
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="settings-stock-account">
          Held in
        </label>
        <select
          id="settings-stock-account"
          name="inventory_account_id"
          className="select"
          defaultValue={item.inventory_account_id ?? ""}
          disabled={!canEdit}
        >
          <option value="">Company default</option>
          {assetAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} — {account.name}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="settings-adjustment-account">
          Adjustments charged to
        </label>
        <select
          id="settings-adjustment-account"
          name="adjustment_account_id"
          className="select"
          defaultValue={item.adjustment_account_id ?? ""}
          disabled={!canEdit}
        >
          <option value="">Company default</option>
          {expenseAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} — {account.name}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="is_active"
            defaultChecked={item.is_active}
            className="h-4 w-4 accent-[var(--color-brand-600)]"
            disabled={!canEdit}
          />
          Active — appears in lists and can be bought, issued and adjusted
        </label>
      </div>

      {canEdit ? (
        <div className="sm:col-span-6 flex items-center gap-3 flex-wrap">
          <Submit />
          <FormError message={state.error} />
          {state.success ? (
            <p className="text-sm" style={{ color: "var(--success)" }}>
              {state.success}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="sm:col-span-6 text-xs muted">
          Changing an item needs Edit on inventory items.
        </p>
      )}
    </form>
  );
}
