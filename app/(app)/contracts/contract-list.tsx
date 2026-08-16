"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui";
import { formatDate, money, monthsUntil } from "@/lib/format";

import { CONTRACT_STATUS_BADGE } from "./constants";

export type ContractListRow = {
  id: string;
  contract_no: string;
  tenant: string;
  units: string;
  start_date: string;
  end_date: string;
  monthly_rent: string;
  escalation_rate: string;
  status: string;
};

/**
 * The contract list, searchable by tenant.
 *
 * Filtered here rather than in the query: the page already holds every
 * contract, so narrowing in the browser answers instantly and does not cost a
 * round trip per keystroke. Every word has to match, so two words narrow
 * rather than widen -- "molo pawnshop" finds the one contract, not both.
 */
export function ContractList({
  rows,
  emptyHint,
}: {
  rows: ContractListRow[];
  emptyHint: string;
}) {
  const [query, setQuery] = useState("");

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((row) => {
      const haystack = [
        row.tenant,
        row.contract_no,
        row.units,
        row.status,
        formatDate(row.start_date),
        formatDate(row.end_date),
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
        <label className="label" htmlFor="contract-search">
          Search
        </label>
        <input
          id="contract-search"
          type="search"
          className="input"
          placeholder="Tenant, contract number, unit or status — e.g. pawnshop"
          value={query}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setQuery(next);
          }}
        />
        <p className="text-xs muted mt-1">
          Narrows as you type. Every word has to match, so two words narrow it
          further.
        </p>
      </div>

      {shown.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Tenant</th>
                <th>Units</th>
                <th>Term</th>
                <th className="text-right">Monthly rent</th>
                <th className="text-right">Escalation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const months = monthsUntil(row.end_date);
                const endingSoon =
                  row.status === "active" && months !== null && months <= 6;
                return (
                  <tr key={row.id}>
                    <td>
                      <Link
                        href={`/contracts/${row.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {row.contract_no}
                      </Link>
                    </td>
                    <td className="text-sm">{row.tenant}</td>
                    <td className="text-xs">{row.units}</td>
                    <td className="text-xs">
                      {formatDate(row.start_date)} – {formatDate(row.end_date)}
                      {endingSoon ? (
                        <p style={{ color: "var(--danger)" }}>
                          Renewal notice due
                        </p>
                      ) : null}
                    </td>
                    <td className="text-right tabular-nums">
                      {money(row.monthly_rent)}
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(row.escalation_rate)}%
                    </td>
                    <td>
                      <span className={CONTRACT_STATUS_BADGE[row.status] ?? "badge"}>
                        {row.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState>
          {query
            ? `No contract matches “${query}”.`
            : emptyHint}
        </EmptyState>
      )}
    </>
  );
}
