"use client";

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

type Line = {
  key: number;
  itemId: string;
  /** What has been typed into the SKU box: a code, or part of a name. */
  search: string;
  open: boolean;
  kind: string;
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
  kind: "adjustment",
  direction: "up",
  quantity: "",
  unitCost: "",
  note: "",
});

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Posting…" : "Post adjustment"}
    </button>
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
 * One adjustment, as many lines as the count needed.
 *
 * The number is not asked for -- the database issues it on save, the same way
 * a goods receipt or a voucher gets its own. Each line starts from the SKU
 * box, which takes a code or a name and narrows as it is typed into; choosing
 * a result fills in the item and what is on hand, because an adjustment is
 * only ever as good as picking the right item.
 */
export function AdjustmentForm({
  action,
  items,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  items: AdjustItem[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [lines, setLines] = useState<Line[]>([blank(1)]);
  const [nextKey, setNextKey] = useState(2);
  // Which line the browse window is filling in, and what is typed into it.
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  // Items ticked in the browse window, waiting to be added together.
  const [ticked, setTicked] = useState<string[]>([]);

  const update = (key: number, patch: Partial<Line>) =>
    setLines((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );

  const chooseFor = (key: number, option: AdjustItem) =>
    update(key, {
      itemId: option.id,
      search: option.sku ?? option.name,
      open: false,
      // Preloaded from the item, but the line may carry its own.
      unitCost: String(Number(option.unit_cost)),
    });

  const itemById = new Map(items.map((item) => [item.id, item]));
  const picked = items.filter((item) => matches(item, pickerSearch));

  /** What one item looks like once it has been dropped onto a line. */
  const filled = (line: Line, option: AdjustItem): Line => ({
    ...line,
    itemId: option.id,
    search: option.sku ?? option.name,
    open: false,
    unitCost: String(Number(option.unit_cost)),
  });

  /**
   * Adds everything ticked in one go.
   *
   * The line the window was opened from takes the first item, and the rest
   * follow straight after it, so ticking four items leaves four lines in the
   * order they were listed rather than one line and three somewhere else.
   */
  const addTicked = () => {
    const chosen = items.filter((item) => ticked.includes(item.id));
    if (chosen.length === 0 || pickerFor === null) return;

    setLines((rows) => {
      const at = rows.findIndex((row) => row.key === pickerFor);
      if (at < 0) return rows;

      const next = rows.map((row) =>
        row.key === pickerFor ? filled(row, chosen[0]) : row,
      );
      const extra = chosen
        .slice(1)
        .map((option, i) => filled(blank(nextKey + i), option));
      next.splice(at + 1, 0, ...extra);
      return next;
    });

    setNextKey((key) => key + Math.max(chosen.length - 1, 0));
    setTicked([]);
    setPickerFor(null);
  };

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="label">Adjustment #</p>
          <input className="input" placeholder="Issued on save" disabled readOnly />
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
            defaultValue={new Date().toISOString().slice(0, 10)}
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
              <th style={{ width: "12rem" }}>Type</th>
              <th style={{ width: "13rem" }}>Quantity</th>
              <th style={{ width: "8rem" }}>Unit cost</th>
              <th style={{ minWidth: "15rem" }}>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const item = itemById.get(line.itemId);
              const found = line.open
                ? items.filter((option) => matches(option, line.search)).slice(0, 8)
                : [];

              const choose = (option: AdjustItem) => chooseFor(line.key, option);

              return (
                <tr key={line.key}>
                  <td style={{ position: "relative" }}>
                    {/* The action reads this; it is always present so every
                        line keeps its place in the submitted order. */}
                    <input type="hidden" name="line_item_id" value={line.itemId} />
                    <div className="flex gap-1 items-center">
                    <input
                      className="input"
                      value={line.search}
                      autoComplete="off"
                      placeholder="Type a SKU or item name"
                      onFocus={() => update(line.key, { open: true })}
                      onBlur={() =>
                        // Let a click on a result land before this closes it.
                        setTimeout(() => update(line.key, { open: false }), 150)
                      }
                      onChange={(event) =>
                        update(line.key, {
                          search: event.currentTarget.value,
                          // Typing again means the earlier choice no longer holds.
                          itemId: "",
                          open: true,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && found.length > 0) {
                          event.preventDefault();
                          choose(found[0]);
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
                          setPickerFor(line.key);
                          setPickerSearch("");
                          setTicked([]);
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
                                choose(option);
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
                    {item ? (
                      item.name
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="text-xs tabular-nums">
                    {item
                      ? `${Number(item.quantity_on_hand)} ${item.unit_of_measure}`
                      : "—"}
                  </td>
                  <td>
                    <select
                      name="line_kind"
                      className="select"
                      // The column width alone does not reach the control, and
                      // "Count correction" has to read in full.
                      style={{ width: "11rem" }}
                      value={line.kind}
                      onChange={(event) =>
                        update(line.key, { kind: event.currentTarget.value })
                      }
                    >
                      <option value="adjustment">Count correction</option>
                      <option value="receipt">Receipt — in</option>
                      <option value="return">Return — in</option>
                      <option value="issue">Issue — out</option>
                    </select>
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {line.kind === "adjustment" ? (
                        <select
                          name="line_direction"
                          className="select"
                          style={{ width: "5.25rem", flex: "0 0 auto" }}
                          value={line.direction}
                          onChange={(event) =>
                            update(line.key, {
                              direction: event.currentTarget.value,
                            })
                          }
                        >
                          <option value="up">+</option>
                          <option value="down">−</option>
                        </select>
                      ) : (
                        // Always submitted, so every line has a direction at
                        // the same index as its item.
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
                    {lines.length > 1 ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          setLines((rows) =>
                            rows.filter((row) => row.key !== line.key),
                          )
                        }
                        aria-label="Remove this line"
                      >
                        Remove
                      </button>
                    ) : null}
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
        <Submit />
        <FormError message={state.error} />
        {state.success ? (
          <p className="text-sm" style={{ color: "var(--success)" }}>
            {state.success}
          </p>
        ) : null}
      </div>

      {/* The whole item list, for when the code is not already known. Typing
          narrows it the same way the SKU box does -- by code or by name. */}
      {pickerFor !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose an item"
          onClick={() => setPickerFor(null)}
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
            style={{ width: "min(46rem, 100%)", maxHeight: "80vh", display: "flex", flexDirection: "column" }}
          >
            <div className="card-body" style={{ paddingBottom: "0.75rem" }}>
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h3 className="font-semibold">Choose an item</h3>
                  <p className="text-xs muted">
                    Type a SKU or an item name — the list narrows as you type.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPickerFor(null)}
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
                    if (picked.length > 0) {
                      chooseFor(pickerFor, picked[0]);
                      setPickerFor(null);
                    }
                  }
                  if (event.key === "Escape") setPickerFor(null);
                }}
              />
            </div>

            {/* Double-clicking a row takes it straight away, so text selection
                would only get in the way here. */}
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
                    {picked.map((option) => (
                      <tr
                        key={option.id}
                        onDoubleClick={() => {
                          chooseFor(pickerFor, option);
                          setPickerFor(null);
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--color-brand-600)]"
                            aria-label={`Select ${option.name}`}
                            checked={ticked.includes(option.id)}
                            onChange={(event) => {
                              // Read it now: by the time the updater runs,
                              // React has let go of the event.
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
                        <td className="text-sm">{option.name}</td>
                        <td className="text-right tabular-nums text-sm">
                          {Number(option.quantity_on_hand)} {option.unit_of_measure}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => {
                              chooseFor(pickerFor, option);
                              setPickerFor(null);
                            }}
                          >
                            Choose
                          </button>
                        </td>
                      </tr>
                    ))}
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
                onClick={() => addTicked()}
              >
                Add and close
                {ticked.length > 0 ? ` (${ticked.length})` : ""}
              </button>
              <p className="text-xs muted">
                Tick several to add them all, or double-click a row to take just
                that one.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
