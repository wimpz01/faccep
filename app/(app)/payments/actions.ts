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
  // Required on a deposit or a refund: each unit is its own contract and
  // carries its own deposit, so the receipt has to say which one it is.
  contract_id: z.string().uuid().nullish().or(z.literal("")),
  payment_kind: z.enum(["payment", "prepayment", "deposit", "refund"]),
  // Only a refund carries one; the database refuses it on anything else.
  fund_kind: z.enum(["security_deposit", "advance_payment"]).nullish().or(z.literal("")),
  payment_mode: z.enum(["cash", "gcash", "check", "bank_transfer"]),
  payment_date: z.string().min(10, "Choose the payment date."),
  amount: z.coerce.number().positive("Enter an amount greater than zero."),
  reference: z.string().trim().nullish().or(z.literal("")),
  notes: z.string().trim().nullish().or(z.literal("")),
  check_bank: z.string().trim().nullish().transform((value) => value ?? ""),
  check_date: z.string().trim().nullish().transform((value) => value ?? ""),
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
    contract_id: formData.get("contract_id"),
    payment_kind: formData.get("payment_kind"),
    fund_kind: formData.get("fund_kind"),
    payment_mode: formData.get("payment_mode"),
    payment_date: formData.get("payment_date"),
    amount: formData.get("amount"),
    reference: formData.get("reference"),
    notes: formData.get("notes"),
    check_bank: formData.get("check_bank"),
    check_date: formData.get("check_date"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();

  // A cheque dated in the future is not a collection. It is held against the
  // tenant under Postdated cheques and only becomes a payment once deposited,
  // so it must not settle an invoice or count towards this month's takings.
  if (parsed.data.payment_mode === "check" && formData.get("postdated") === "on") {
    // Holding a cheque is a postdated-cheque action, not a collection.
    try {
      await assertPermission(MODULE.paymentsPdc, "edit");
    } catch {
      return {
        error:
          "Recording a postdated cheque needs Edit on postdated cheques. Untick Postdated to record it as a payment instead.",
      };
    }

    if (!parsed.data.reference) return { error: "Enter the cheque number." };
    if (!parsed.data.check_bank) return { error: "Enter the drawee bank." };
    if (!parsed.data.check_date) return { error: "Enter the cheque date." };

    const { data: cheque, error: chequeError } = await supabase
      .from("postdated_checks")
      .insert({
        company_id: companyId,
        tenant_id: parsed.data.tenant_id,
        check_no: parsed.data.reference,
        bank: parsed.data.check_bank,
        amount: parsed.data.amount,
        maturity_date: parsed.data.check_date,
        notes: parsed.data.notes || null,
      })
      .select("id, pdc_no")
      .single();

    if (chequeError) {
      return {
        error:
          chequeError.code === "23505"
            ? "That cheque number is already recorded for this bank."
            : chequeError.message,
      };
    }

    await logAudit({
      action: "create",
      moduleKey: MODULE.paymentsPdc,
      entityTable: "postdated_checks",
      entityId: cheque.id,
      summary: `Recorded ${cheque.pdc_no} — postdated cheque ${parsed.data.reference} (${parsed.data.check_bank}) for ${parsed.data.amount.toFixed(2)}, dated ${parsed.data.check_date}.`,
      after: { ...parsed.data, postdated: true },
    });

    revalidatePath("/payments/pdc");
    revalidatePath("/payments");
    redirect("/payments/pdc");
  }

  /*
   * A withholding tenant settles the invoice partly in cash and partly by
   * paying our tax for us, so what they kept back arrives as `wht:<invoice>`
   * beside the cash. It is not part of the payment amount -- that money never
   * reached us -- so it is never counted against what was received.
   */
  const applications: {
    invoice_id: string;
    amount: number;
    tax_withheld: number;
  }[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("apply:")) continue;
    const invoiceId = key.slice("apply:".length);
    const value = String(raw).trim();
    const amount = value === "" ? 0 : round2(Number(value));
    const rawWithheld = String(formData.get("wht:" + invoiceId) ?? "").trim();
    const withheld = rawWithheld === "" ? 0 : round2(Number(rawWithheld));
    if (amount <= 0 && withheld <= 0) continue;
    if (amount < 0 || withheld < 0) {
      return { error: "An amount cannot be negative." };
    }
    applications.push({
      invoice_id: invoiceId,
      amount,
      tax_withheld: withheld,
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
  const heldAgainstContract =
    parsed.data.payment_kind === "deposit" ||
    parsed.data.payment_kind === "refund";
  if (heldAgainstContract && applications.length > 0) {
    return {
      error: `A ${parsed.data.payment_kind} cannot be applied to an invoice — it is held against the tenant, not against a bill.`,
    };
  }
  // The database refuses these too; asking here gives a plain sentence rather
  // than a constraint message.
  if (heldAgainstContract && !parsed.data.contract_id) {
    return {
      error: `Choose the contract this ${parsed.data.payment_kind} belongs to — each unit carries its own deposit.`,
    };
  }

  const { data: payment, error } = await supabase
    .from("payments")
    .insert({
      company_id: companyId,
      ...parsed.data,
      contract_id: parsed.data.contract_id || null,
      // Carried only on a refund; the database refuses it on anything else.
      fund_kind:
        parsed.data.payment_kind === "refund"
          ? parsed.data.fund_kind || "security_deposit"
          : null,
      reference: parsed.data.reference || null,
      notes: parsed.data.notes || null,
      // Only meaningful on a cheque, and an empty string is not a date.
      check_bank: parsed.data.check_bank || null,
      check_date: parsed.data.check_date || null,
    })
    .select("id, payment_no")
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
    summary: `Recorded ${payment.payment_no} for ${parsed.data.amount.toFixed(2)} (${parsed.data.payment_mode}), applied to ${applications.length} invoice(s).`,
    after: { ...parsed.data, applications },
  });

  redirect(`/payments/${payment.id}`);
}

