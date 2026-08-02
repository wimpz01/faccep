"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/ui";
import { money } from "@/lib/format";

import { ResendApprovalForm } from "./purchasing-forms";

import type { ActionState } from "./actions";

export type VendorListRow = {
  id: string;
  vendor_no: string;
  name: string;
  address: string | null;
  tin: string | null;
  contact_person: string | null;
  contact_number: string | null;
  termsName: string | null;
  termsDays: number | null;
  is_vatable: boolean;
  withholdingLabel: string;
  status: string;
  owed: number;
  queued: boolean;
};

/**
 * Suppliers, narrowing as the box is typed into.
 *
 * Every supplier is already on the page, so the filtering happens here rather
 * than by asking the server again.
 */
export function VendorList({
  rows,
  canEdit,
  pendingCount,
  resendAction,
}: {
  rows: VendorListRow[];
  canEdit: boolean;
  pendingCount: number;
  resendAction: (
    state: ActionState,
    formData: FormData,
  ) => Promise<ActionState>;
}) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const shown = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((vendor) => {
      const haystack = [
        vendor.vendor_no,
        vendor.name,
        vendor.address ?? "",
        vendor.tin ?? "",
        vendor.contact_person ?? "",
        vendor.contact_number ?? "",
        vendor.termsName ?? "",
        vendor.is_vatable ? `vat ${vendor.withholdingLabel}` : "non-vat",
        vendor.status === "pending" ? "pending awaiting approval" : vendor.status,
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
          <label className="label" htmlFor="vendor-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="vendor-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Name, code, TIN, contact, terms or status"
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
        title="Suppliers"
        description={
          terms.length > 0
            ? `${shown.length} matching “${query}”, of ${rows.length} on file.`
            : pendingCount > 0
              ? `${pendingCount} awaiting approval — they cannot be ordered from or billed until signed off.`
              : "A code is issued on save. A new supplier is unusable until somebody with Approve signs them off."
        }
        bodyClassName=""
      >
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Supplier</th>
                  <th>TIN</th>
                  <th>Contact</th>
                  <th>Terms</th>
                  <th>Tax</th>
                  <th>Status</th>
                  {canEdit ? <th className="text-right">Move to</th> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((vendor) => (
                  <tr key={vendor.id}>
                    <td>
                      <span className="font-semibold text-sm tabular-nums">
                        {vendor.vendor_no}
                      </span>
                    </td>
                    <td>
                      <span className="font-medium text-sm">{vendor.name}</span>
                      {vendor.address ? (
                        <p className="text-xs muted">{vendor.address}</p>
                      ) : null}
                    </td>
                    <td className="text-xs">{vendor.tin ?? "—"}</td>
                    <td className="text-xs">
                      {vendor.contact_person ?? "—"}
                      {vendor.contact_number ? (
                        <p className="muted">{vendor.contact_number}</p>
                      ) : null}
                    </td>
                    <td className="text-xs">
                      {vendor.termsName ? (
                        <>
                          {vendor.termsName}
                          <p className="muted">
                            {vendor.termsDays === 0
                              ? "on delivery"
                              : `${vendor.termsDays} days`}
                          </p>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-xs">
                      {vendor.is_vatable ? (
                        <>
                          <span className="badge">VAT</span>
                          <p className="muted mt-0.5">{vendor.withholdingLabel}</p>
                        </>
                      ) : (
                        <span className="muted">non-VAT</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          vendor.status === "approved"
                            ? "badge badge-brand"
                            : "badge"
                        }
                        style={
                          vendor.status === "rejected"
                            ? { color: "var(--danger)" }
                            : undefined
                        }
                      >
                        {vendor.status === "pending"
                          ? "awaiting approval"
                          : vendor.status}
                      </span>
                      {vendor.owed > 0 ? (
                        <p className="text-xs muted mt-0.5">
                          owed {money(vendor.owed)}
                        </p>
                      ) : null}
                    </td>
                    {canEdit ? (
                      <td className="text-right text-xs muted">
                        {vendor.status === "pending" ? (
                          vendor.queued ? (
                            <Link
                              href="/approvals"
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              In the approvals queue
                            </Link>
                          ) : (
                            <ResendApprovalForm
                              action={resendAction}
                              vendorId={vendor.id}
                            />
                          )
                        ) : vendor.status === "rejected" ? (
                          "Declined — kept for the record"
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {terms.length > 0
              ? `No supplier matches “${query}”.`
              : "No suppliers recorded yet."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
