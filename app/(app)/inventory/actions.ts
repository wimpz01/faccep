"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
  category_id: z.string().uuid().nullish().or(z.literal("")),
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
      // The code comes from the counter; the trigger fills it in.
      category_id: parsed.data.category_id || null,
    })
    .select("id, sku")
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
    summary: `Added inventory item ${data.sku} "${parsed.data.name}".`,
    after: parsed.data,
  });

  revalidatePath("/inventory");
  return { success: `${data.sku} — "${parsed.data.name}" added.` };
}

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

/**
 * Splits one CSV line, honouring quoted fields.
 *
 * Excel quotes any field containing a comma, so "Cement, grey" has to survive
 * as a single value rather than becoming two columns.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(field.trim());
      field = "";
    } else {
      field += char;
    }
  }
  out.push(field.trim());
  return out;
}

/**
 * Adds many items from a pasted or uploaded CSV.
 *
 * Rows are validated first and the whole file is refused if any row is bad, so
 * a typo on line 40 cannot leave 39 items half-imported. Categories are matched
 * by name and created when new.
 */
export async function importItems(
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

  const raw = String(formData.get("csv") ?? "").trim();
  if (!raw) return { error: "Choose a file, or paste the rows in." };

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return { error: "That file has a header but no rows." };
  }

  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const missing = ["name", "unit_of_measure"].filter(
    (column) => !header.includes(column),
  );
  if (missing.length > 0) {
    return {
      error: `The header is missing: ${missing.join(", ")}. Export the template to see the expected columns.`,
    };
  }

  const at = (cells: string[], column: string) => {
    const index = header.indexOf(column);
    return index === -1 ? "" : (cells[index] ?? "");
  };

  const rows: {
    line: number;
    name: string;
    category: string;
    unit_of_measure: string;
    reorder_level: number;
    unit_cost: number;
  }[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const name = at(cells, "name");
    const line = i + 1;

    if (!name) {
      problems.push(`Line ${line}: no item name.`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      problems.push(`Line ${line}: "${name}" appears twice in this file.`);
      continue;
    }
    seen.add(name.toLowerCase());

    const reorder = Number(at(cells, "reorder_level") || 0);
    const cost = Number(at(cells, "unit_cost") || 0);
    if (!Number.isFinite(reorder) || reorder < 0) {
      problems.push(`Line ${line}: reorder level "${at(cells, "reorder_level")}" is not a number.`);
      continue;
    }
    if (!Number.isFinite(cost) || cost < 0) {
      problems.push(`Line ${line}: unit cost "${at(cells, "unit_cost")}" is not a number.`);
      continue;
    }

    rows.push({
      line,
      name,
      category: at(cells, "category"),
      unit_of_measure: at(cells, "unit_of_measure") || "pc",
      reorder_level: reorder,
      unit_cost: cost,
    });
  }

  if (problems.length > 0) {
    return {
      error: `Nothing was imported. ${problems.slice(0, 5).join(" ")}${
        problems.length > 5 ? ` (+${problems.length - 5} more)` : ""
      }`,
    };
  }
  if (rows.length === 0) return { error: "No usable rows in that file." };

  const supabase = await createClient();

  // Refuse the file if any name is already on file, rather than importing the
  // rest and leaving the operator to work out which ones landed.
  const { data: existing } = await supabase
    .from("inventory_items")
    .select("name")
    .eq("company_id", companyId);

  const onFile = new Set(
    (existing ?? []).map((row) => String(row.name).toLowerCase()),
  );
  const clashes = rows.filter((row) => onFile.has(row.name.toLowerCase()));
  if (clashes.length > 0) {
    return {
      error: `Nothing was imported. Already on file: ${clashes
        .slice(0, 5)
        .map((row) => `"${row.name}" (line ${row.line})`)
        .join(", ")}${clashes.length > 5 ? ` and ${clashes.length - 5} more` : ""}.`,
    };
  }

  // Categories named in the file that do not exist yet.
  const { data: categories } = await supabase
    .from("inventory_categories")
    .select("id, name")
    .eq("company_id", companyId);

  const byName = new Map(
    (categories ?? []).map((row) => [String(row.name).toLowerCase(), row.id]),
  );

  const newNames = [
    ...new Set(
      rows
        .map((row) => row.category)
        .filter(Boolean)
        .filter((name) => !byName.has(name.toLowerCase())),
    ),
  ];

  if (newNames.length > 0) {
    const { data: created, error: categoryError } = await supabase
      .from("inventory_categories")
      .insert(newNames.map((name) => ({ company_id: companyId, name })))
      .select("id, name");
    if (categoryError) return { error: categoryError.message };
    for (const row of created ?? []) {
      byName.set(String(row.name).toLowerCase(), row.id);
    }
  }

  const { data: inserted, error } = await supabase
    .from("inventory_items")
    .insert(
      rows.map((row) => ({
        company_id: companyId,
        name: row.name,
        category_id: row.category ? (byName.get(row.category.toLowerCase()) ?? null) : null,
        unit_of_measure: row.unit_of_measure,
        reorder_level: row.reorder_level,
        unit_cost: row.unit_cost,
      })),
    )
    .select("id, sku");

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.inventoryItems,
    entityTable: "inventory_items",
    summary: `Imported ${inserted?.length ?? 0} stock item(s) from a file.`,
    after: { items: rows.length, newCategories: newNames },
  });

  revalidatePath("/inventory");
  return {
    success: `${inserted?.length ?? 0} item(s) imported${
      newNames.length > 0 ? `, ${newNames.length} new categor${newNames.length === 1 ? "y" : "ies"} created` : ""
    }. Codes were issued automatically.`,
  };
}