/**
 * Voiding a posted payment is approval-gated (spec 7).
 *
 * Asking needs Edit, not Void. The cashier who keys the wrong amount is
 * exactly the person who notices it, and asking changes nothing on its own —
 * the payment stays posted until somebody with Approve signs it off. Demanding
 * Void here would have meant only the people who can already void could ask,
 * which left the cashier reading "ask a manager" with no way to.
 */
export async function requestPaymentVoid(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.payments, "edit");
  } catch (error) {
    return {
      error: "You need Edit on payments to request a void.",
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
  notes: z.string().trim().nullish().or(z.literal("")),
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
    .select("id, pdc_no")
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
    summary: `Recorded ${data.pdc_no} — cheque ${parsed.data.check_no} (${parsed.data.bank}) for ${parsed.data.amount.toFixed(2)}, maturing ${parsed.data.maturity_date}.`,
    after: parsed.data,
  });

  revalidatePath("/payments/pdc");
  return {
    success: `${data.pdc_no} recorded for cheque ${parsed.data.check_no}.`,
  };
}

/**
 * Banks a whole slip at once.
 *
 * The cashier deposits one slip per bank, so marking them off one cheque at a
 * time invites a half-finished run where some are recorded and some are not.
 */
export async function depositCheques(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.paymentsPdc, "edit")) {
    return { error: "Banking a slip needs Edit on postdated cheques." };
  }

  const ids = formData.getAll("chequeIds").map(String).filter(Boolean);
  if (ids.length === 0) return { error: "No cheques on this slip." };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("postdated_checks")
    .select("id, pdc_no, check_no, bank, amount, status")
    .in("id", ids);

  // Only cheques still in the drawer; anything already banked stays as it is.
  const bankable = (before ?? []).filter(
    (cheque) => cheque.status === "pending" || cheque.status === "matured",
  );
  if (bankable.length === 0) {
    return { error: "These cheques have already been banked." };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from("postdated_checks")
    .update({ status: "deposited", deposited_at: today })
    .in(
      "id",
      bankable.map((cheque) => cheque.id),
    );
  // The maturity guard explains itself; pass its message straight through.
  if (error) return { error: error.message };

  const total = bankable.reduce((sum, cheque) => sum + Number(cheque.amount), 0);

  await logAudit({
    action: "update",
    moduleKey: MODULE.paymentsPdc,
    entityTable: "postdated_checks",
    summary: `Deposited ${bankable.length} cheque(s) to ${bankable[0].bank} totalling ${total.toFixed(2)}.`,
    after: {
      deposited_at: today,
      cheques: bankable.map((cheque) => cheque.pdc_no),
    },
  });

  revalidatePath("/payments/pdc/deposit-slip");
  revalidatePath("/payments/pdc");
  revalidatePath("/dashboard");
  return {
    success: `${bankable.length} cheque(s) banked to ${bankable[0].bank}, ${total.toFixed(2)} in total.`,
  };
}

