"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requestApproval } from "@/lib/approvals";
import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const paymentSchema = z.object({
  tenant_id: z.string().uuid("Choose a tenant."),
  payment_kind: z.enum(["payment", "prepayment", "deposit", "refund"]),
  payment_mode: z.enum(["cash", "gcash", "check", "bank_transfer"]),
  payment_date: z.string().min(10, "Choose the payment date."),
  amount: z.coerce.number().positive("Enter an amount greater than zero."),
  reference: z.string().trim().optional().or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
});

/**
 * Records a payment and applies it to the chosen invoices.
 *
 * Applications arrive as `apply:<invoice id>`. The total applied may be less
 * than the payment (the remainder sits as an unapplied credit) but never more.
 */
export async function recordPayment(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.payments, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = paymentSchema.safeParse({
    tenant_id: formData.get("tenant_id"),
    payment_kind: formData.get("payment_kind"),
    payment_mode: formData.get("payment_mode"),
    payment_date: formData.get("payment_date"),
    amount: formData.get("amount"),
    reference: formData.get("reference"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const applications: { invoice_id: string; amount: number }[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("apply:")) continue;
    const value = String(raw).trim();
    if (value === "" || Number(value) <= 0) continue;
    applications.push({
      invoice_id: key.slice("apply:".length),
      amount: round2(Number(value)),
    });
  }

  const applied = round2(applications.reduce((sum, row) => sum + row.amount, 0));
  if (applied > round2(parsed.data.amount)) {
    return {
      error: `You have applied ${applied.toFixed(2)} but the payment is only ${parsed.data.amount.toFixed(2)}.`,
    };
  }
  if (parsed.data.payment_kind === "payment" && applications.length === 0) {
    return {
      error:
        "A payment must be applied to at least one invoice. Record it as a prepayment if it is not against a bill yet.",
    };
  }
  // A deposit is held against the tenant and a refund settles nothing, so
  // neither may be applied to a bill.
  if (
    (parsed.data.payment_kind === "deposit" ||
      parsed.data.payment_kind === "refund") &&
    applications.length > 0
  ) {
    return {
      error: `A ${parsed.data.payment_kind} cannot be applied to an invoice — it is held against the tenant, not against a bill.`,
    };
  }

  const supabase = await createClient();

  const year = new Date(parsed.data.payment_date).getFullYear();
  const prefix = `OR-${year}-`;
  const { data: last } = await supabase
    .from("payments")
    .select("payment_no")
    .eq("company_id", companyId)
    .ilike("payment_no", `${prefix}%`)
    .order("payment_no", { ascending: false })
    .limit(1);
  const sequence = last?.[0]
    ? Number(last[0].payment_no.slice(prefix.length)) + 1
    : 1;
  const paymentNo = `${prefix}${String(Number.isFinite(sequence) ? sequence : 1).padStart(5, "0")}`;

  const { data: payment, error } = await supabase
    .from("payments")
    .insert({
      company_id: companyId,
      payment_no: paymentNo,
      ...parsed.data,
      reference: parsed.data.reference || null,
      notes: parsed.data.notes || null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  if (applications.length > 0) {
    const { error: applyError } = await supabase
      .from("payment_applications")
      .insert(
        applications.map((row) => ({ payment_id: payment.id, ...row })),
      );
    if (applyError) return { error: applyError.message };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.payments,
    entityTable: "payments",
    entityId: payment.id,
    summary: `Recorded ${paymentNo} for ${parsed.data.amount.toFixed(2)} (${parsed.data.payment_mode}), applied to ${applications.length} invoice(s).`,
    after: { ...parsed.data, applications },
  });

  redirect(`/payments/${payment.id}`);
}

/** Voiding a posted payment is approval-gated (spec 7). */
export async function requestPaymentVoid(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.payments, "void");
  } catch (error) {
    return {
      error:
        "Voiding a payment needs the Void permission on payments — a Cashier cannot do it alone.",
    };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for the void." };

  const supabase = await createClient();
  const { data: payment } = await supabase
    .from("payments")
    .select("payment_no, status")
    .eq("id", id)
    .single();

  if (!payment) return { error: "Payment not found." };
  if (payment.status === "voided") return { error: "Already voided." };

  const failure = await requestApproval({
    moduleKey: MODULE.payments,
    entityTable: "payments",
    entityId: id,
    action: "void",
    reason,
    summary: `payment ${payment.payment_no}`,
  });
  if (failure) return { error: failure };

  revalidatePath(`/payments/${id}`);
  return {
    success:
      "Void requested. The payment stays posted until somebody with Approve signs it off.",
  };
}

// ---------------------------------------------------------------------------
// Postdated cheques
// ---------------------------------------------------------------------------

const pdcSchema = z.object({
  tenant_id: z.string().uuid("Choose a tenant."),
  check_no: z.string().trim().min(1, "Cheque number is required."),
  bank: z.string().trim().min(1, "Bank is required."),
  amount: z.coerce.number().positive("Enter an amount greater than zero."),
  maturity_date: z.string().min(10, "Choose the maturity date."),
  notes: z.string().trim().optional().or(z.literal("")),
});

export async function recordPdc(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.paymentsPdc, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = pdcSchema.safeParse({
    tenant_id: formData.get("tenant_id"),
    check_no: formData.get("check_no"),
    bank: formData.get("bank"),
    amount: formData.get("amount"),
    maturity_date: formData.get("maturity_date"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("postdated_checks")
    .insert({
      company_id: companyId,
      ...parsed.data,
      notes: parsed.data.notes || null,
    })
    .select("id")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That cheque number is already recorded for this bank."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.paymentsPdc,
    entityTable: "postdated_checks",
    entityId: data.id,
    summary: `Recorded cheque ${parsed.data.check_no} (${parsed.data.bank}) for ${parsed.data.amount.toFixed(2)}, maturing ${parsed.data.maturity_date}.`,
    after: parsed.data,
  });

  revalidatePath("/payments/pdc");
  return { success: `Cheque ${parsed.data.check_no} recorded.` };
}

export async function setPdcStatus(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.paymentsPdc, "edit")) return;

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (
    !["pending", "matured", "deposited", "cleared", "bounced", "cancelled"].includes(
      status,
    )
  ) {
    return;
  }

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("postdated_checks")
    .select("check_no, status")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("postdated_checks")
    .update({
      status,
      deposited_at:
        status === "deposited" ? new Date().toISOString().slice(0, 10) : null,
    })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.paymentsPdc,
    entityTable: "postdated_checks",
    entityId: id,
    summary: `Cheque ${before?.check_no ?? id} marked ${status}.`,
    before: { status: before?.status },
    after: { status },
  });

  revalidatePath("/payments/pdc");
}
