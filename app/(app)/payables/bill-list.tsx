"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui";
import { formatDate, money } from "@/lib/format";

export type BillListRow = {
  id: string;
  bill_no: string;
  invoice_no: string;
  supplier: string;
  locationLabel: string;
  jobLabel: string | null;
  invoice_date: string;
  due_date: string;
  total: number;
  paid: number;
  balance: number;
  status: string;
  isOverdue: boolean;
};

/**
 * Supplier invoices, narrowing as the box is typed into.
 *
 * Every bill on the tab is already on the page, so the filtering happens here
 * rather than by asking the server again. The date order does not: it lives in
 * the URL so it survives a refresh, which is why the column heading is a link
 * rather than another piece of state in here.
 */
export function BillList({
  rows,
  dateSortHref,
  dateAscending,
}: {
  rows: BillListRow[];
  dateSortHref: string;
  dateAscending: boolean;
}) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((bill) => {
      const haystack = [
        bill.bill_no,
        bill.invoice_no,
        bill.supplier,
        bill.locationLabel,
        bill.jobLabel ?? "",
        formatDate(bill.invoice_date),
        formatDate(bill.due_date),
        bill.status.replace("_", " "),
        bill.isOverdue ? "overdue" : "",
        bill.balance > 0 ? "unpaid owing" : "settled",
        String(bill.total.toFixed(2)),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    // terms is derived from query, which is the real dependency.
  }, [rows, query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <label className="label" htmlFor="bill-search">
          Search
        </label>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            id="bill-search"
            type="search"
            className="input"
            style={{ flex: "1 1 22rem" }}
            value={query}
            autoComplete="off"
            placeholder="Bill no, supplier ref, supplier, property, date or status"
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
          {terms.length > 0
            ? `${shown.length} matching “${query}”, of ${rows.length} shown.`
            : "Narrows as you type. Every word has to match, so two words narrow it further."}
        </p>
      </div>

      {shown.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Supplier</th>
                <th>
                  <Link
                    href={dateSortHref}
                    style={{ color: "inherit" }}
                    title={
                      dateAscending
                        ? "Sorted oldest first — click for newest first"
                        : "Sorted newest first — click for oldest first"
                    }
                  >
                    Date{" "}
                    <span style={{ color: "var(--color-brand-600)" }}>
                      {dateAscending ? "▲" : "▼"}
                    </span>
                  </Link>
                </th>
                <th>Due</th>
                <th className="text-right">Total</th>
                <th className="text-right">Paid</th>
                <th className="text-right">Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((bill) => (
                <tr key={bill.id}>
                  <td>
                    <Link
                      href={`/payables/invoices/${bill.id}`}
                      className="font-semibold text-sm tabular-nums"
                      style={{ color: "var(--color-brand-600)" }}
                    >
                      {bill.bill_no}
                    </Link>
                    <p className="text-xs muted">
                      Supplier ref. {bill.invoice_no}
                      {" · "}
                      {bill.locationLabel}
                    </p>
                    {bill.jobLabel ? (
                      <p className="text-xs muted">{bill.jobLabel}</p>
                    ) : null}
                  </td>
                  <td className="text-sm">{bill.supplier}</td>
                  <td className="text-xs">{formatDate(bill.invoice_date)}</td>
                  <td className="text-xs">
                    {formatDate(bill.due_date)}
                    {bill.isOverdue ? (
                      <p style={{ color: "var(--danger)" }}>overdue</p>
                    ) : null}
                  </td>
                  <td className="text-right tabular-nums">{money(bill.total)}</td>
                  <td className="text-right tabular-nums">{money(bill.paid)}</td>
                  <td className="text-right tabular-nums">
                    {money(bill.balance)}
                  </td>
                  <td>
                    <span className="badge">{bill.status.replace("_", " ")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState>
          {terms.length > 0
            ? `No supplier invoice matches “${query}”.`
            : "No supplier invoices recorded yet."}
        </EmptyState>
      )}
    </>
  );
}
