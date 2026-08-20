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

// ---------------------------------------------------------------------------
// Payment terms
// ---------------------------------------------------------------------------

export async function createPaymentTerm(
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

  const name = String(formData.get("name") ?? "").trim();
  const days = Number(formData.get("days") ?? 0);

  if (name.length < 2) return { error: "Give the term a name." };
  if (!Number.isInteger(days) || days < 0) {
    return { error: "Days must be a whole number, zero or more." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("payment_terms")
    .insert({ company_id: companyId, name, days, sort_order: days });

  if (error) {
    return {
      error:
        error.code === "23505" ? "That term already exists." : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.purchasingVendors,
    entityTable: "payment_terms",
    summary: `Added payment term "${name}" (${days} day(s)).`,
    after: { name, days },
  });

  revalidatePath("/purchasing/terms");
  revalidatePath("/purchasing/vendors");
  return { success: `"${name}" added.` };
}

/** Retires a term or brings it back. Suppliers already on it keep it. */
export async function setPaymentTermActive(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.purchasingVendors, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("payment_terms")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  if (!before) return { error: "Term not found." };

  const { error } = await supabase
    .from("payment_terms")
    .update({ is_active: active })
    .eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.purchasingVendors,
    entityTable: "payment_terms",
    entityId: id,
    summary: `Payment term "${before.name}" ${active ? "brought back" : "retired"}.`,
    after: { is_active: active },
  });

  revalidatePath("/purchasing/terms");
  revalidatePath("/purchasing/vendors");
  return { success: `"${before.name}" ${active ? "is available again" : "retired"}.` };
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

const vendorSchema = z.object({
  name: z.string().trim().min(2, "Supplier name is required."),
  tin: z.string().trim().nullish().or(z.literal("")),
  address: z.string().trim().nullish().or(z.literal("")),
  zip_code: z.string().trim().nullish().or(z.literal("")),
  atc_code: z.string().trim().toUpperCase().nullish().or(z.literal("")),
  contact_person: z.string().trim().nullish().or(z.literal("")),
  contact_number: z.string().trim().nullish().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email.").nullish().or(z.literal("")),
  payment_terms_id: z.string().uuid().nullish().or(z.literal("")),
  withholding: z.enum(["none", "goods", "services"]).default("none"),
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
    zip_code: formData.get("zip_code"),
    atc_code: formData.get("atc_code"),
    contact_person: formData.get("contact_person"),
    contact_number: formData.get("contact_number"),
    email: formData.get("email"),
    payment_terms_id: formData.get("payment_terms_id"),
    withholding: formData.get("withholding") || "none",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const isVatable = formData.get("is_vatable") === "on";
  // The database refuses the pair too; catching it here gives a plain message
  // instead of a constraint name.
  if (!isVatable && parsed.data.withholding !== "none") {
    return {
      error:
        "Withholding tax only applies to a VAT-registered supplier. Tick VAT-registered, or set withholding to none.",
    };
  }

  const supabase = await createClient();
  const values = Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [key, value === "" ? null : value]),
  );

  const { data, error } = await supabase
    .from("vendors")
    .insert({
      company_id: companyId,
      ...values,
      name: parsed.data.name,
      is_vatable: isVatable,
      withholding: parsed.data.withholding,
    })
    .select("id, vendor_no")
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
    summary: `Added supplier ${data.vendor_no} "${parsed.data.name}" (pending approval).`,
    after: parsed.data,
  });

  // A supplier is unusable until signed off, so the request goes up straight
  // away rather than waiting for someone to remember to submit it.
  const failure = await requestApproval({
    moduleKey: MODULE.purchasingVendors,
    entityTable: "vendors",
    entityId: data.id,
    action: "approve",
    reason: `New supplier ${data.vendor_no} "${parsed.data.name}"`,
    summary: `supplier ${data.vendor_no}`,
  });
  if (failure) return { error: failure };

  revalidatePath("/purchasing/vendors");
  revalidatePath("/approvals");
  return {
    success: `${data.vendor_no} — "${parsed.data.name}" added. It cannot be used until approved.`,
  };
}