/**
 * Records a stock movement. The sign is applied here from the movement kind so
 * the ledger always sums to the balance -- callers never pass a negative.
 */

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
// ---------------------------------------------------------------------------
// Stock adjustment: a numbered document that is saved first and posted when
// somebody is ready. Saving touches no stock; posting writes the ledger.
// ---------------------------------------------------------------------------

type AdjustmentLine = {
  item_id: string;
  quantity: number;
  unit_cost: number | null;
  note: string | null;
};

/** Reads the repeated line fields off the form into something storable. */
function readLines(
  formData: FormData,
  kind: string,
): { lines: AdjustmentLine[] } | { error: string } {
  const itemIds = formData.getAll("line_item_id").map(String);
  const quantities = formData.getAll("line_quantity").map(String);
  const directions = formData.getAll("line_direction").map(String);
  const costs = formData.getAll("line_unit_cost").map(String);
  const notes = formData.getAll("line_note").map(String);

  const lines: AdjustmentLine[] = [];
  for (let i = 0; i < itemIds.length; i += 1) {
    const itemId = itemIds[i];
    // A blank row is somebody who added a line and changed their mind.
    if (!itemId) continue;

    const magnitude = Number(quantities[i] ?? 0);
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      return { error: `Line ${i + 1}: enter a quantity greater than zero.` };
    }

    const rawCost = (costs[i] ?? "").trim();
    const unitCost = rawCost === "" ? null : Number(rawCost);
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
      return { error: `Line ${i + 1}: unit cost cannot be negative.` };
    }

    // The document's kind decides the direction; a count correction is the
    // only one that can go either way.
    const goesOut =
      kind === "issue" || (kind === "adjustment" && directions[i] === "down");

    lines.push({
      item_id: itemId,
      quantity: goesOut ? -magnitude : magnitude,
      unit_cost: unitCost,
      note: notes[i]?.trim() || null,
    });
  }

  if (lines.length === 0) return { error: "Add at least one item line." };
  return { lines };
}

/**
 * Saves a draft, and posts it when that is what was asked for.
 *
 * One action behind two buttons: the submitter says which. Saving and posting
 * share every step except the last, and splitting them would have meant two
 * copies of the same validation.
 */
