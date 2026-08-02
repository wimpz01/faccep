"use client";

import { useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/ui";
import { formatDate, money } from "@/lib/format";

import { SubmitRequestForm } from "./purchasing-forms";

import type { ActionState } from "./actions";

const STATUS_BADGE: Record<string, string> = {
  draft: "badge",
  pending: "badge badge-brand",
  approved: "badge",
  rejected: "badge",
  ordered: "badge",
};

export type RequestListRow = {
  id: string;
  request_no: string;
  justification: string | null;
  lines: string;
  locationCode: string | null;
  locationName: string | null;
  needed_by: string | null;
  estimate: number;
  status: string;
};

/**
 * Purchase requests, narrowing as the box is typed into.
 *
 * Every request is already on the page, so the filtering happens here rather
 * than by asking the server again.
 */
export function RequestList({
  rows,
  canEdit,
  submitAction,
}: {
  rows: RequestListRow[];
  canEdit: boolean;
  submitAction: (
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
    return rows.filter((request) => {
      const haystack = [
        request.request_no,
        request.justification ?? "",
        request.lines,
        request.locationCode ?? "company-wide",
        request.locationName ?? "",
        request.status,
        request.needed_by ?? "",
        request.needed_by ? formatDate(request.needed_by) : "",
        request.estimate.toFixed(2),
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
          <label className="label" htmlFor="request-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="request-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Request number, item, property, status or date"
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
        title="Requests"
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
                  <th>Request</th>
                  <th>Lines</th>
                  <th>Property</th>
                  <th>Needed by</th>
                  <th className="text-right">Estimate</th>
                  <th>Status</th>
                  {canEdit ? <th className="text-right">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <span className="font-semibold text-sm">
                        {request.request_no}
                      </span>
                      {request.justification ? (
                        <p className="text-xs muted">{request.justification}</p>
                      ) : null}
                    </td>
                    <td className="text-xs">{request.lines || "—"}</td>
                    <td className="text-xs">
                      {request.locationCode ? (
                        <>
                          <span className="badge">{request.locationCode}</span>
                          <p className="muted mt-0.5">{request.locationName}</p>
                        </>
                      ) : (
                        <span className="muted">Company-wide</span>
                      )}
                    </td>
                    <td className="text-xs">{formatDate(request.needed_by)}</td>
                    <td className="text-right tabular-nums">
                      {money(request.estimate)}
                    </td>
                    <td>
                      <span className={STATUS_BADGE[request.status] ?? "badge"}>
                        {request.status}
                      </span>
                    </td>
                    {canEdit ? (
                      <td className="text-right">
                        {request.status === "draft" ? (
                          <SubmitRequestForm
                            action={submitAction}
                            requestId={request.id}
                          />
                        ) : null}
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
              ? `No request matches “${query}”.`
              : "No purchase requests yet."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
