"use client";

import { useMemo, useState } from "react";

import { Card, EmptyState, formatDateTime } from "@/components/ui";
import { money } from "@/lib/format";

export type MovementRow = {
  id: string;
  movement_kind: string;
  quantity: number;
  unit_cost: number;
  note: string | null;
  created_at: string;
  item: string;
  unit: string;
  who: string;
};

/**
 * The whole movement ledger, narrowing as it is typed into.
 *
 * Recording a movement and reading back what was recorded are different jobs,
 * so this is deliberately separate from the adjustment form: this one answers
 * "where did the cement go", which needs every row, not the last few.
 */
export function MovementHistory({ rows }: { rows: MovementRow[] }) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((row) => {
      const haystack = [
        row.item,
        row.movement_kind,
        row.note ?? "",
        row.who,
        row.unit,
        formatDateTime(row.created_at),
        String(row.quantity),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    // terms is derived from query, which is the real dependency.
  }, [rows, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const movedIn = shown
    .filter((row) => row.quantity > 0)
    .reduce((sum, row) => sum + row.quantity * row.unit_cost, 0);
  const movedOut = shown
    .filter((row) => row.quantity < 0)
    .reduce((sum, row) => sum + Math.abs(row.quantity) * row.unit_cost, 0);

  return (
    <>
      <div className="card mb-4">
        <div className="card-body">
          <label className="label" htmlFor="movement-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="movement-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Item, type, note, who recorded it or date"
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
        title="Movement history"
        description={
          terms.length > 0
            ? `${shown.length} matching “${query}”, of ${rows.length}. In ${money(movedIn)}, out ${money(movedOut)}.`
            : `Every receipt, issue and return. In ${money(movedIn)}, out ${money(movedOut)}.`
        }
        bodyClassName=""
      >
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Value</th>
                  <th>Note</th>
                  <th>Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs muted">
                      {formatDateTime(row.created_at)}
                    </td>
                    <td className="text-sm">{row.item}</td>
                    <td>
                      <span className="badge">{row.movement_kind}</span>
                    </td>
                    <td
                      className="text-right tabular-nums"
                      style={{
                        color:
                          row.quantity < 0 ? "var(--danger)" : "var(--success)",
                      }}
                    >
                      {row.quantity > 0 ? "+" : ""}
                      {row.quantity} {row.unit}
                    </td>
                    <td className="text-right tabular-nums text-sm">
                      {money(Math.abs(row.quantity) * row.unit_cost)}
                    </td>
                    <td className="text-xs">{row.note ?? "—"}</td>
                    <td className="text-xs muted">{row.who}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {terms.length > 0
              ? `No movement matches “${query}”.`
              : "No movements recorded yet."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
