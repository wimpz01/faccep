"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

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

/**
 * Bulk import from a spreadsheet.
 *
 * The file is read in the browser and posted as text, which keeps the action a
 * plain form submission rather than a multipart upload.
 */
export function ImportItemsForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="csv" value={csv} />

      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="label" htmlFor="import-file">
            Spreadsheet (.csv)
          </label>
          <input
            id="import-file"
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
        <a
          href="/inventory/export?template=1"
          className="btn btn-secondary btn-sm"
        >
          Download template
        </a>
      </div>

      <div>
        <label className="label" htmlFor="import-csv">
          {fileName ? `From ${fileName} — check it, then import` : "Or paste the rows"}
        </label>
        <textarea
          id="import-csv"
          className="textarea"
          rows={fileName ? 6 : 3}
          placeholder={"name,category,unit_of_measure,reorder_level,unit_cost\nPortland cement 40kg,Construction,bag,20,285"}
          value={csv}
          onChange={(event) => setCsv(event.currentTarget.value)}
        />
        <p className="text-xs muted mt-1">
          First row is the header. <strong>name</strong> and{" "}
          <strong>unit_of_measure</strong> are required; category is created if it
          is new. Codes are issued automatically, so leave sku out.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Import items" />
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

export function ItemForm({
  action,
  categories,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  categories: CategoryOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    /* What identifies the item goes on top in full-width fields, since a SKU
       and a name are long; the numbers that describe it pair up underneath. */
    <form action={formAction} className="grid gap-4 sm:grid-cols-6">
      <div className="sm:col-span-6">
        <label className="label" htmlFor="item-sku">
          SKU #
        </label>
        <input
          id="item-sku"
          className="input"
          placeholder="Issued on save"
          disabled
        />
      </div>
      <div className="sm:col-span-6">
        <label className="label" htmlFor="item-name">
          Item name *
        </label>
        <input id="item-name" name="name" className="input" required />
      </div>

      <div className="sm:col-span-3">
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
      <div className="sm:col-span-3">
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

      <div className="sm:col-span-3">
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
      <div className="sm:col-span-3">
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

      <div className="sm:col-span-6 flex items-center gap-3 flex-wrap">
        <Submit label="Add item" />
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
