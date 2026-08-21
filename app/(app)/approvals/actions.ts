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
  revalidatePath("/properties");
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
  // A rate change turned down has to be recorded as such, or it stays open
  // and blocks the next proposal on that unit.
  if (request.entity_table === "unit_rate_changes") {
    const supabase = await createClient();
    const { error } = await supabase.rpc("decide_unit_rate_change", {
      p_change: request.entity_id,
      p_approve: false,
      p_note: request.reason,
    });
    return error?.message ?? null;
  }

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

/**
 * Applies one update and insists it actually landed.
 *
 * A row that row-level security filters out is not an error -- the update
 * simply matches nothing and comes back clean. Without the returned row to
 * check, an approval blocked by RLS looked identical to one that worked, and
 * the request was marked approved while the record never moved. Asking for
 * the row back turns that silence into a message somebody can act on.
 */
async function applyUpdate(
  table: string,
  entityId: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .update(patch)
    .eq("id", entityId)
    .select("id");

  if (error) return error.message;
  if (!data || data.length === 0) {
    return `The approval was not applied: nothing in ${table} changed. This usually means the account approving it cannot write to that record.`;
  }
  return null;
}

/** Carries out what the request asked for. Returns an error message or null. */
async function applyEffect(request: PendingRequest): Promise<string | null> {
  if (request.entity_table === "invoices" && request.action === "cancel") {
    return applyUpdate("invoices", request.entity_id, {
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: request.reason,
    });
  }

  if (request.entity_table === "payments" && request.action === "void") {
    // The payments_settle trigger reopens every invoice the payment touched.
    return applyUpdate("payments", request.entity_id, {
      status: "voided",
      voided_at: new Date().toISOString(),
      void_reason: request.reason,
    });
  }

  /**
   * Approving a voucher releases it, and releasing is what posts it to the
   * ledger. Approved-but-not-posted would be a state nobody could explain, so
   * the two happen together.
   */
  if (request.entity_table === "check_vouchers" && request.action === "approve") {
    return applyUpdate("check_vouchers", request.entity_id, {
      status: "released",
      released_at: new Date().toISOString(),
    });
  }

  /**
   * A unit rate moves only here. The database refuses a direct write to the
   * column, so the function is the one path there is, and it stamps the
   * decision on the rate change at the same time.
   */
  if (request.entity_table === "unit_rate_changes" && request.action === "approve") {
    const supabase = await createClient();
    const { error } = await supabase.rpc("decide_unit_rate_change", {
      p_change: request.entity_id,
      p_approve: true,
      p_note: null,
    });
    return error?.message ?? null;
  }

  if (request.entity_table === "vendors" && request.action === "approve") {
    return applyUpdate("vendors", request.entity_id, { status: "approved" });
  }

  if (request.entity_table === "postdated_checks" && request.action === "cancel") {
    return applyUpdate("postdated_checks", request.entity_id, {
      status: "cancelled",
      notes: request.reason,
    });
  }

  if (request.entity_table === "purchase_requests" && request.action === "approve") {
    return applyUpdate("purchase_requests", request.entity_id, {
      status: "approved",
    });
  }

  return `No effect is defined for ${request.action} on ${request.entity_table}.`;
}