/**
 * Fills in what BIR Form 2307 asks for about a supplier already on file.
 *
 * Kept apart from the supplier's commercial terms on purpose. VAT status,
 * withholding and payment terms were signed off when the supplier was
 * approved, and changing those should go back through approval. A TIN, an
 * address or an ATC is only ever the supplier telling us what to print on
 * their certificate, so recording it needs no decision from anyone.
 */
export async function updateVendorTaxDetails(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.purchasingVendors, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = z
    .object({
      id: z.string().uuid(),
      tin: z.string().trim().nullish().or(z.literal("")),
      address: z.string().trim().nullish().or(z.literal("")),
      zip_code: z.string().trim().nullish().or(z.literal("")),
      atc_code: z.string().trim().toUpperCase().nullish().or(z.literal("")),
    })
    .safeParse({
      id: formData.get("id"),
      tin: formData.get("tin"),
      address: formData.get("address"),
      zip_code: formData.get("zip_code"),
      atc_code: formData.get("atc_code"),
    });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { id, ...fields } = parsed.data;
  const values = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value === "" || value == null ? null : value,
    ]),
  );

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vendors")
    .update(values)
    .eq("id", id)
    .select("vendor_no, name")
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) {
    return { error: "That supplier could not be updated from this account." };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.purchasingVendors,
    entityTable: "vendors",
    entityId: id,
    summary: `Updated tax details for supplier ${data.vendor_no} "${data.name}".`,
    after: values,
  });

  revalidatePath("/purchasing/vendors");
  return { success: `${data.vendor_no} — tax details saved.` };
}

/**
 * Puts a pending supplier back in the approvals queue.
 *
 * A supplier is normally queued the moment it is created, so this only matters
 * when the request has gone missing -- a restore from backup, a queue tidied
 * too enthusiastically. Without it the supplier is stranded: unusable because
 * it is pending, and unapprovable because there is nothing to decide.
 */
