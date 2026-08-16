"use client";

import { useState } from "react";

export type PickableItem = {
  id: string;
  name: string;
  unit_of_measure: string;
  onHand?: number;
  sku?: string | null;
};

/**
 * Picks stock items by searching, rather than hunting a long dropdown.
 *
 * Shared by everything that builds a list of items -- purchase requests,
 * purchase orders, material requests -- because they are all the same act:
 * find the thing, say how many. Several can be added in one pass, which is how
 * buying and issuing actually happen. What is on hand sits beside each item
 * because that is the number the decision turns on.
 *
 * It opens over the page rather than in it. An inline panel pushes the lines
 * down the moment it appears, so the table being filled in moves while it is
 * being read, and it goes on taking up room after the picking is done.
 */
export function ItemPicker({
  items,
  onAdd,
  onClose,
  title = "Search the inventory",
}: {
  items: PickableItem[];
  onAdd: (item: PickableItem) => void;
  onClose: () => void;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState<Record<string, number>>({});

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((item) => {
    if (terms.length === 0) return true;
    const haystack =
      `${item.name} ${item.sku ?? ""} ${item.unit_of_measure}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
        // Clicking the backdrop closes; clicking the card must not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          width: "min(44rem, 100%)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="card-header">
          <div style={{ flex: 1 }}>
            <label className="label" htmlFor="item-search">
              {title}
            </label>
            <input
              id="item-search"
              type="search"
              className="input"
              autoFocus
              placeholder="Name, SKU or unit — e.g. bulb"
              value={query}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setQuery(next);
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Done
          </button>
        </div>

        <div className="table-scroll" style={{ flex: 1, overflowY: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">On hand</th>
                <th style={{ width: "6rem" }} />
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.id}>
                  <td className="text-sm">
                    {item.name}
                    <span className="text-xs muted"> · {item.unit_of_measure}</span>
                    {item.sku ? <p className="text-xs muted">{item.sku}</p> : null}
                  </td>
                  <td className="text-right tabular-nums text-sm">
                    {item.onHand ?? "—"}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        onAdd(item);
                        setAdded((current) => ({
                          ...current,
                          [item.id]: (current[item.id] ?? 0) + 1,
                        }));
                      }}
                    >
                      {added[item.id] ? `Added ×${added[item.id]}` : "Add"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 ? (
            <div className="card-body">
              <p className="text-sm muted" style={{ textAlign: "center" }}>
                No item matches &ldquo;{query}&rdquo;.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