/**
 * Turns a cleared cheque into the collection it always was.
 *
 * A cheque only becomes money once the bank has honoured it, so the payment is
 * created here rather than when the cheque was taken in. The cheque keeps a
 * link to the payment so the same one can never be collected twice.
 */
export async function postChequeCollection(
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

  const chequeId = String(formData.get("cheque_id") ?? "");
  if (!chequeId) return { error: "Missing cheque." };

  const supabase = await createClient();
  const { data: cheque } = await supabase
    .from("postdated_checks")
    .select(
      "id, company_id, pdc_no, check_no, bank, amount, maturity_date, status, payment_id, tenant_id",
    )
    .eq("id", chequeId)
    .maybeSingle();

  if (!cheque || cheque.company_id !== companyId) {
    return { error: "Cheque not found." };
  }
  if (cheque.status !== "cleared") {
    return {
      error:
        "Only a cleared cheque can be collected. Deposit it and mark it cleared once the bank has honoured it.",
    };
  }
  if (cheque.payment_id) {
    return { error: "This cheque has already been posted as a collection." };
  }

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

  if (applications.length === 0) {
    return { error: "Attach at least one invoice for this cheque to settle." };
  }

  const chequeAmount = round2(Number(cheque.amount));
  const applied = round2(applications.reduce((sum, row) => sum + row.amount, 0));
  if (applied > chequeAmount) {
    return {
      error: `You have applied ${applied.toFixed(2)} but the cheque is only ${chequeAmount.toFixed(2)}.`,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: payment, error } = await supabase
    .from("payments")
    .insert({
      company_id: companyId,
      tenant_id: cheque.tenant_id,
      payment_kind: "payment",
      payment_mode: "check",
      payment_date: today,
      amount: chequeAmount,
      reference: cheque.check_no,
      check_bank: cheque.bank,
      check_date: cheque.maturity_date,
      notes: `Cleared cheque ${cheque.pdc_no}.`,
    })
    .select("id, payment_no")
    .single();

  if (error) return { error: error.message };

  const { error: applyError } = await supabase
    .from("payment_applications")
    .insert(applications.map((row) => ({ payment_id: payment.id, ...row })));
  if (applyError) return { error: applyError.message };

  const { error: linkError } = await supabase
    .from("postdated_checks")
    .update({ payment_id: payment.id })
    .eq("id", chequeId);
  if (linkError) return { error: linkError.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.payments,
    entityTable: "payments",
    entityId: payment.id,
    summary: `Collected ${cheque.pdc_no} (cheque ${cheque.check_no}, ${cheque.bank}) as ${payment.payment_no} for ${chequeAmount.toFixed(2)}, applied to ${applications.length} invoice(s).`,
    after: { cheque: cheque.pdc_no, applications },
  });

  revalidatePath("/payments/pdc");
  revalidatePath("/payments");
  revalidatePath("/dashboard");
  redirect(`/payments/${payment.id}`);
}

/**
 * Cancelling a recorded cheque is approval-gated (spec 2).
 *
 * The cheque is a claim on the tenant's money that has been written into the
 * register, so withdrawing it is not something the person holding it should be
 * able to do alone.
 */