export async function resendVendorApproval(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.purchasingVendors, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: vendor } = await supabase
    .from("vendors")
    .select("id, vendor_no, name, status")
    .eq("id", id)
    .maybeSingle();

  if (!vendor) return { error: "Supplier not found." };
  if (vendor.status !== "pending") {
    return { error: `${vendor.vendor_no} has already been decided.` };
  }

  const failure = await requestApproval({
    moduleKey: MODULE.purchasingVendors,
    entityTable: "vendors",
    entityId: id,
    action: "approve",
    reason: `New supplier ${vendor.vendor_no} "${vendor.name}"`,
    summary: `supplier ${vendor.vendor_no}`,
  });
  if (failure) return { error: failure };

  revalidatePath("/purchasing/vendors");
  revalidatePath("/approvals");
  return { success: `${vendor.vendor_no} sent for approval.` };
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

  const jobId = String(formData.get("job_id") ?? "") || null;
  let locationId = String(formData.get("location_id") ?? "") || null;

  // A request raised against a job is for wherever that job is, so the
  // property does not have to be picked a second time.
  if (jobId && !locationId) {
    const { data: job } = await supabase
      .from("maintenance_jobs")
      .select("location_id")
      .eq("id", jobId)
      .maybeSingle();
    locationId = job?.location_id ?? null;
  }

  const { data: request, error } = await supabase
    .from("purchase_requests")
    .insert({
      company_id: companyId,
      job_id: jobId,
      location_id: locationId,
      needed_by: String(formData.get("needed_by") ?? "") || null,
      justification: String(formData.get("justification") ?? "").trim() || null,
      requested_by: userId,
    })
    .select("id, request_no")
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
    summary: `Raised purchase request ${request.request_no} with ${lines.length} line(s).`,
    after: { lines },
  });

  revalidatePath("/purchasing/requests");
  return { success: `${request.request_no} raised. Submit it for approval when ready.` };
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

  // The property follows the request unless this order is raised standalone.
  let locationId = String(formData.get("location_id") ?? "") || null;

  // Only an approved request may become an order (spec 10).
  if (requestId) {
    const { data: request } = await supabase
      .from("purchase_requests")
      .select("status, request_no, location_id")
      .eq("id", requestId)
      .single();
    if (!request) return { error: "Purchase request not found." };
    if (request.status !== "approved") {
      return {
        error: `${request.request_no} is ${request.status} — it must be approved before ordering.`,
      };
    }
    locationId = request.location_id;
  }

  const lines = readLines(formData);
  if (lines.length === 0) return { error: "Add at least one line." };

  const { data: order, error } = await supabase
    .from("purchase_orders")
    .insert({
      company_id: companyId,
      vendor_id: vendorId,
      request_id: requestId || null,
      location_id: locationId,
      expected_date: String(formData.get("expected_date") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id, po_no")
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
    summary: `Created purchase order ${order.po_no}.`,
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
 * Ends an order that still has something outstanding.
 *
 * A draft never left the building, so cancelling it is ordinary editing. An
 * order already with the supplier is a commitment being withdrawn -- the same
 * weight as sending it out -- so it asks for the same sign-off that issuing
 * does. Without that, cancelling would be a way around the issue gate.
 *
 * On a part-delivered order this closes the undelivered balance. Goods that
 * arrived stay in stock and can still be billed; the database enforces the
 * same rules, so none of this can be worked around from the API.
 */
export async function cancelPurchaseOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let context: Awaited<ReturnType<typeof assertPermission>>;
  try {
    context = await assertPermission(MODULE.purchasingOrders, "view");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Say why the order is being cancelled." };

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select("po_no, status, notes")
    .eq("id", id)
    .maybeSingle<{ po_no: string; status: string; notes: string | null }>();

  if (!order) return { error: "Purchase order not found." };
  if (order.status === "cancelled") {
    return { error: `${order.po_no} is already cancelled.` };
  }
  if (order.status === "received") {
    return {
      error: `${order.po_no} has been received in full, so there is nothing outstanding to cancel.`,
    };
  }

  const isDraft = order.status === "draft";
  const needed = isDraft ? "edit" : "approve";
  if (!can(context.permissions, MODULE.purchasingOrders, needed)) {
    return {
      error: isDraft
        ? "Cancelling an order needs Edit on purchase orders."
        : `${order.po_no} is already with the supplier. Withdrawing it needs Approve on purchase orders.`,
    };
  }

  const { data: cancelled, error } = await supabase
    .from("purchase_orders")
    .update({
      status: "cancelled",
      notes: [order.notes, `Cancelled: ${reason}`].filter(Boolean).join(" · "),
    })
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message };
  if (!cancelled || cancelled.length === 0) {
    return {
      error: `${order.po_no} was not cancelled — this account cannot write to that order.`,
    };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.purchasingOrders,
    entityTable: "purchase_orders",
    entityId: id,
    summary: `Cancelled purchase order ${order.po_no}: ${reason}`,
    before: { status: order.status },
    after: { status: "cancelled" },
  });

  revalidatePath(`/purchasing/orders/${id}`);
  revalidatePath("/purchasing/orders");
  return {
    success:
      order.status === "partially_received"
        ? `${order.po_no} cancelled. The undelivered balance is closed; what arrived stays in stock and can still be billed.`
        : `${order.po_no} cancelled. Nothing more can be bought on it.`,
  };
}

/**
 * Takes back an issue, returning the order to draft so its lines can be fixed
 * and it can go out again. Refused once anything has been received.
 */
export async function unissuePurchaseOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.purchasingOrders, "approve");
  } catch {
    return { error: "Taking back an issue needs Approve on purchase orders." };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: order } = await supabase
    .from("purchase_orders")
    .select("po_no, status")
    .eq("id", id)
    .maybeSingle<{ po_no: string; status: string }>();

  if (!order) return { error: "Purchase order not found." };
  if (order.status !== "issued") {
    return {
      error: `${order.po_no} is ${order.status.replace("_", " ")}, so there is no issue to take back.`,
    };
  }

  const { error } = await supabase
    .from("purchase_orders")
    .update({ status: "draft" })
    .eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.purchasingOrders,
    entityTable: "purchase_orders",
    entityId: id,
    summary: `Took back the issue of ${order.po_no}. It is a draft again.`,
    before: { status: "issued" },
    after: { status: "draft" },
  });

  revalidatePath(`/purchasing/orders/${id}`);
  revalidatePath("/purchasing/orders");
  return {
    success: `${order.po_no} is a draft again. Correct it and issue it afresh.`,
  };
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

  const { data: receipt, error } = await supabase
    .from("goods_receipts")
    .insert({
      company_id: companyId,
      po_id: poId,
      received_by: userId,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id, receipt_no")
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
    summary: `Received ${received.length} line(s) on ${order.po_no} as ${receipt.receipt_no}.`,
    after: { received },
  });

  revalidatePath(`/purchasing/orders/${poId}`);
  revalidatePath("/inventory");
  return { success: `${receipt.receipt_no} recorded. Stock has been updated.` };
}

