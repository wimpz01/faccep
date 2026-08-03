"use client";

import { useMemo, useState } from "react";

import { Card, EmptyState, formatDateTime } from "@/components/ui";

import type { ActionState } from "./actions";
import { DecideForm } from "./decide-form";

export type ApprovalRow = {
  id: string;
  moduleLabel: string;
  action: string;
  reason: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
  requester: string;
  decider: string;
  /** Resolved on the server: Approve on this request's own module. */
  canDecide: boolean;
};

/**
 * The two approval tables, narrowing as the search box is typed into.
 *
 * One box filters both, because "find the void on OR-2026-00002" should not
 * depend on knowing whether it has been decided yet.
 */
export function ApprovalList({
  pending,
  decided,
  decideAction,
}: {
  pending: ApprovalRow[];
  decided: ApprovalRow[];
  decideAction: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [query, setQuery] = useState("");

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const match = (row: ApprovalRow) => {
    if (terms.length === 0) return true;
    const haystack = [
      row.moduleLabel,
      row.action,
      row.reason,
      row.status,
      row.requester,
      row.decider,
      row.decision_note ?? "",
      formatDateTime(row.requested_at),
      row.decided_at ? formatDateTime(row.decided_at) : "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };

  const shownPending = useMemo(
    () => pending.filter(match),
    // terms is derived from query, which is the real dependency.
    [pending, query], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shownDecided = useMemo(
    () => decided.filter(match),
    [decided, query], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const searching = terms.length > 0;

  return (
    <>
      <div className="card mb-4">
        <div className="card-body">
          <label className="label" htmlFor="approval-search">
            Search
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              id="approval-search"
              type="search"
              className="input"
              style={{ flex: "1 1 22rem" }}
              value={query}
              autoComplete="off"
              placeholder="Reason, reference, module, action, who asked or date"
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
            Narrows as you type, across both tables. Every word has to match, so
            two words narrow it further.
          </p>
        </div>
      </div>

      <div className="mb-6">
        <Card
          title={`${shownPending.length} awaiting decision`}
          description={
            searching
              ? `Matching “${query}”, of ${pending.length} waiting.`
              : undefined
          }
          bodyClassName=""
        >
          {shownPending.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Requested</th>
                    <th>Module</th>
                    <th>Action</th>
                    <th>Reason</th>
                    <th style={{ minWidth: "14rem" }}>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPending.map((request) => (
                    <tr key={request.id}>
                      <td className="text-xs">
                        {formatDateTime(request.requested_at)}
                        <p className="muted">{request.requester}</p>
                      </td>
                      <td className="text-xs">{request.moduleLabel}</td>
                      <td>
                        <span className="badge">{request.action}</span>
                      </td>
                      <td className="text-sm">{request.reason}</td>
                      <td>
                        {request.canDecide ? (
                          <DecideForm
                            action={decideAction}
                            requestId={request.id}
                          />
                        ) : (
                          <span className="text-xs muted">
                            You do not have Approve on this module.
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              {searching
                ? `Nothing waiting matches “${query}”.`
                : "Nothing is waiting for approval."}
            </EmptyState>
          )}
        </Card>
      </div>

      <Card
        title="Recently decided"
        description={
          searching
            ? `${shownDecided.length} matching “${query}”, of ${decided.length}.`
            : undefined
        }
        bodyClassName=""
      >
        {shownDecided.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Decided</th>
                  <th>Module</th>
                  <th>Action</th>
                  <th>Reason</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {shownDecided.map((request) => (
                  <tr key={request.id}>
                    <td className="text-xs">
                      {formatDateTime(request.decided_at)}
                      <p className="muted">{request.decider}</p>
                    </td>
                    <td className="text-xs">{request.moduleLabel}</td>
                    <td>
                      <span className="badge">{request.action}</span>
                    </td>
                    <td className="text-sm">
                      {request.reason}
                      {request.decision_note ? (
                        <p className="text-xs muted">{request.decision_note}</p>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          color:
                            request.status === "approved"
                              ? "var(--success)"
                              : "var(--danger)",
                        }}
                      >
                        {request.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {searching
              ? `No decision matches “${query}”.`
              : "No decisions recorded yet."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
