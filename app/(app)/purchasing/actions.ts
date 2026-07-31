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

async function nextNumber(companyId: string, table: string, column: string, prefix: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from(table)
    .select(column)
    .eq("company_id", companyId)
    .ilike(column, `${prefix}%`)
    .order(column, { ascending: false })
    .limit(1);

  const last = (data?.[0] as Record<string, string> | undefined)?.[column];
  const next = last ? Number(last.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(next) ? next : 1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

const vendorSchema = z.object({
  name: z.string().trim().min(2, "Supplier name is required."),
  tin: z.string().trim().optional().or(z.literal("")),
  address: z.string().trim().optional().or(z.literal("")),
  contact_person: z.string().trim().optional().or(z.literal("")),
  contact_number: z.string().trim().optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email.").optional().or(z.literal("")),
  payment_terms: z.string().trim().optional().or(z.literal("")),
});

export async function createVendor(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.purchasingVendors, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = vendorSchema.safeParse({
    name: formData.get("name"),
    tin: formData.get("tin"),
    address: formData.get("address"),
    contact_person: formData.get("contact_person"),
    contact_number: formData.get("contact_number"),
    email: formData.get("email"),
    payment_terms: formData.get("payment_terms"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const values = Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [key, value === "" ? null : value]),
  );

  const { data, error } = await supabase
    .from("vendors")
    .insert({ company_id: companyId, ...values, name: parsed.data.name })
    .select("id")
    .single();

  if (error) {
    return {
      error: error.code === "23505" ? "That supplier already exists." : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.purchasingVendors,
    entityTable: "vendors",
    entityId: data.id,
    summary: `Added supplier "${parsed.data.name}".`,
    after: parsed.data,
  });

  revalidatePath("/purchasing/vendors");
  return { success: `"${parsed.data.name}" added.` };
}

// ---------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------

/**
 * Reads the line rows: `line_desc[]`, `line_qty[]`, `line_price[]`,
 * `line_item[]`, `line_expense[]`.
 *
 * A line is either stocked or not. A stocked line is charged to Inventory, so
 * any expense account is dropped; a non-stock line keeps the account it was
 * charged to, and falls back to the company default when left blank.
 */
function readLines(formData: FormData) {
  const descriptions = formData.getAll("line_desc").map(String);
  const quantities = formData.getAll("line_qty").map(String);
  const prices = formData.getAll("line_price").map(String);
  const items = formData.getAll("line_item").map(String);
  const expenses = formData.getAll("line_expense").map(String);

  const lines: {
    item_id: string | null;
    expense_account_id: string | null;
    description: string;
    quantity: number;
    price: number;
  }[] = [];

  for (let index = 0; index < descriptions.length; index += 1) {
    const description = descriptions[index]?.trim();
    const quantity = Number(quantities[index]);
    if (!description || !Number.isFinite(quantity) || quantity <= 0) continue;

    const itemId = items[index] || null;
    lines.push({
      item_id: itemId,
      expense_account_id: itemId ? null : expenses[index] || null,
      description,
      quantity,
      price: Number(prices[index]) || 0,
    });
  }

  return lines;
}

export async function createPurchaseRequest(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.purchasingRequests, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const lines = readLines(formData);
  if (lines.length === 0) return { error: "Add at least one line with a quantity." };

  const supabase = await createClient();
  const requestNo = await nextNumber(
    companyId,
    "purchase_requests",
    "request_no",
    `PR-${new Date().getFullYear()}-`,
  );

  const { data: request, error } = await supabase
    .from("purchase_requests")
    .insert({
      company_id: companyId,
      request_no: requestNo,
      job_id: String(formData.get("job_id") ?? "") || null,
      needed_by: String(formData.get("needed_by") ?? "") || null,
      justification: String(formData.get("justification") ?? "").trim() || null,
      requested_by: userId,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  const { error: lineError } = await supabase.from("purchase_request_lines").insert(
    lines.map((line) => ({
      request_id: request.id,
      item_id: line.item_id,
      expense_account_id: line.expense_account_id,
      description: line.description,
      quantity: line.quantity,
      estimated_price: line.price,
    })),
  );
  if (lineError) return { error: lineError.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.purchasingRequests,
    entityTable: "purchase_requests",
    entityId: request.id,
    summary: `Raised purchase request ${requestNo} with ${lines.length} line(s).`,
    after: { lines },
  });

  revalidatePath("/purchasing/requests");
  return { success: `${requestNo} raised. Submit it for approval when ready.` };
}

/** Submitting routes it through the shared approval queue (spec 10). */
export async function submitPurchaseRequest(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.purchasingRequests, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("purchase_requests")
    .select("request_no, status, justification")
    .eq("id", id)
    .single();

  if (!request) return { error: "Request not found." };
  if (request.status !== "draft") return { error: "Already submitted." };

  const failure = await requestApproval({
    moduleKey: MODULE.purchasingRequests,
    entityTable: "purchase_requests",
    entityId: id,
    action: "approve",
    reason: request.justification ?? `Purchase request ${request.request_no}`,
    summary: `purchase request ${request.request_no}`,
  });
  if (failure) return { error: failure };

  await supabase.from("purchase_requests").update({ status: "pending" }).eq("id", id);

  revalidatePath("/purchasing/requests");
  return { success: "Submitted. Nothing can be ordered until it is approved." };
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.purchasingOrders, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const vendorId = String(formData.get("vendor_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");
  if (!vendorId) return { error: "Choose a supplier." };

  const supabase = await createClient();

  // Only an approved request may become an order (spec 10).
  if (requestId) {
    const { data: request } = await supabase
      .from("purchase_requests")
      .select("status, request_no")
      .eq("id", requestId)
      .single();
    if (!request) return { error: "Purchase request not found." };
    if (request.status !== "approved") {
      return {
        error: `${request.request_no} is ${request.status} — it must be approved before ordering.`,
      };
    }
  }

  const lines = readLines(formData);
  if (lines.length === 0) return { error: "Add at least one line." };

  const poNo = await nextNumber(
    companyId,
    "purchase_orders",
    "po_no",
    `PO-${new Date().getFullYear()}-`,
  );

  const { data: order, error } = await supabase
    .from("purchase_orders")
    .insert({
      company_id: companyId,
      vendor_id: vendorId,
      request_id: requestId || null,
      po_no: poNo,
      expected_date: String(formData.get("expected_date") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  const { error: lineError } = await supabase.from("purchase_order_lines").insert(
    lines.map((line) => ({
      po_id: order.id,
      item_id: line.item_id,
      expense_account_id: line.expense_account_id,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.price,
      amount: round2(line.quantity * line.price),
    })),
  );
  if (lineError) return { error: lineError.message };

  if (requestId) {
    await supabase
      .from("purchase_requests")
      .update({ status: "ordered" })
      .eq("id", requestId);
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.purchasingOrders,
    entityTable: "purchase_orders",
    entityId: order.id,
    summary: `Created purchase order ${poNo}.`,
    after: { lines },
  });

  redirect(`/purchasing/orders/${order.id}`);
}

export async function issuePurchaseOrder(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.purchasingOrders, "approve")) return;

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: order } = await supabase
    .from("purchase_orders")
    .select("po_no, status")
    .eq("id", id)
    .single();
  if (order?.status !== "draft") return;

  await supabase.from("purchase_orders").update({ status: "issued" }).eq("id", id);

  await logAudit({
    action: "approve",
    moduleKey: MODULE.purchasingOrders,
    entityTable: "purchase_orders",
    entityId: id,
    summary: `Issued purchase order ${order.po_no} to the supplier.`,
  });

  revalidatePath(`/purchasing/orders/${id}`);
}

/**
 * Receiving. The trigger rolls each quantity onto the PO line, moves the order
 * status, and pushes stock into inventory for lines tied to an item.
 */
export async function receiveGoods(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.purchasingReceiving, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const poId = String(formData.get("po_id") ?? "");
  const supabase = await createClient();

  const { data: order } = await supabase
    .from("purchase_orders")
    .select("po_no, status, purchase_order_lines(id, description, quantity, quantity_received)")
    .eq("id", poId)
    .single<{
      po_no: string;
      status: string;
      purchase_order_lines: {
        id: string;
        description: string;
        quantity: string;
        quantity_received: string;
      }[];
    }>();

  if (!order) return { error: "Purchase order not found." };
  if (order.status === "draft") {
    return { error: "Issue the order to the supplier before receiving against it." };
  }

  const received: { po_line_id: string; quantity: number }[] = [];
  for (const line of order.purchase_order_lines ?? []) {
    const raw = String(formData.get(`receive:${line.id}`) ?? "").trim();
    if (raw === "") continue;
    const quantity = Number(raw);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const outstanding = Number(line.quantity) - Number(line.quantity_received);
    if (quantity > outstanding) {
      return {
        error: `${line.description}: only ${outstanding} still outstanding.`,
      };
    }
    received.push({ po_line_id: line.id, quantity });
  }

  if (received.length === 0) return { error: "Enter at least one received quantity." };

  const receiptNo = await nextNumber(
    companyId,
    "goods_receipts",
    "receipt_no",
    `GR-${new Date().getFullYear()}-`,
  );

  const { data: receipt, error } = await supabase
    .from("goods_receipts")
    .insert({
      company_id: companyId,
      po_id: poId,
      receipt_no: receiptNo,
      received_by: userId,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  const { error: lineError } = await supabase
    .from("goods_receipt_lines")
    .insert(received.map((row) => ({ receipt_id: receipt.id, ...row })));
  if (lineError) return { error: lineError.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.purchasingReceiving,
    entityTable: "goods_receipts",
    entityId: receipt.id,
    summary: `Received ${received.length} line(s) on ${order.po_no} as ${receiptNo}.`,
    after: { received },
  });

  revalidatePath(`/purchasing/orders/${poId}`);
  revalidatePath("/inventory");
  return { success: `${receiptNo} recorded. Stock has been updated.` };
}
