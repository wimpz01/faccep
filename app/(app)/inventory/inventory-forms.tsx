"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

export type ItemOption = {
  id: string;
  name: string;
  unit_of_measure: string;
  quantity_on_hand: string;
};
export type CategoryOption = { id: string; name: string };
export type ToolOption = { id: string; name: string };

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

export function CategoryForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-end gap-3 flex-wrap">
      <div style={{ minWidth: "16rem" }}>
        <label className="label" htmlFor="category-name">
          Category name
        </label>
        <input
          id="category-name"
          name="name"
          className="input"
          required
          placeholder="Electrical supplies"
        />
      </div>
      <Submit label="Add category" />
      <Result state={state} />
    </form>
  );
}

export function ItemForm({
  action,
  categories,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  categories: CategoryOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="item-name">
          Item name *
        </label>
        <input id="item-name" name="name" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="item-category">
          Category
        </label>
        <select id="item-category" name="category_id" className="select" defaultValue="">
          <option value="">Uncategorised</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="item-sku">
          SKU
        </label>
        <input id="item-sku" name="sku" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="item-uom">
          Unit of measure *
        </label>
        <input
          id="item-uom"
          name="unit_of_measure"
          className="input"
          defaultValue="pc"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="item-reorder">
          Reorder level
        </label>
        <input
          id="item-reorder"
          name="reorder_level"
          type="number"
          step="0.001"
          min="0"
          className="input"
          defaultValue="0"
        />
      </div>
      <div>
        <label className="label" htmlFor="item-cost">
          Unit cost (₱)
        </label>
        <input
          id="item-cost"
          name="unit_cost"
          type="number"
          step="0.0001"
          min="0"
          className="input"
          defaultValue="0"
        />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Add item" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function MovementForm({
  action,
  items,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  items: ItemOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [kind, setKind] = useState("receipt");
  const [itemId, setItemId] = useState("");

  const item = items.find((candidate) => candidate.id === itemId);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <div>
        <label className="label" htmlFor="movement-item">
          Item *
        </label>
        <select
          id="movement-item"
          name="item_id"
          className="select"
          required
          value={itemId}
          onChange={(event) => setItemId(event.currentTarget.value)}
        >
          <option value="">Choose…</option>
          {items.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name} ({Number(option.quantity_on_hand)} {option.unit_of_measure})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="movement-kind">
          Movement *
        </label>
        <select
          id="movement-kind"
          name="movement_kind"
          className="select"
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value)}
        >
          <option value="receipt">Receipt — into stock</option>
          <option value="issue">Issue — out to a job</option>
          <option value="return">Return — unused, back to stock</option>
          <option value="adjustment">Adjustment — stock count</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor="movement-qty">
          Quantity *
        </label>
        <input
          id="movement-qty"
          name="quantity"
          type="number"
          step="0.001"
          min="0.001"
          className="input"
          required
        />
        {item ? (
          <p className="text-xs muted mt-1">
            {Number(item.quantity_on_hand)} {item.unit_of_measure} on hand
          </p>
        ) : null}
      </div>

      {kind === "adjustment" ? (
        <div>
          <label className="label" htmlFor="adjust-direction">
            Direction
          </label>
          <select
            id="adjust-direction"
            name="adjust_direction"
            className="select"
            defaultValue="up"
          >
            <option value="up">Increase</option>
            <option value="down">Decrease</option>
          </select>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="movement-note">
            Note
          </label>
          <input id="movement-note" name="note" className="input" />
        </div>
      )}

      <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
        <Submit label="Record movement" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function ToolForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="tool-name">
          Tool name *
        </label>
        <input id="tool-name" name="name" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="tool-serial">
          Serial number
        </label>
        <input id="tool-serial" name="serial_no" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="tool-condition">
          Condition
        </label>
        <input
          id="tool-condition"
          name="condition"
          className="input"
          placeholder="Good"
        />
      </div>
      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Add tool" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function BorrowForm({
  action,
  tools,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  tools: ToolOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <div>
        <label className="label" htmlFor="borrow-tool">
          Tool *
        </label>
        <select id="borrow-tool" name="tool_id" className="select" required defaultValue="">
          <option value="">Choose…</option>
          {tools.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="borrow-name">
          Borrower *
        </label>
        <input id="borrow-name" name="borrower_name" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="borrow-return">
          Expected return
        </label>
        <input
          id="borrow-return"
          name="expected_return"
          type="date"
          className="input"
        />
      </div>
      <div>
        <label className="label" htmlFor="borrow-condition">
          Condition out
        </label>
        <input id="borrow-condition" name="condition_out" className="input" />
      </div>
      <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
        <Submit label="Issue tool" />
        <Result state={state} />
      </div>
    </form>
  );
}