/**
 * Corrects the quantities and prices on an order that has not been received.
 *
 * An order often has to go out before the supplier will say what something
 * costs, so a line is raised at nought and priced when the invoice arrives.
 * Until now nothing could put that right: lines were written when the order
 * was created and never again, so a mispriced order stayed mispriced, and the
 * billing guard -- which measures value, not goods -- read a nought-valued
 * order as one where nothing had arrived.
 *
 * The cut-off is receipt, not issue. Once goods are in, the received value has
 * been reported, stock has moved against it and a bill may already have been
 * measured against it; changing the price underneath all that would restate
 * figures other records have already relied on.
 */
export async function updateOrderLines(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.purchasingOrders, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) return { error: "Missing order." };

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select("id, po_no, status, purchase_order_lines(id, quantity_received)")
    .eq("id", orderId)
    .maybeSingle<{
      id: string;
      po_no: string;
      status: string;
      purchase_order_lines: { id: string; quantity_received: string }[];
    }>();

  if (!order) return { error: "That order no longer exists." };
  if (order.status === "cancelled") {
    return { error: "This order has been cancelled, so its lines cannot be changed." };
  }

  const anyReceived = (order.purchase_order_lines ?? []).some(
    (line) => Number(line.quantity_received) > 0,
  );
  if (anyReceived) {
    return {
      error:
        "Goods have already been received on this order, so its prices can no longer be changed. Record the supplier's figure on the invoice instead.",
    };
  }

  /*
   * One update per line rather than an upsert: only the lines that actually
   * moved are written, and a line belonging to another order cannot be reached
   * because every update is bounded by this order's id.
   */
  let changed = 0;
  for (const [field, raw] of formData.entries()) {
    if (!field.startsWith("line_price:")) continue;
    const lineId = field.slice("line_price:".length);
    const price = Number(raw);
    const quantity = Number(formData.get(`line_qty:${lineId}`) ?? 0);

    if (!Number.isFinite(price) || price < 0) {
      return { error: "A unit price cannot be negative." };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { error: "A quantity must be above zero." };
    }

    const { error } = await supabase
      .from("purchase_order_lines")
      .update({ quantity, unit_price: price })
      .eq("id", lineId)
      .eq("po_id", orderId);
    if (error) return { error: error.message };
    changed += 1;
  }

  if (changed === 0) return { error: "Nothing to save." };

  await logAudit({
    action: "update",
    moduleKey: MODULE.purchasingOrders,
    entityTable: "purchase_orders",
    entityId: orderId,
    summary: `Repriced ${changed} line(s) on ${order.po_no}.`,
  });

  revalidatePath(`/purchasing/orders/${orderId}`);
  revalidatePath("/purchasing/orders");
  revalidatePath("/payables");
  return { success: `Saved. ${changed} line(s) updated.` };
}

/**
 * Takes a receipt back.
 *
 * The reversal itself lives in the database, because undoing a receipt means
 * unwinding three things at once -- the quantity on the order, the stock it
 * brought in, and the order's own status -- and a half-done reversal is worse
 * than none. This carries the reason through and reports what came back.
 */
export async function cancelReceipt(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.purchasingReceiving, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const receiptId = String(formData.get("receipt_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!receiptId) return { error: "Missing receipt." };
  if (!reason) return { error: "Say why the receipt is being cancelled." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_goods_receipt", {
    p_receipt: receiptId,
    p_reason: reason,
  });
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.purchasingReceiving,
    entityTable: "goods_receipts",
    entityId: receiptId,
    summary: `Cancelled a goods receipt: ${reason}`,
  });

  revalidatePath("/purchasing/orders");
  revalidatePath("/payables");
  return {
    success:
      "Receipt cancelled. The quantity is back on the order and the stock has been taken out again.",
  };
}
