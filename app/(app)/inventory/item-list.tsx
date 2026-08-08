"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/ui";
import { money } from "@/lib/format";

export type ItemListRow = {
  id: string;
  name: string;
  sku: string | null;
  unit_of_measure: string;
  reorder_level: number;
  unit_cost: number;
  quantity_on_hand: number;
  category: string;
};

/**
 * The stock list, narrowing as it is typed into.
 *
 * Everything on the page is already loaded, so filtering happens here rather
 * than by asking the server again -- the list moves on the keystroke.
 */
export function ItemList({
  rows,
  title,
  showValue,
}: {
  rows: ItemListRow[];
  title: string;
  /** Cost and value are a money question, kept to whoever is trusted with one. */
  showValue: boolean;
}) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((item) => {
      const haystack = [
        item.name,
        item.sku ?? "",
        item.category,
        item.unit_of_measure,
        String(item.quantity_on_hand),
        showValue ? item.unit_cost.toFixed(2) : "",
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    // terms is derived from query, which is the real dependency.
  }, [rows, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownValue = shown.reduce(
    (sum, item) => sum + item.quantity_on_hand * item.unit_cost,
    0,
  );

  return (
    <>
      <div className="card mb-4">
        <div className="card-body">
          <label className="label" htmlFor="item-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="item-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Item name, SKU, category or unit — e.g. paint gal"
              onChange={(event) => setQuery(event.currentTarget.value)}
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
            Narrows as you type. Every word has to match, so two words narrow it
            further.
          </p>
        </div>
      </div>

      <Card
        title={title}
        description={
          terms.length > 0
            ? `${shown.length} matching “${query}”, of ${rows.length}${showValue ? ` — worth ${money(shownValue)}` : ""}.`
            : "Everything on file. Open an item to see what it cost, who supplied it and where it went."
        }
        bodyClassName=""
      >
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Reorder at</th>
                  {showValue ? (
                    <>
                      <th className="text-right">Avg cost</th>
                      <th className="text-right">Value</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const low =
                    item.reorder_level > 0 &&
                    item.quantity_on_hand <= item.reorder_level;
                  return (
                    <tr key={item.id}>
                      <td>
                        <Link
                          href={`/inventory/${item.id}`}
                          className="font-medium text-sm"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {item.name}
                        </Link>
                        {item.sku ? (
                          <p className="text-xs muted tabular-nums">{item.sku}</p>
                        ) : null}
                      </td>
                      <td className="text-xs">{item.category}</td>
                      <td
                        className="text-right tabular-nums"
                        style={low ? { color: "var(--danger)" } : undefined}
                      >
                        {item.quantity_on_hand} {item.unit_of_measure}
                      </td>
                      <td className="text-right tabular-nums">
                        {item.reorder_level || "—"}
                      </td>
                      {showValue ? (
                        <>
                          <td className="text-right tabular-nums">
                            {money(item.unit_cost)}
                          </td>
                          <td className="text-right tabular-nums">
                            {money(item.quantity_on_hand * item.unit_cost)}
                          </td>
                        </>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {terms.length > 0
              ? `No item matches “${query}”.`
              : "No stock items yet. Use Add new item above."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
