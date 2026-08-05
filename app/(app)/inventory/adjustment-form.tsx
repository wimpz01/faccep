"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

export type AdjustItem = {
  id: string;
  name: string;
  sku: string | null;
  unit_of_measure: string;
  quantity_on_hand: string;
  unit_cost: string;
};

export type ExistingLine = {
  item_id: string;
  quantity: string;
  unit_cost: string | null;
  note: string | null;
};

type Line = {
  key: number;
  itemId: string;
  /** What has been typed into the SKU box: a code, or part of a name. */
  search: string;
  open: boolean;
  direction: string;
  quantity: string;
  unitCost: string;
  note: string;
};

const blank = (key: number): Line => ({
  key,
  itemId: "",
  search: "",
  open: false,
  direction: "up",
  quantity: "",
  unitCost: "",
  note: "",
});

function Buttons({ hasId }: { hasId: boolean }) {
  const { pending } = useFormStatus();
  return (
    <>
      <button
        type="submit"
        name="intent"
        value="save"
        className="btn btn-secondary"
        disabled={pending}
      >
        {pending ? "Working…" : hasId ? "Save changes" : "Save as draft"}
      </button>
      <button
        type="submit"
        name="intent"
        value="post"
        className="btn btn-primary"
        disabled={pending}
      >
        {pending ? "Working…" : "Post adjustment"}
      </button>
    </>
  );
}

