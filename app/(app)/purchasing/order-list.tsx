"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/ui";
import { formatDate, money } from "@/lib/format";

const STATUS_BADGE: Record<string, string> = {
  draft: "badge",
  issued: "badge badge-brand",
  partially_received: "badge badge-brand",
  received: "badge",
  closed: "badge",
  cancelled: "badge",
};

export type OrderListRow = {
  id: string;
  po_no: string;
  fromRequest: string | null;
  vendor: string;
  order_date: string;
  expected_date: string | null;
  total: number;
  status: string;
};

/**
 * Purchase orders, narrowing as the box is typed into.
 *
 * Every order on the page is already loaded, so the filtering happens here
 * rather than by asking the server again.
 */
export function OrderList({ rows }: { rows: OrderListRow[] }) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((order) => {
      const haystack = [
        order.po_no,
        order.fromRequest ?? "",
        order.vendor,
        order.status.replace("_", " "),
        order.order_date,
        order.expected_date ?? "",
        formatDate(order.order_date),
        order.total.toFixed(2),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    // terms is derived from query, which is the real dependency.
  }, [rows, query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="card mb-4">
        <div className="card-body">
          <label className="label" htmlFor="order-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="order-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Supplier, PO number, request, status or date"
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
            Narrows as you type. Every word has to match, so two words narrow
            it further.
          </p>
        </div>
      </div>

      <Card
        title="Orders"
        description={
          terms.length > 0
            ? `${shown.length} matching “${query}”, of ${rows.length} shown.`
            : undefined
        }
        bodyClassName=""
      >
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Ordered</th>
                  <th>Expected</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link
                        href={`/purchasing/orders/${order.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {order.po_no}
                      </Link>
                      {order.fromRequest ? (
                        <p className="text-xs muted">from {order.fromRequest}</p>
                      ) : null}
                    </td>
                    <td className="text-sm">{order.vendor}</td>
                    <td className="text-xs">{formatDate(order.order_date)}</td>
                    <td className="text-xs">{formatDate(order.expected_date)}</td>
                    <td className="text-right tabular-nums">
                      {money(order.total)}
                    </td>
                    <td>
                      <span className={STATUS_BADGE[order.status] ?? "badge"}>
                        {order.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {terms.length > 0
              ? `No order matches “${query}”.`
              : "No purchase orders yet."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
