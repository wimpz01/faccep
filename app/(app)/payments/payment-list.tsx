"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/ui";
import { formatDate, money } from "@/lib/format";

export type PaymentListRow = {
  id: string;
  payment_no: string;
  reference: string | null;
  tenant: string;
  payment_date: string;
  payment_kind: string;
  payment_mode: string;
  amount: number;
  applied: number;
  status: string;
};

/**
 * Recent payments, narrowing as it is typed into.
 *
 * Every payment on the page is already loaded, so filtering happens here
 * rather than by asking the server again -- the list moves on the keystroke.
 */
export function PaymentList({ rows }: { rows: PaymentListRow[] }) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((payment) => {
      const haystack = [
        payment.payment_no,
        payment.reference ?? "",
        payment.tenant,
        payment.payment_kind,
        payment.payment_mode,
        payment.status,
        payment.payment_date,
        formatDate(payment.payment_date),
        payment.amount.toFixed(2),
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
          <label className="label" htmlFor="payment-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="payment-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Tenant, OR number, reference, amount or date"
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
        title="Recent payments"
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
                  <th>Reference</th>
                  <th>Tenant</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Mode</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Applied</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((payment) => (
                  <tr key={payment.id}>
                    <td>
                      <Link
                        href={`/payments/${payment.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {payment.payment_no}
                      </Link>
                      {payment.reference ? (
                        <p className="text-xs muted">{payment.reference}</p>
                      ) : null}
                    </td>
                    <td className="text-sm">{payment.tenant}</td>
                    <td className="text-xs">{formatDate(payment.payment_date)}</td>
                    <td className="text-xs">{payment.payment_kind}</td>
                    <td className="text-xs">{payment.payment_mode}</td>
                    <td className="text-right tabular-nums">
                      {money(payment.amount)}
                    </td>
                    <td className="text-right tabular-nums">
                      {money(payment.applied)}
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={
                          payment.status === "voided"
                            ? { color: "var(--danger)" }
                            : undefined
                        }
                      >
                        {payment.status}
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
              ? `No payment matches “${query}”.`
              : "No payments recorded yet."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