export async function saveAdjustment(
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

  const intent = String(formData.get("intent") ?? "save");
  const id = String(formData.get("adjustment_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const kind = String(formData.get("movement_kind") ?? "adjustment");
  const adjustmentDate = String(formData.get("adjustment_date") ?? "").trim();

  if (!reason) return { error: "Give a reason for the adjustment." };
  if (!["receipt", "issue", "return", "adjustment"].includes(kind)) {
    return { error: "Choose a type for the adjustment." };
  }

  const parsed = readLines(formData, kind);
  if ("error" in parsed) return { error: parsed.error };

  const supabase = await createClient();
  let adjustmentId = id;

  if (adjustmentId) {
    const { error } = await supabase
      .from("inventory_adjustments")
      .update({
        reason,
        movement_kind: kind,
        adjustment_date: adjustmentDate || undefined,
      })
      .eq("id", adjustmentId);
    if (error) return { error: error.message };

    // Replacing the lines wholesale keeps the saved document identical to
    // what is on screen, including anything removed.
    const { error: clearError } = await supabase
      .from("inventory_adjustment_lines")
      .delete()
      .eq("adjustment_id", adjustmentId);
    if (clearError) return { error: clearError.message };
  } else {
    const { data: head, error } = await supabase
      .from("inventory_adjustments")
      .insert({
        company_id: companyId,
        reason,
        movement_kind: kind,
        adjustment_date: adjustmentDate || undefined,
        created_by: userId,
      })
      .select("id")
      .single();
    if (error || !head) {
      return { error: error?.message ?? "Could not open the adjustment." };
    }
    adjustmentId = head.id;
  }

  const { error: lineError } = await supabase
    .from("inventory_adjustment_lines")
    .insert(
      parsed.lines.map((line) => ({ ...line, adjustment_id: adjustmentId })),
    );
  if (lineError) return { error: lineError.message };

  if (intent === "post") {
    const { data: posted, error: postError } = await supabase
      .from("inventory_adjustments")
      .update({ status: "posted" })
      .eq("id", adjustmentId)
      .select("adjustment_no")
      .single();
    if (postError) return { error: postError.message };

    await logAudit({
      action: "create",
      moduleKey: MODULE.inventoryMovements,
      entityTable: "inventory_adjustments",
      entityId: adjustmentId,
      summary: `${posted?.adjustment_no}: ${parsed.lines.length} line(s) posted — ${reason}`,
      after: { lines: parsed.lines.length, reason, kind },
    });
  }

  revalidatePath("/inventory");
  revalidatePath("/inventory/adjustments");
  revalidatePath(`/inventory/adjustments/${adjustmentId}`);
  revalidatePath("/inventory/history");
  redirect(`/inventory/adjustments/${adjustmentId}`);
}

/** Throws away a draft. A posted adjustment is never deleted. */
export async function deleteAdjustment(formData: FormData) {
  await assertPermission(MODULE.inventoryMovements, "edit");

  const id = String(formData.get("adjustment_id") ?? "");
  const supabase = await createClient();

  const { data: head } = await supabase
    .from("inventory_adjustments")
    .select("status, adjustment_no")
    .eq("id", id)
    .single();

  // The database refuses to delete a posted one anyway; this is so the person
  // gets told rather than watching nothing happen.
  if (!head || head.status !== "draft") return;

  await supabase.from("inventory_adjustments").delete().eq("id", id);

  revalidatePath("/inventory/adjustments");
  redirect("/inventory/adjustments");
}

// ---------------------------------------------------------------------------
// Non-stock items: bought but never stocked, each carrying the expense
// account it is charged to.
// ---------------------------------------------------------------------------

const nonStockSchema = z.object({
  name: z.string().trim().min(2, "Give the item a name."),
  description: z.string().trim().nullish(),
  unit_of_measure: z.string().trim().min(1, "Unit of measure is required."),
  default_cost: z.coerce.number().min(0, "Cost cannot be negative."),
  expense_account_id: z.string().uuid("Choose the expense account it is charged to."),
});

export async function createNonStockItem(
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

  const parsed = nonStockSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    unit_of_measure: formData.get("unit_of_measure") || "lot",
    default_cost: formData.get("default_cost") || 0,
    expense_account_id: formData.get("expense_account_id"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("non_stock_items")
    .insert({
      company_id: companyId,
      ...parsed.data,
      description: parsed.data.description || null,
    })
    .select("id, code")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A non-stock item with that name already exists."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.inventoryItems,
    entityTable: "non_stock_items",
    entityId: data.id,
    summary: `Added non-stock item ${data.code} "${parsed.data.name}".`,
    after: parsed.data,
  });

  revalidatePath("/inventory/non-stock");
  return { success: `${data.code} — "${parsed.data.name}" added.` };
}

/** Points an existing non-stock item at a different expense account. */
export async function updateNonStockAccount(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.inventoryItems, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("item_id") ?? "");
  const accountId = String(formData.get("expense_account_id") ?? "");
  if (!id || !accountId) return { error: "Choose an account." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("non_stock_items")
    .update({ expense_account_id: accountId })
    .eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/inventory/non-stock");
  return { success: "Account updated. Purchases already made keep the account they were charged to." };
}

/** Sets where corrections to one stock item are charged. */
export async function updateItemAdjustmentAccount(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.inventoryItems, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("item_id") ?? "");
  const accountId = String(formData.get("adjustment_account_id") ?? "");
  if (!id) return { error: "Item not found." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("inventory_items")
    // Blank means fall back to the company's inventory adjustment account.
    .update({ adjustment_account_id: accountId || null })
    .eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/inventory/accounts");
  return { success: "Account saved." };
}

/** Sets which account one stock item is held in. */
export async function updateItemStockAccount(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.inventoryItems, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("item_id") ?? "");
  const accountId = String(formData.get("inventory_account_id") ?? "");
  if (!id) return { error: "Item not found." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("inventory_items")
    .update({ inventory_account_id: accountId || null })
    .eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/inventory/accounts");
  return { success: "Account saved." };
}

/**
 * Changes an item's own setup.
 *
 * Everything here describes the item rather than its stock: what it is called,
 * how it is counted, when to reorder, and which accounts it belongs to. What
 * is on hand is never among them -- that is the ledger's answer, and typing
 * over it would make the two disagree.
 */
const updateItemSchema = z.object({
  name: z.string().trim().min(2, "Item name is required."),
  category_id: z.string().uuid().nullish().or(z.literal("")),
  unit_of_measure: z.string().trim().min(1, "Unit of measure is required."),
  reorder_level: z.coerce.number().min(0, "Reorder level cannot be negative."),
  unit_cost: z.coerce.number().min(0, "Unit cost cannot be negative."),
  inventory_account_id: z.string().uuid().nullish().or(z.literal("")),
  adjustment_account_id: z.string().uuid().nullish().or(z.literal("")),
  is_active: z.coerce.boolean(),
});

export async function updateItem(
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

  const id = String(formData.get("item_id") ?? "");
  if (!id) return { error: "Item not found." };

  const parsed = updateItemSchema.safeParse({
    name: formData.get("name"),
    category_id: formData.get("category_id"),
    unit_of_measure: formData.get("unit_of_measure") || "pc",
    reorder_level: formData.get("reorder_level") || 0,
    unit_cost: formData.get("unit_cost") || 0,
    inventory_account_id: formData.get("inventory_account_id"),
    adjustment_account_id: formData.get("adjustment_account_id"),
    is_active: formData.get("is_active") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("inventory_items")
    .select("name, unit_of_measure, unit_cost, reorder_level, is_active")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!before) return { error: "Item not found." };

  const { error } = await supabase
    .from("inventory_items")
    .update({
      ...parsed.data,
      category_id: parsed.data.category_id || null,
      // Blank means fall back to the company's account.
      inventory_account_id: parsed.data.inventory_account_id || null,
      adjustment_account_id: parsed.data.adjustment_account_id || null,
    })
    .eq("id", id)
    .eq("company_id", companyId);

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "Another item already has that name."
          : error.message,
    };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.inventoryItems,
    entityTable: "inventory_items",
    entityId: id,
    summary: `Updated ${parsed.data.name}.`,
    before,
    after: parsed.data,
  });

  revalidatePath("/inventory");
  revalidatePath(`/inventory/${id}`);
  return { success: "Saved." };
}