export async function requestChequeCancel(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.paymentsPdc, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for cancelling this cheque." };

  const supabase = await createClient();
  const { data: cheque } = await supabase
    .from("postdated_checks")
    .select("pdc_no, check_no, bank, status")
    .eq("id", id)
    .maybeSingle();

  if (!cheque) return { error: "Cheque not found." };
  if (cheque.status === "cancelled") return { error: "Already cancelled." };
  if (cheque.status === "deposited" || cheque.status === "cleared") {
    return {
      error: `${cheque.pdc_no} has already been banked. Mark it bounced instead of cancelling it.`,
    };
  }

  const failure = await requestApproval({
    moduleKey: MODULE.paymentsPdc,
    entityTable: "postdated_checks",
    entityId: id,
    action: "cancel",
    reason,
    summary: `cheque ${cheque.pdc_no} (${cheque.check_no}, ${cheque.bank})`,
  });
  if (failure) return { error: failure };

  revalidatePath("/payments/pdc");
  return {
    success: `Cancellation requested for ${cheque.pdc_no}. It stays on file until somebody with Approve signs it off.`,
  };
}

export async function setPdcStatus(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.paymentsPdc, "edit")) {
    return { error: "Moving a cheque on needs Edit on postdated cheques." };
  }

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (
    !["pending", "matured", "deposited", "cleared", "bounced", "cancelled"].includes(
      status,
    )
  ) {
    return { error: "Unknown status." };
  }

  // Cancelling goes through the approval queue, never straight from here.
  if (status === "cancelled") {
    return {
      error:
        "Cancelling a cheque needs approval. Use Cancel on the cheque to raise the request.",
    };
  }

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("postdated_checks")
    .select("check_no, status")
    .eq("id", id)
    .single();

  if (!before) return { error: "Cheque not found." };

  const { error } = await supabase
    .from("postdated_checks")
    .update({
      status,
      deposited_at:
        status === "deposited" ? new Date().toISOString().slice(0, 10) : null,
    })
    .eq("id", id);

  // The maturity guard explains itself; pass its message straight through.
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.paymentsPdc,
    entityTable: "postdated_checks",
    entityId: id,
    summary: `Cheque ${before.check_no} marked ${status}.`,
    before: { status: before.status },
    after: { status },
  });

  revalidatePath("/payments/pdc");
  revalidatePath("/dashboard");
  return { success: `Cheque ${before.check_no} marked ${status}.` };
}

/**
 * Sets an existing credit against a bill raised after it was taken.
 *
 * A prepayment could be recorded and never used. Applications were only ever
 * written at the moment a payment was taken, or when a cheque cleared, so
 * money paid ahead of an invoice sat as a credit with nothing able to reach
 * it -- the tenant had paid and the invoice still read unpaid.
 *
 * The ledger side needs nothing new: inserting the application already posts
 * Dr Customer Advances / Cr Accounts Receivable, which is exactly the entry
 * that turns a credit into a settlement.
 */