/** Matches on SKU and name together, so either one finds the item. */
function matches(item: AdjustItem, search: string) {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${item.sku ?? ""} ${item.name}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * One adjustment: a type, a reason, and as many lines as the count needed.
 *
 * Saving and posting are different things. A draft holds its lines and moves
 * no stock, so a count can be written down, left, and thought about; posting
 * is what writes the ledger, and once posted the document is closed.
 */
export function AdjustmentForm({
  action,
  items,
  adjustmentId,
  initialKind = "adjustment",
  initialDate,
  initialReason = "",
  initialLines = [],
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  items: AdjustItem[];
  adjustmentId?: string;
  initialKind?: string;
  initialDate?: string;
  initialReason?: string;
  initialLines?: ExistingLine[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [kind, setKind] = useState(initialKind);

  const seed: Line[] =
    initialLines.length > 0
      ? initialLines.map((line, index) => {
          const item = items.find((option) => option.id === line.item_id);
          const quantity = Number(line.quantity);
          return {
            key: index + 1,
            itemId: line.item_id,
            search: item?.sku ?? item?.name ?? "",
            open: false,
            direction: quantity < 0 ? "down" : "up",
            quantity: String(Math.abs(quantity)),
            unitCost: line.unit_cost ? String(Number(line.unit_cost)) : "",
            note: line.note ?? "",
          };
        })
      : [blank(1)];

  const [lines, setLines] = useState<Line[]>(seed);
  const [nextKey, setNextKey] = useState(seed.length + 1);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);

  const update = (key: number, patch: Partial<Line>) =>
    setLines((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );

  const filled = (line: Line, option: AdjustItem): Line => ({
    ...line,
    itemId: option.id,
    search: option.sku ?? option.name,
    open: false,
    unitCost: String(Number(option.unit_cost)),
  });

  /**
   * Puts one item on the sheet.
   *
   * An item already on a line stays on that one line -- the same thing counted
   * twice is one correction, not two -- so this only says so and stops there.
   * Otherwise it fills the first empty line, or adds one.
   */
  const addMany = (options: AdjustItem[]) => {
    let key = nextKey;

    setLines((rows) => {
      const out = [...rows];
      for (const option of options) {
        if (out.some((row) => row.itemId === option.id)) continue;
        const at = out.findIndex((row) => !row.itemId);
        if (at >= 0) out[at] = filled(out[at], option);
        else out.push(filled(blank(key++), option));
      }
      return out;
    });
    setNextKey(key + options.length);

    // Worked out from the state this render can see, because the updater above
    // does not run until React re-renders.
    const already = options.filter((option) =>
      lines.some((row) => row.itemId === option.id),
    );
    const added = options.length - already.length;
    setFlash(
      already.length === 1 && added === 0
        ? `${already[0].name} is already on the sheet.`
        : `${added} added${already.length > 0 ? `, ${already.length} already there` : ""}.`,
    );
  };

  const addItem = (option: AdjustItem) => addMany([option]);

  const addTicked = () => {
    addMany(items.filter((item) => ticked.includes(item.id)));
    setTicked([]);
    setPickerOpen(false);
  };

  const itemById = new Map(items.map((item) => [item.id, item]));
  const picked = items.filter((item) => matches(item, pickerSearch));
  const onSheet = new Set(lines.map((line) => line.itemId).filter(Boolean));
  // Only a count correction can go either way; the rest have one direction.
  const showsDirection = kind === "adjustment";

  return (
    <form action={formAction} className="grid gap-4">
      {adjustmentId ? (
        <input type="hidden" name="adjustment_id" value={adjustmentId} />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <p className="label">Adjustment #</p>
          <input className="input" placeholder="Issued on save" disabled readOnly />
        </div>
        <div>
          <label className="label" htmlFor="adjustment-kind">
            Type *
          </label>
          <select
            id="adjustment-kind"
            name="movement_kind"
            className="select"
            value={kind}
            onChange={(event) => setKind(event.currentTarget.value)}
          >
            <option value="adjustment">Count correction</option>
            <option value="receipt">Receipt — in</option>
            <option value="return">Return — in</option>
            <option value="issue">Issue — out</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="adjustment-date">
            Date
          </label>
          <input
            id="adjustment-date"
            name="adjustment_date"
            type="date"
            className="input"
            defaultValue={initialDate ?? new Date().toISOString().slice(0, 10)}
          />
        </div>
        <div>
          <label className="label" htmlFor="adjustment-reason">
            Reason *
          </label>
          <input
            id="adjustment-reason"
            name="reason"
            className="input"
            required
            defaultValue={initialReason}
            placeholder="Annual stock count"
          />
        </div>
      </div>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ minWidth: "13rem" }}>SKU #</th>
              <th style={{ minWidth: "18rem" }}>Item</th>
              <th>On hand</th>
              <th style={{ width: showsDirection ? "13rem" : "8rem" }}>Quantity</th>
              <th style={{ width: "8rem" }}>Unit cost</th>
              <th style={{ minWidth: "15rem" }}>Note</th>
              <th style={{ width: "3rem" }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const item = itemById.get(line.itemId);
              const found = line.open
                ? items.filter((option) => matches(option, line.search)).slice(0, 8)
                : [];

              return (
                <tr key={line.key}>
                  <td style={{ position: "relative" }}>
                    <input type="hidden" name="line_item_id" value={line.itemId} />
                    <div className="flex gap-1 items-center">
                      <input
                        className="input"
                        value={line.search}
                        autoComplete="off"
                        placeholder="Type a SKU or item name"
                        onFocus={() => update(line.key, { open: true })}
                        onBlur={() =>
                          setTimeout(() => update(line.key, { open: false }), 150)
                        }
                        onChange={(event) =>
                          update(line.key, {
                            search: event.currentTarget.value,
                            itemId: "",
                            open: true,
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && found.length > 0) {
                            event.preventDefault();
                            update(line.key, {
                              ...filled(line, found[0]),
                              key: line.key,
                            });
                          }
                          if (event.key === "Escape") update(line.key, { open: false });
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        title="Browse the item list"
                        aria-label="Browse the item list"
                        onClick={() => {
                          setPickerOpen(true);
                          setPickerSearch("");
                          setTicked([]);
                          setFlash(null);
                        }}
                      >
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          aria-hidden="true"
                        >
                          <circle cx="11" cy="11" r="7" />
                          <line x1="16.5" y1="16.5" x2="21" y2="21" />
                        </svg>
                      </button>
                    </div>
                    {line.open && found.length > 0 ? (
                      <ul
                        className="card"
                        style={{
                          position: "absolute",
                          zIndex: 20,
                          top: "100%",
                          left: 0,
                          right: 0,
                          margin: 0,
                          padding: "0.25rem",
                          listStyle: "none",
                          maxHeight: "14rem",
                          overflowY: "auto",
                        }}
                      >
                        {found.map((option) => (
                          <li key={option.id}>
                            <button
                              type="button"
                              className="w-full text-left text-sm"
                              style={{
                                padding: "0.35rem 0.5rem",
                                borderRadius: "0.25rem",
                                background: "transparent",
                                border: 0,
                                cursor: "pointer",
                              }}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                update(line.key, {
                                  ...filled(line, option),
                                  key: line.key,
                                });
                              }}
                            >
                              <span className="tabular-nums muted">
                                {option.sku ?? "no SKU"}
                              </span>{" "}
                              {option.name}
                              <span className="text-xs muted">
                                {" "}
                                · {Number(option.quantity_on_hand)}{" "}
                                {option.unit_of_measure}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className="text-sm">
                    {item ? item.name : <span className="muted">—</span>}
                  </td>
                  <td className="text-xs tabular-nums">
                    {item
                      ? `${Number(item.quantity_on_hand)} ${item.unit_of_measure}`
                      : "—"}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {showsDirection ? (
                        <select
                          name="line_direction"
                          className="select"
                          style={{ width: "5.25rem", flex: "0 0 auto" }}
                          value={line.direction}
                          onChange={(event) =>
                            update(line.key, { direction: event.currentTarget.value })
                          }
                        >
                          <option value="up">+</option>
                          <option value="down">−</option>
                        </select>
                      ) : (
                        <input type="hidden" name="line_direction" value="up" />
                      )}
                      <input
                        name="line_quantity"
                        type="number"
                        step="0.001"
                        min="0"
                        className="input"
                        style={{ width: "6.5rem" }}
                        value={line.quantity}
                        onChange={(event) =>
                          update(line.key, { quantity: event.currentTarget.value })
                        }
                        placeholder="0"
                      />
                    </div>
                  </td>
                  <td>
                    <input
                      name="line_unit_cost"
                      type="number"
                      step="0.0001"
                      min="0"
                      className="input"
                      value={line.unitCost}
                      onChange={(event) =>
                        update(line.key, { unitCost: event.currentTarget.value })
                      }
                      placeholder="0.00"
                    />
                  </td>
                  <td>
                    <input
                      name="line_note"
                      className="input"
                      value={line.note}
                      onChange={(event) =>
                        update(line.key, { note: event.currentTarget.value })
                      }
                      placeholder="Optional"
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      title="Remove this line"
                      aria-label="Remove this line"
                      onClick={() =>
                        setLines((rows) => {
                          const left = rows.filter((row) => row.key !== line.key);
                          // Never leave the sheet with nothing to type into.
                          return left.length > 0 ? left : [blank(nextKey)];
                        })
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            setLines((rows) => [...rows, blank(nextKey)]);
            setNextKey((key) => key + 1);
          }}
        >
          + Add line
        </button>
        <Buttons hasId={Boolean(adjustmentId)} />
        <Link href="/inventory/adjustments" className="btn btn-secondary">
          Cancel
        </Link>
        <FormError message={state.error} />
        {state.success ? (
          <p className="text-sm" style={{ color: "var(--success)" }}>
            {state.success}
          </p>
        ) : null}
      </div>
      <p className="text-xs muted">
        Saving keeps it as a draft and moves no stock. Posting writes it to the
        ledger, and a posted adjustment cannot be taken back.
      </p>

      {pickerOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose an item"
          onClick={() => setPickerOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "rgba(15, 18, 26, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "3rem 1rem",
          }}
        >
          <div
            className="card"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(46rem, 100%)",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div className="card-body" style={{ paddingBottom: "0.75rem" }}>
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h3 className="font-semibold">Choose an item</h3>
                  <p className="text-xs muted">
                    Double-click to add it and keep going. The window stays open.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPickerOpen(false)}
                >
                  Close
                </button>
              </div>
              <input
                className="input"
                autoFocus
                autoComplete="off"
                value={pickerSearch}
                placeholder="SKU or item name"
                onChange={(event) => setPickerSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  // Enter would otherwise submit the adjustment behind this.
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (picked.length > 0) addItem(picked[0]);
                  }
                  if (event.key === "Escape") setPickerOpen(false);
                }}
              />
              {flash ? (
                <p className="text-xs mt-2" style={{ color: "var(--color-brand-600)" }}>
                  {flash}
                </p>
              ) : null}
            </div>

            <div
              className="table-scroll"
              style={{ overflowY: "auto", userSelect: "none" }}
            >
              {picked.length > 0 ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: "2.5rem" }} />
                      <th>SKU #</th>
                      <th>Item</th>
                      <th className="text-right">On hand</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {picked.map((option) => {
                      const already = onSheet.has(option.id);
                      return (
                        <tr
                          key={option.id}
                          onDoubleClick={() => addItem(option)}
                          style={{ cursor: "pointer" }}
                        >
                          <td>
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--color-brand-600)]"
                              aria-label={`Select ${option.name}`}
                              checked={ticked.includes(option.id)}
                              onChange={(event) => {
                                const on = event.currentTarget.checked;
                                setTicked((ids) =>
                                  on
                                    ? [...ids, option.id]
                                    : ids.filter((id) => id !== option.id),
                                );
                              }}
                            />
                          </td>
                          <td className="text-xs tabular-nums muted">
                            {option.sku ?? "—"}
                          </td>
                          <td className="text-sm">
                            {option.name}
                            {already ? (
                              <span className="badge ml-2">on the sheet</span>
                            ) : null}
                          </td>
                          <td className="text-right tabular-nums text-sm">
                            {Number(option.quantity_on_hand)} {option.unit_of_measure}
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => addItem(option)}
                            >
                              Add
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm muted" style={{ padding: "1rem" }}>
                  Nothing matches “{pickerSearch}”.
                </p>
              )}
            </div>

            <div
              className="card-body flex items-center gap-3 flex-wrap"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <button
                type="button"
                className="btn btn-primary"
                disabled={ticked.length === 0}
                onClick={addTicked}
              >
                Add and close
                {ticked.length > 0 ? ` (${ticked.length})` : ""}
              </button>
              <p className="text-xs muted">
                Tick several to add them together, or double-click rows to add
                them one at a time without leaving.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