/**
 * Corrects a category's name.
 *
 * A category is a label, not a record with a history, so a misspelling is
 * fixed in place rather than by making a second one and moving items across.
 * Every item already pointing at it keeps pointing at it -- the name changes,
 * the grouping does not.
 */
export async function renameCategory(
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

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id) return { error: "Missing category." };
  if (!name) return { error: "Category name is required." };

  const supabase = await createClient();
  const { data: changed, error } = await supabase
    .from("inventory_categories")
    .update({ name })
    .eq("id", id)
    .eq("company_id", companyId)
    .select("id");

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "Another category already has that name."
          : error.message,
    };
  }
  // An update that matched nothing is a silent no-op otherwise.
  if (!changed || changed.length === 0) {
    return { error: "That category is not in this company, or no longer exists." };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.inventoryItems,
    entityTable: "inventory_categories",
    entityId: id,
    summary: `Renamed a category to "${name}".`,
    after: { name },
  });

  revalidatePath("/inventory/categories");
  revalidatePath("/inventory");
  return { success: `Renamed to "${name}".` };
}

/**
 * Corrects a non-stock item's details.
 *
 * Everything about the item in one save: the name, what it is, the unit, the
 * usual cost and the expense account it is charged to. None of it could be
 * corrected once the item was created, so a misspelling was permanent.
 *
 * Changing the account changes where future purchases land. Bills already
 * raised keep the account they were charged to -- the ledger is not rewritten
 * behind them.
 *
 * The code is not editable. It is how the item is referred to on orders and
 * bills already raised, and renaming a reference is how those stop matching.
 */
export async function updateNonStockItem(
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

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing item." };

  const parsed = nonStockSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    unit_of_measure: formData.get("unit_of_measure") || "lot",
    default_cost: formData.get("default_cost") || 0,
    expense_account_id: formData.get("expense_account_id"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data: changed, error } = await supabase
    .from("non_stock_items")
    .update({ ...parsed.data, description: parsed.data.description || null })
    .eq("id", id)
    .eq("company_id", companyId)
    .select("id, code");

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "Another non-stock item already has that name."
          : error.message,
    };
  }
  if (!changed || changed.length === 0) {
    return { error: "That item is not in this company, or no longer exists." };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.inventoryItems,
    entityTable: "non_stock_items",
    entityId: id,
    summary: `Updated non-stock item ${changed[0].code}.`,
    after: parsed.data,
  });

  revalidatePath("/inventory/non-stock");
  return { success: `${changed[0].code} updated.` };
}
