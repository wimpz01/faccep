"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

export async function createCategory(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.inventoryItems, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Category name is required." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("inventory_categories")
    .insert({ company_id: companyId, name });

  if (error) {
    return {
      error: error.code === "23505" ? "That category already exists." : error.message,
    };
  }

  revalidatePath("/inventory");
  return { success: `Category "${name}" added.` };
}

const itemSchema = z.object({
  name: z.string().trim().min(2, "Item name is required."),
  sku: z.string().trim().optional().or(z.literal("")),
  category_id: z.string().uuid().optional().or(z.literal("")),
  unit_of_measure: z.string().trim().min(1, "Unit of measure is required."),
  reorder_level: z.coerce.number().min(0),
  unit_cost: z.coerce.number().min(0),
});

export async function createItem(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.inventoryItems, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = itemSchema.safeParse({
    name: formData.get("name"),
    sku: formData.get("sku"),
    category_id: formData.get("category_id"),
    unit_of_measure: formData.get("unit_of_measure") || "pc",
    reorder_level: formData.get("reorder_level") || 0,
    unit_cost: formData.get("unit_cost") || 0,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("inventory_items")
    .insert({
      company_id: companyId,
      ...parsed.data,
      sku: parsed.data.sku || null,
      category_id: parsed.data.category_id || null,
    })
    .select("id")
    .single();

  if (error) {
    return {
      error: error.code === "23505" ? "That item already exists." : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.inventoryItems,
    entityTable: "inventory_items",
    entityId: data.id,
    summary: `Added inventory item "${parsed.data.name}".`,
    after: parsed.data,
  });

  revalidatePath("/inventory");
  return { success: `"${parsed.data.name}" added.` };
}

/**
 * Records a stock movement. The sign is applied here from the movement kind so
 * the ledger always sums to the balance -- callers never pass a negative.
 */
export async function recordMovement(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.inventoryMovements, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const itemId = String(formData.get("item_id") ?? "");
  const kind = String(formData.get("movement_kind") ?? "");
  const magnitude = Number(formData.get("quantity") ?? 0);
  const note = String(formData.get("note") ?? "").trim();

  if (!itemId) return { error: "Choose an item." };
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return { error: "Enter a quantity greater than zero." };
  }
  if (!["receipt", "issue", "return", "adjustment"].includes(kind)) {
    return { error: "Unknown movement type." };
  }

  const supabase = await createClient();
  const { data: item } = await supabase
    .from("inventory_items")
    .select("name, quantity_on_hand, unit_cost")
    .eq("id", itemId)
    .single();

  if (!item) return { error: "Item not found." };

  const direction = kind === "issue" ? -1 : 1;
  const signed =
    kind === "adjustment"
      ? Number(formData.get("adjust_direction") === "down" ? -magnitude : magnitude)
      : direction * magnitude;

  if (signed < 0 && Number(item.quantity_on_hand) + signed < 0) {
    return {
      error: `Only ${Number(item.quantity_on_hand)} on hand — cannot take out ${magnitude}.`,
    };
  }

  const { error } = await supabase.from("inventory_movements").insert({
    company_id: companyId,
    item_id: itemId,
    movement_kind: kind,
    quantity: signed,
    unit_cost: item.unit_cost,
    note: note || null,
    created_by: userId,
  });

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.inventoryMovements,
    entityTable: "inventory_movements",
    entityId: itemId,
    summary: `${kind} of ${magnitude} ${item.name}${note ? ` — ${note}` : ""}.`,
    after: { kind, quantity: signed },
  });

  revalidatePath("/inventory");
  return { success: `Recorded ${kind} of ${magnitude} ${item.name}.` };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function createTool(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.inventoryTools, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Tool name is required." };

  const supabase = await createClient();
  const { error } = await supabase.from("tools").insert({
    company_id: companyId,
    name,
    serial_no: String(formData.get("serial_no") ?? "").trim() || null,
    condition: String(formData.get("condition") ?? "").trim() || null,
  });

  if (error) return { error: error.message };

  revalidatePath("/inventory/tools");
  return { success: `"${name}" added.` };
}

/** Borrow slip: who took it, when, and when it is due back (spec 9). */
export async function borrowTool(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.inventoryTools, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const toolId = String(formData.get("tool_id") ?? "");
  const borrower = String(formData.get("borrower_name") ?? "").trim();
  if (!toolId || !borrower) return { error: "Choose a tool and name the borrower." };

  const supabase = await createClient();
  const { error } = await supabase.from("tool_loans").insert({
    company_id: companyId,
    tool_id: toolId,
    borrower_name: borrower,
    expected_return: String(formData.get("expected_return") ?? "") || null,
    condition_out: String(formData.get("condition_out") ?? "").trim() || null,
    note: String(formData.get("note") ?? "").trim() || null,
  });

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That tool is already out on loan."
          : error.message,
    };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.inventoryTools,
    entityTable: "tool_loans",
    entityId: toolId,
    summary: `${borrower} borrowed a tool.`,
    after: { borrower },
  });

  revalidatePath("/inventory/tools");
  return { success: `Issued to ${borrower}.` };
}

export async function returnTool(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.inventoryTools, "edit")) return;

  const loanId = String(formData.get("loan_id") ?? "");
  const conditionIn = String(formData.get("condition_in") ?? "").trim();

  const supabase = await createClient();
  const { error } = await supabase
    .from("tool_loans")
    .update({
      returned_at: new Date().toISOString().slice(0, 10),
      condition_in: conditionIn || null,
    })
    .eq("id", loanId);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.inventoryTools,
    entityTable: "tool_loans",
    entityId: loanId,
    summary: `Tool returned${conditionIn ? ` in ${conditionIn} condition` : ""}.`,
  });

  revalidatePath("/inventory/tools");
}
