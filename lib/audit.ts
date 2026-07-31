import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "void"
  | "approve"
  | "reject"
  | "login"
  | "logout";

export type AuditEntry = {
  action: AuditAction;
  moduleKey: string;
  entityTable: string;
  entityId?: string | null;
  summary: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Defaults to the active company. */
  companyId?: string | null;
};

/**
 * Appends one row to the audit trail (spec 15).
 *
 * Deliberately never throws: an audit write must not roll back the business
 * transaction that already succeeded. Failures are logged to the server console
 * so they surface in deployment logs.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const context = await getSessionContext();
    if (!context) return;

    const companyId = entry.companyId ?? context.activeCompany?.companyId;
    if (!companyId) return;

    const supabase = await createClient();
    const { error } = await supabase.from("audit_log").insert({
      company_id: companyId,
      actor_id: context.userId,
      actor_email: context.email,
      action: entry.action,
      module_key: entry.moduleKey,
      entity_table: entry.entityTable,
      entity_id: entry.entityId ?? null,
      summary: entry.summary,
      before_data: entry.before ?? null,
      after_data: entry.after ?? null,
    });

    if (error) {
      console.error("[audit] failed to write entry", error, entry);
    }
  } catch (error) {
    console.error("[audit] failed to write entry", error, entry);
  }
}

/**
 * Reduces a before/after pair to only the fields that actually changed, so the
 * trail stays readable instead of storing whole row snapshots.
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changedBefore[key] = before[key] ?? null;
      changedAfter[key] = after[key] ?? null;
    }
  }

  return { before: changedBefore, after: changedAfter };
}
