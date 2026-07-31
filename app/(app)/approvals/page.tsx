import type { Metadata } from "next";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { can, type ModuleRow } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { decideApproval } from "./actions";
import { DecideForm } from "./decide-form";

export const metadata: Metadata = { title: "Approvals" };

type RequestRow = {
  id: string;
  module_key: string;
  entity_table: string;
  entity_id: string;
  action: string;
  reason: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
  requester: { full_name: string; email: string } | null;
  decider: { full_name: string; email: string } | null;
};

export default async function ApprovalsPage() {
  const context = await requireSession();
  const companyId = context.activeCompany!.companyId;
  const supabase = await createClient();

  const [{ data: requests }, { data: modules }] = await Promise.all([
    supabase
      .from("approval_requests")
      .select(
        `id, module_key, entity_table, entity_id, action, reason, status,
         requested_at, decided_at, decision_note,
         requester:profiles!approval_requests_requested_by_fkey(full_name, email),
         decider:profiles!approval_requests_decided_by_fkey(full_name, email)`,
      )
      .eq("company_id", companyId)
      .order("requested_at", { ascending: false })
      .limit(100)
      .returns<RequestRow[]>(),
    supabase
      .from("modules")
      .select(
        "key, label, module_group, description, sort_order, supports_approve, supports_void",
      )
      .returns<ModuleRow[]>(),
  ]);

  const moduleLabels = new Map((modules ?? []).map((mod) => [mod.key, mod.label]));
  const rows = requests ?? [];
  const pending = rows.filter((row) => row.status === "pending");
  const decided = rows.filter((row) => row.status !== "pending");

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Cancellations, voids and requests waiting for sign-off. Approving here also applies the change."
      />

      <div className="mb-6">
        <Card
          title={`${pending.length} awaiting decision`}
          bodyClassName=""
        >
          {pending.length > 0 ? (
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
                  {pending.map((request) => {
                    const canDecide = can(
                      context.permissions,
                      request.module_key,
                      "approve",
                    );
                    return (
                      <tr key={request.id}>
                        <td className="text-xs">
                          {formatDateTime(request.requested_at)}
                          <p className="muted">
                            {request.requester?.email ?? "unknown"}
                          </p>
                        </td>
                        <td className="text-xs">
                          {moduleLabels.get(request.module_key) ?? request.module_key}
                        </td>
                        <td>
                          <span className="badge">{request.action}</span>
                        </td>
                        <td className="text-sm">{request.reason}</td>
                        <td>
                          {canDecide ? (
                            <DecideForm
                              action={decideApproval}
                              requestId={request.id}
                            />
                          ) : (
                            <span className="text-xs muted">
                              You do not have Approve on this module.
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>Nothing is waiting for approval.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Recently decided" bodyClassName="">
        {decided.length > 0 ? (
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
                {decided.map((request) => (
                  <tr key={request.id}>
                    <td className="text-xs">
                      {formatDateTime(request.decided_at)}
                      <p className="muted">{request.decider?.email ?? "—"}</p>
                    </td>
                    <td className="text-xs">
                      {moduleLabels.get(request.module_key) ?? request.module_key}
                    </td>
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
          <EmptyState>No decisions recorded yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
