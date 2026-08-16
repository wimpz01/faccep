"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/**
 * Opens the settlement for one contract's deposit.
 *
 * Only one may be live at a time -- the database holds that -- because a
 * deposit is settled once and a second open document would mean two answers to
 * what is refundable.
 */
export async function openSettlement(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.contractDeposits, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const contractId = String(formData.get("contract_id") ?? "");
  if (!contractId) return { error: "Choose the contract to settle." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deposit_settlements")
    .insert({
      company_id: companyId,
      contract_id: contractId,
      settled_on: String(formData.get("settled_on") ?? "").slice(0, 10) ||
        new Date().toISOString().slice(0, 10),
      notes: String(formData.get("notes") ?? "").trim() || null,
      prepared_by: userId,
    })
    .select("id")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "This contract already has a settlement open. Finish or cancel that one first."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.contractDeposits,
    entityTable: "deposit_settlements",
    entityId: data.id,
    summary: "Opened a deposit settlement.",
  });

  redirect(`/deposits/${data.id}`);
}

const lineSchema = z.object({
  settlement_id: z.string().uuid(),
  kind: z.enum(["deduction", "forfeiture"]),
  description: z.string().trim().min(2, "Say what the amount is for."),
  amount: z.coerce.number().positive("Enter an amount above zero."),
  invoice_id: z.string().uuid().nullish().or(z.literal("")),
});

/**
 * Adds one thing being kept out of the deposit.
 *
 * A line naming an invoice settles that bill; one naming none is a repair or
 * damage charge. Which it is decides where the money goes in the ledger when
 * the settlement is approved, so it is asked here rather than inferred later.
 */
export async function addSettlementLine(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.contractDeposits, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = lineSchema.safeParse({
    settlement_id: formData.get("settlement_id"),
    kind: formData.get("kind"),
    description: formData.get("description"),
    amount: formData.get("amount"),
    invoice_id: formData.get("invoice_id"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  // A forfeiture answers to the contract's terms, not to a bill.
  const invoiceId =
    parsed.data.kind === "forfeiture" ? null : parsed.data.invoice_id || null;

  const supabase = await createClient();
  const { error } = await supabase.from("deposit_settlement_lines").insert({
    settlement_id: parsed.data.settlement_id,
    kind: parsed.data.kind,
    description: parsed.data.description,
    amount: parsed.data.amount,
    invoice_id: invoiceId,
  });
  if (error) return { error: error.message };

  revalidatePath(`/deposits/${parsed.data.settlement_id}`);
  return { success: "Added." };
}

export async function removeSettlementLine(formData: FormData) {
  try {
    await assertPermission(MODULE.contractDeposits, "edit");
  } catch {
    return;
  }

  const id = String(formData.get("id") ?? "");
  const settlementId = String(formData.get("settlement_id") ?? "");
  const supabase = await createClient();
  await supabase.from("deposit_settlement_lines").delete().eq("id", id);

  revalidatePath(`/deposits/${settlementId}`);
}

/**
 * Approves the settlement, which is the only act that moves money.
 *
 * The permission is checked again inside the database function, so this is a
 * courtesy check that produces a readable message rather than the sole gate.
 */
export async function approveSettlement(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.contractDeposits, "approve");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_deposit_settlement", {
    p_settlement: id,
  });
  if (error) return { error: error.message };

  await logAudit({
    action: "approve",
    moduleKey: MODULE.contractDeposits,
    entityTable: "deposit_settlements",
    entityId: id,
    summary: "Approved a deposit settlement; the refundable balance is released.",
  });

  revalidatePath(`/deposits/${id}`);
  revalidatePath("/deposits");
  revalidatePath("/payments");
  return { success: "Approved. The refundable balance can now be paid out." };
}

export async function cancelSettlement(formData: FormData) {
  try {
    await assertPermission(MODULE.contractDeposits, "edit");
  } catch {
    return;
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  // Only a draft: an approved settlement has already moved the ledger.
  await supabase
    .from("deposit_settlements")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", "draft");

  await logAudit({
    action: "update",
    moduleKey: MODULE.contractDeposits,
    entityTable: "deposit_settlements",
    entityId: id,
    summary: "Cancelled a draft deposit settlement.",
  });

  revalidatePath("/deposits");
  redirect("/deposits");
}
