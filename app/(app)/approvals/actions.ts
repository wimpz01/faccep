"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/**
 * Approves or rejects a request, and carries out the underlying effect when
 * approved. The effect lives here rather than in the requesting module so that
 * "approved" and "applied" can never drift apart.
 */
export async function decideApproval(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("decision_note") ?? "").trim();

  if (decision !== "approved" && decision !== "rejected") {
    return { error: "Unknown decision." };
  }

  const supabase = await createClient();
  const { data: request } = await supabase
    .from("approval_requests")
    .select("id, company_id, module_key, entity_table, entity_id, action, reason, status")
    .eq("id", id)
    .maybeSingle();

  if (!request) return { error: "Request not found." };
  if (request.status !== "pending") return { error: "This request is already decided." };

  let context;
  try {
    // Approve rights on the module the request belongs to, not a blanket right.
    context = await assertPermission(request.module_key, "approve");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const failure =
    decision === "approved"
      ? await applyEffect(request)
      : await applyRejection(request);
  if (failure) return { error: failure };

  const { error } = await supabase
    .from("approval_requests")
    .update({
      status: decision,
      decided_by: context.userId,
      decided_at: new Date().toISOString(),
      decision_note: note || null,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  await logAudit({
    action: decision === "approved" ? "approve" : "reject",
    moduleKey: request.module_key,
    entityTable: request.entity_table,
    entityId: request.entity_id,
    summary: `${decision === "approved" ? "Approved" : "Rejected"} request to ${request.action}: ${request.reason}`,
    after: { decision, note: note || null },
  });

  revalidatePath("/approvals");
  revalidatePath("/billing/invoices");
  revalidatePath("/payments");
  revalidatePath("/purchasing/vendors");
  return {
    success:
      decision === "approved"
        ? "Approved and applied."
        : "Rejected.",
  };
}

/**
 * What a rejection changes, where it changes anything.
 *
 * Turning down an invoice cancellation or a payment void leaves the record
 * exactly as it was -- the request simply fails. A new supplier is different:
 * the decision is about the supplier themselves, so it has to be recorded on
 * them or they would sit pending forever.
 */
async function applyRejection(request: PendingRequest): Promise<string | null> {
  if (request.entity_table !== "vendors") return null;

  const supabase = await createClient();
  const { error } = await supabase
    .from("vendors")
    .update({ status: "rejected" })
    .eq("id", request.entity_id);
  return error?.message ?? null;
}

type PendingRequest = {
  company_id: string;
  entity_table: string;
  entity_id: string;
  action: string;
  reason: string;
};

/** Carries out what the request asked for. Returns an error message or null. */
async function applyEffect(request: PendingRequest): Promise<string | null> {
  const supabase = await createClient();

  if (request.entity_table === "invoices" && request.action === "cancel") {
    const { error } = await supabase
      .from("invoices")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancellation_reason: request.reason,
      })
      .eq("id", request.entity_id);
    return error?.message ?? null;
  }

  if (request.entity_table === "payments" && request.action === "void") {
    const { error } = await supabase
      .from("payments")
      .update({
        status: "voided",
        voided_at: new Date().toISOString(),
        void_reason: request.reason,
      })
      .eq("id", request.entity_id);
    // The payments_settle trigger reopens every invoice the payment touched.
    return error?.message ?? null;
  }

  if (request.entity_table === "vendors" && request.action === "approve") {
    const { error } = await supabase
      .from("vendors")
      .update({ status: "approved" })
      .eq("id", request.entity_id);
    return error?.message ?? null;
  }

  if (request.entity_table === "postdated_checks" && request.action === "cancel") {
    const { error } = await supabase
      .from("postdated_checks")
      .update({
        status: "cancelled",
        notes: request.reason,
      })
      .eq("id", request.entity_id);
    return error?.message ?? null;
  }

  if (request.entity_table === "purchase_requests" && request.action === "approve") {
    const { error } = await supabase
      .from("purchase_requests")
      .update({ status: "approved" })
      .eq("id", request.entity_id);
    return error?.message ?? null;
  }

  return `No effect is defined for ${request.action} on ${request.entity_table}.`;
}