export async function applyPrepayment(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.payments, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const paymentId = String(formData.get("payment_id") ?? "");
  if (!paymentId) return { error: "Missing payment." };

  const supabase = await createClient();
  const { data: payment } = await supabase
    .from("payments")
    .select("id, payment_no, payment_kind, amount, status, tenant_id")
    .eq("id", paymentId)
    .maybeSingle<{
      id: string;
      payment_no: string;
      payment_kind: string;
      amount: string;
      status: string;
      tenant_id: string;
    }>();

  if (!payment) return { error: "That payment no longer exists." };
  if (payment.status === "voided") {
    return { error: "This payment has been voided, so it cannot be applied." };
  }
  // A deposit is held against the contract and a refund is money out; the
  // database refuses both, and saying so here is clearer than the raw error.
  if (payment.payment_kind === "deposit" || payment.payment_kind === "refund") {
    return {
      error: `A ${payment.payment_kind} is not a credit on account, so it cannot be set against an invoice.`,
    };
  }

  const { data: existing } = await supabase
    .from("payment_applications")
    .select("amount")
    .eq("payment_id", paymentId);

  const alreadyApplied = round2(
    (existing ?? []).reduce((sum, row) => sum + Number(row.amount), 0),
  );
  const unapplied = round2(Number(payment.amount) - alreadyApplied);

  /*
   * Tax the tenant withheld rides alongside the cash on the same invoice. It
   * is not part of the payment -- the money never arrived, it went to the BIR
   * on our behalf -- so it is read separately and never counted against what
   * is unapplied.
   */
  const decimal = (field: string) => {
    const value = String(formData.get(field) ?? "").trim();
    return value === "" ? 0 : round2(Number(value));
  };

  const rows: {
    invoice_id: string;
    amount: number;
    tax_withheld: number;
    vat_withheld: number;
    form_2307_no: string | null;
  }[] = [];

  for (const [field, raw] of formData.entries()) {
    if (!field.startsWith("apply:")) continue;
    const invoiceId = field.slice("apply:".length);
    const value = String(raw).trim();
    const amount = value === "" ? 0 : round2(Number(value));
    const taxWithheld = decimal(`wht:${invoiceId}`);
    const vatWithheld = decimal(`vat:${invoiceId}`);
    // A line that settles nothing at all is simply an untouched row.
    if (amount <= 0 && taxWithheld <= 0 && vatWithheld <= 0) continue;
    if (amount < 0 || taxWithheld < 0 || vatWithheld < 0) {
      return { error: "An amount cannot be negative." };
    }
    const form = String(formData.get(`form2307:${invoiceId}`) ?? "").trim();
    rows.push({
      invoice_id: invoiceId,
      amount,
      tax_withheld: taxWithheld,
      vat_withheld: vatWithheld,
      form_2307_no: form === "" ? null : form,
    });
  }

  if (rows.length === 0) {
    return { error: "Tick an invoice and enter how much of the credit to set against it." };
  }

  const total = round2(rows.reduce((sum, row) => sum + row.amount, 0));
  if (total > unapplied) {
    return {
      error: `Only ${unapplied.toFixed(2)} of this payment is unapplied, but ${total.toFixed(2)} has been entered.`,
    };
  }

  const withheld = round2(
    rows.reduce((sum, row) => sum + row.tax_withheld + row.vat_withheld, 0),
  );

  const { error } = await supabase
    .from("payment_applications")
    .insert(rows.map((row) => ({ payment_id: paymentId, ...row })));
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.payments,
    entityTable: "payments",
    entityId: paymentId,
    summary:
      `Applied ${total.toFixed(2)} of ${payment.payment_no} to ${rows.length} invoice(s)` +
      (withheld > 0 ? `, with ${withheld.toFixed(2)} tax withheld.` : "."),
    after: { applications: rows },
  });

  revalidatePath(`/payments/${paymentId}`);
  revalidatePath("/payments");
  revalidatePath("/billing/invoices");
  return {
    success:
      `Applied ${total.toFixed(2)} to ${rows.length} invoice${rows.length === 1 ? "" : "s"}` +
      (withheld > 0
        ? `, settling a further ${withheld.toFixed(2)} withheld as tax.`
        : "."),
  };
}

/**
 * Takes an application back off an invoice.
 *
 * Removing the row reverses its posting, which the ledger trigger does on
 * delete, so the credit returns to the tenant's account and the invoice goes
 * back to unpaid. The payment itself is untouched -- this undoes where the
 * money was pointed, not the fact that it was received.
 */
export async function unapplyPayment(formData: FormData) {
  try {
    await assertPermission(MODULE.payments, "edit");
  } catch {
    return;
  }

  const id = String(formData.get("id") ?? "");
  const paymentId = String(formData.get("payment_id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase
    .from("payment_applications")
    .delete()
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.payments,
    entityTable: "payments",
    entityId: paymentId,
    summary: "Took an application back off an invoice; the credit is unapplied again.",
  });

  revalidatePath(`/payments/${paymentId}`);
  revalidatePath("/billing/invoices");
}
