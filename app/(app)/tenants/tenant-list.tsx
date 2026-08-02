"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/ui";
import { formatDate, money } from "@/lib/format";

export type TenantListRow = {
  id: string;
  company_name: string;
  contact_person: string | null;
  mobile_number: string | null;
  is_vatable: boolean;
  status: string;
  monthly_rent: number | null;
  contract_ends: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  active: "badge badge-brand",
  prospect: "badge",
  ended: "badge",
  blacklisted: "badge",
};

/**
 * The tenant list, narrowing as it is typed into.
 *
 * Every tenant is already on the page, so filtering happens here rather than
 * by asking the server again -- the list moves on the keystroke instead of
 * after a round trip.
 */
export function TenantList({ rows }: { rows: TenantListRow[] }) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((tenant) => {
      const haystack = [
        tenant.company_name,
        tenant.contact_person ?? "",
        tenant.mobile_number ?? "",
        tenant.status,
        tenant.is_vatable ? "vatable vat" : "non-vat",
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
          <label className="label" htmlFor="tenant-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="tenant-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Company, contact person, mobile number or status"
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
        title={`${shown.length} tenant${shown.length === 1 ? "" : "s"}`}
        description={
          terms.length > 0
            ? `Matching “${query}”, of ${rows.length} on file.`
            : undefined
        }
        bodyClassName=""
      >
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Contact</th>
                  <th>VAT</th>
                  <th>Status</th>
                  <th className="text-right">Monthly rent</th>
                  <th>Contract ends</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <Link
                        href={`/tenants/${tenant.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {tenant.company_name}
                      </Link>
                    </td>
                    <td className="text-xs">
                      {tenant.contact_person ?? "—"}
                      {tenant.mobile_number ? (
                        <p className="muted">{tenant.mobile_number}</p>
                      ) : null}
                    </td>
                    <td>
                      {tenant.is_vatable ? (
                        <span className="badge badge-brand">VATable</span>
                      ) : (
                        <span className="badge">Non-VAT</span>
                      )}
                    </td>
                    <td>
                      <span className={STATUS_BADGE[tenant.status] ?? "badge"}>
                        {tenant.status}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {tenant.monthly_rent === null
                        ? "—"
                        : money(tenant.monthly_rent)}
                    </td>
                    <td className="text-xs">
                      {tenant.contract_ends
                        ? formatDate(tenant.contract_ends)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {terms.length > 0
              ? `No tenant matches “${query}”.`
              : "No tenants yet — use New tenant above to add the first one."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
