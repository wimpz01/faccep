import "server-only";

import { logAudit } from "@/lib/audit";
import { getSessionContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Approval-gated actions (spec 2).
 *
 * Anything that reverses a posted financial record -- cancelling an invoice,
 * voiding a payment -- is raised as a request here and only takes effect once
 * somebody with Approve on that module signs it off. The requester and the
 * approver are deliberately different permissions.
 */

export type ApprovalAction = "cancel" | "void" | "release" | "approve";

export type ApprovalRequest = {
  id: string;
  module_key: string;
  entity_table: string;
  entity_id: string;
  action: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
};

/** Raises a request. Returns an error message, or null on success. */
export async function requestApproval(input: {
  moduleKey: string;
  entityTable: string;
  entityId: string;
  action: ApprovalAction;
  reason: string;
  summary: string;
}): Promise<string | null> {
  const context = await getSessionContext();
  if (!context?.activeCompany) return "No active company.";

  const supabase = await createClient();
  const { error } = await supabase.from("approval_requests").insert({
    company_id: context.activeCompany.companyId,
    module_key: input.moduleKey,
    entity_table: input.entityTable,
    entity_id: input.entityId,
    action: input.action,
    reason: input.reason,
    requested_by: context.userId,
  });

  if (error) {
    return error.code === "23505"
      ? "There is already a pending request for this record."
      : error.message;
  }

  await logAudit({
    action: "update",
    moduleKey: input.moduleKey,
    entityTable: input.entityTable,
    entityId: input.entityId,
    summary: `Requested approval to ${input.action}: ${input.summary}`,
    after: { reason: input.reason },
  });

  return null;
}

export async function pendingApprovalFor(
  entityTable: string,
  entityId: string,
  action: ApprovalAction,
) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("approval_requests")
    .select("id, reason, requested_at, status")
    .eq("entity_table", entityTable)
    .eq("entity_id", entityId)
    .eq("action", action)
    .eq("status", "pending")
    .maybeSingle();
  return data;
}
