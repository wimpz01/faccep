"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requestApproval } from "@/lib/approvals";
import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { splitInvoiceTax } from "./constants";

export type ActionState = { error?: string; success?: string };

const invoiceSchema = z.object({
  vendor_id: z.string().uuid("Choose a supplier."),
  invoice_no: z.string().trim().min(1, "Supplier invoice number is required."),
  invoice_date: z.string().min(10, "Choose the invoice date."),
  due_date: z.string().min(10, "Choose the due date."),
  amount: z.coerce.number().min(0),
  vat_amount: z.coerce.number().min(0),
  withholding_tax: z.coerce.number().min(0),
  charge_kind: z.enum(["none", "goods", "services"]).default("none"),
  receipt_id: z.string().uuid().nullish().or(z.literal("")),
  po_id: z.string().uuid().nullish().or(z.literal("")),
  job_id: z.string().uuid().nullish().or(z.literal("")),
  location_id: z.string().uuid().nullish().or(z.literal("")),
  expense_account_id: z.string().uuid().nullish().or(z.literal("")),
  notes: z.string().trim().nullish().or(z.literal("")),
});

const invoiceLineSchema = z.object({
  item_id: z.string().uuid().nullish().or(z.literal("")),
  // A service rather than stock. Brings its expense account onto the line.
  non_stock_item_id: z.string().uuid().nullish().or(z.literal("")),
  sku: z.string().trim().nullish().or(z.literal("")),
  description: z.string().trim().min(1),
  unit_of_measure: z.string().trim().min(1).default("pc"),
  quantity: z.coerce.number().positive(),
  unit_price: z.coerce.number().min(0),
});


export async function createSupplierInvoice(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.payablesInvoices, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = invoiceSchema.safeParse({
    vendor_id: formData.get("vendor_id"),
    invoice_no: formData.get("invoice_no"),
    invoice_date: formData.get("invoice_date"),
    due_date: formData.get("due_date"),
    amount: formData.get("amount") || 0,
    vat_amount: formData.get("vat_amount") || 0,
    withholding_tax: formData.get("withholding_tax") || 0,
    charge_kind: formData.get("charge_kind") || "none",
    receipt_id: formData.get("receipt_id"),
    po_id: formData.get("po_id"),
    job_id: formData.get("job_id"),
    location_id: formData.get("location_id"),
    expense_account_id: formData.get("expense_account_id"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();

  // Itemised bills carry their lines as JSON; the money is then derived from
  // them rather than typed, so the document and its total cannot disagree.
  let lines: z.infer<typeof invoiceLineSchema>[] = [];
  const rawLines = String(formData.get("lines") ?? "").trim();
  if (rawLines) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawLines);
    } catch {
      return { error: "The invoice lines could not be read." };
    }
    const parsedLines = z.array(invoiceLineSchema).safeParse(decoded);
    if (!parsedLines.success) {
      return {
        error:
          "Every line needs a description, a quantity above zero and a price.",
      };
    }
    lines = parsedLines.data;
  }

  const { data: vendor } = await supabase
    .from("vendors")
    .select("is_vatable")
    .eq("id", parsed.data.vendor_id)
    .maybeSingle<{ is_vatable: boolean }>();

  let { amount, vat_amount: vatAmount, withholding_tax: withholding } =
    parsed.data;

  if (lines.length > 0) {
    const gross = round2(
      lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0),
    );
    if (gross <= 0) return { error: "The invoice adds up to nothing." };
    const split = splitInvoiceTax(
      gross,
      vendor?.is_vatable ?? false,
      parsed.data.charge_kind,
    );
    amount = split.net;
    vatAmount = split.vat;
    withholding = split.withholding;
  }

  // Total payable is net of creditable withholding tax, which is remitted to
  // the BIR rather than to the supplier.
  const total = round2(amount + vatAmount - withholding);
  if (total < 0) return { error: "Withholding tax exceeds the invoice value." };

  // The property follows whatever the bill is raised against, and is only
  // asked for when the bill stands on its own.
  let locationId = parsed.data.location_id || null;
  if (!locationId && parsed.data.po_id) {
    const { data: order } = await supabase
      .from("purchase_orders")
      .select("location_id")
      .eq("id", parsed.data.po_id)
      .maybeSingle();
    locationId = order?.location_id ?? null;
  }
  if (!locationId && parsed.data.job_id) {
    const { data: job } = await supabase
      .from("maintenance_jobs")
      .select("location_id")
      .eq("id", parsed.data.job_id)
      .maybeSingle();
    locationId = job?.location_id ?? null;
  }

  const { data, error } = await supabase
    .from("supplier_invoices")
    .insert({
      company_id: companyId,
      ...parsed.data,
      amount,
      vat_amount: vatAmount,
      withholding_tax: withholding,
      receipt_id: parsed.data.receipt_id || null,
      po_id: parsed.data.po_id || null,
      // Hold the ledger entry until the lines and their accounts are in.
      awaiting_lines: lines.length > 0,
      job_id: parsed.data.job_id || null,
      location_id: locationId,
      expense_account_id: parsed.data.expense_account_id || null,
      notes: parsed.data.notes || null,
      total,
    })
    .select("id, bill_no")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? error.message.includes("supplier_invoices_receipt_once")
            ? "That delivery has already been billed."
            : "That invoice number is already recorded for this supplier."
          : error.message,
    };
  }

  if (lines.length > 0) {
    const { error: lineError } = await supabase
      .from("supplier_invoice_lines")
      .insert(
        lines.map((line, index) => ({
          invoice_id: data.id,
          line_no: index + 1,
          item_id: line.item_id || null,
          sku: line.sku || null,
          description: line.description,
          unit_of_measure: line.unit_of_measure,
          quantity: line.quantity,
          unit_price: line.unit_price,
          non_stock_item_id: line.non_stock_item_id || null,
        })),
      );
    // Without its lines the bill is not the document that was approved, so it
    // is withdrawn rather than left behind as a bare total.
    if (lineError) {
      await supabase.from("supplier_invoices").delete().eq("id", data.id);
      return { error: lineError.message };
    }
    // Inserting the lines is what releases the ledger entry, now that their
    // accounts are known.
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.payablesInvoices,
    entityTable: "supplier_invoices",
    entityId: data.id,
    summary: `Recorded ${data.bill_no} (supplier ref. ${parsed.data.invoice_no}) for ${total.toFixed(2)}${
      lines.length > 0 ? ` across ${lines.length} line(s)` : ""
    }.`,
    after: { ...parsed.data, amount, vat_amount: vatAmount, total, lines },
  });

  revalidatePath("/payables");
  if (parsed.data.po_id) revalidatePath(`/purchasing/orders/${parsed.data.po_id}`);
  return {
    success: `${data.bill_no} recorded against supplier ref. ${parsed.data.invoice_no}.`,
  };
}

/**
 * Raises a bill against a purchase order, from what was actually received.
 *
 * The vendor and the net amount come from the order and its receipts rather
 * than being re-keyed, and the database refuses anything above the received
 * value — so the order, the receipt and the bill have to agree.
 */
export async function createBillFromOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.payablesInvoices, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const poId = String(formData.get("po_id") ?? "");
  const invoiceNo = String(formData.get("invoice_no") ?? "").trim();
  if (!poId) return { error: "Missing purchase order." };
  if (!invoiceNo) return { error: "Enter the supplier's invoice number." };

  const amount = round2(Number(formData.get("amount") ?? 0));
  const vat = round2(Number(formData.get("vat_amount") ?? 0));
  const withholding = round2(Number(formData.get("withholding_tax") ?? 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Enter the amount being billed." };
  }

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select("id, po_no, vendor_id, company_id, location_id")
    .eq("id", poId)
    .single();

  if (!order || order.company_id !== companyId) {
    return { error: "Purchase order not found." };
  }

  const total = round2(amount + vat - withholding);
  if (total < 0) return { error: "Withholding tax exceeds the invoice value." };

  const { data: bill, error } = await supabase
    .from("supplier_invoices")
    .insert({
      company_id: companyId,
      vendor_id: order.vendor_id,
      po_id: poId,
      // The bill is charged wherever the order was for.
      location_id: order.location_id,
      invoice_no: invoiceNo,
      invoice_date:
        String(formData.get("invoice_date") ?? "") ||
        new Date().toISOString().slice(0, 10),
      due_date:
        String(formData.get("due_date") ?? "") ||
        new Date().toISOString().slice(0, 10),
      amount,
      vat_amount: vat,
      withholding_tax: withholding,
      total,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id, bill_no")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { error: "That invoice number is already recorded for this supplier." };
    }
    // The three-way match guard explains itself; pass it straight through.
    return { error: error.message };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.payablesInvoices,
    entityTable: "supplier_invoices",
    entityId: bill.id,
    summary: `Billed ${total.toFixed(2)} against ${order.po_no} as ${bill.bill_no} (supplier ref. ${invoiceNo}).`,
    after: { po: order.po_no, supplier_ref: invoiceNo, amount, vat, withholding, total },
  });

  revalidatePath(`/purchasing/orders/${poId}`);
  revalidatePath("/payables");
  return {
    success: `${bill.bill_no} recorded against ${order.po_no} and posted to payables.`,
  };
}

/**
 * Raises a void or a refund against a voucher already released.
 *
 * A separate document rather than an edit: the original payment happened, and
 * the trail has to keep saying so. The reversal carries the same invoice lines
 * back, which returns the outstanding balance to those bills.
 */
async function reverseVoucher(
  kind: "void" | "refund",
  companyId: string,
  formData: FormData,
): Promise<ActionState> {
  const originalId = String(formData.get("reverses_voucher_id") ?? "");
  if (!originalId) {
    return { error: `Choose the voucher this ${kind} undoes.` };
  }

  const reason = String(formData.get("notes") ?? "").trim();
  if (!reason) {
    return { error: `Say why: a ${kind} without a reason cannot be explained later.` };
  }

  const supabase = await createClient();
  const { data: original } = await supabase
    .from("check_vouchers")
    .select("id, voucher_no, vendor_id, amount, status, voucher_kind, company_id")
    .eq("id", originalId)
    .maybeSingle();

  if (!original || original.company_id !== companyId) {
    return { error: "That voucher was not found." };
  }
  if (original.voucher_kind === "void" || original.voucher_kind === "refund") {
    return { error: `${original.voucher_no} is itself a reversal.` };
  }

  // What has already been given back, so the same voucher cannot be reversed
  // twice over.
  const { data: existing } = await supabase
    .from("check_vouchers")
    .select("amount")
    .eq("reverses_voucher_id", originalId)
    .neq("status", "cancelled");

  const alreadyReturned = round2(
    (existing ?? []).reduce((sum, row) => sum + Number(row.amount), 0),
  );
  const remaining = round2(Number(original.amount) - alreadyReturned);
  if (remaining <= 0) {
    return { error: `${original.voucher_no} has already been fully reversed.` };
  }

  const requested = round2(Number(formData.get("amount") ?? 0) || remaining);
  if (requested <= 0) return { error: "Enter an amount." };
  if (requested > remaining) {
    return {
      error: `Only ${remaining.toFixed(2)} of ${original.voucher_no} is left to reverse.`,
    };
  }

  const { data: voucher, error } = await supabase
    .from("check_vouchers")
    .insert({
      company_id: companyId,
      vendor_id: original.vendor_id,
      voucher_kind: kind,
      reverses_voucher_id: originalId,
      amount: requested,
      notes: reason,
    })
    .select("id, voucher_no")
    .single();

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.payablesVouchers,
    entityTable: "check_vouchers",
    entityId: voucher.id,
    summary: `${kind === "void" ? "Voided" : "Refunded"} ${requested.toFixed(2)} against ${original.voucher_no} as ${voucher.voucher_no}: ${reason}`,
    after: { kind, reverses: original.voucher_no, amount: requested },
  });

  revalidatePath("/payables");
  return {
    success: `${voucher.voucher_no} raised against ${original.voucher_no}. Release it to put the money back.`,
  };
}

/**
 * Prepares a check voucher against outstanding supplier invoices.
 *
 * Where an invoice is tied to a contracted maintenance job, the voucher is
 * refused unless an approved percent-complete certificate covers it (spec 8.2).
 */
export async function createVoucher(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.payablesVouchers, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const vendorId = String(formData.get("vendor_id") ?? "");
  if (!vendorId) return { error: "Choose a supplier." };

  const kind = String(formData.get("voucher_kind") ?? "payment");
  if (!["payment", "prepayment", "void", "refund"].includes(kind)) {
    return { error: "Unknown voucher type." };
  }

  // A void or a refund returns money already paid, so it is raised against the
  // voucher it undoes rather than against outstanding invoices.
  if (kind === "void" || kind === "refund") {
    return reverseVoucher(kind, companyId, formData);
  }

  const method = String(formData.get("payment_method") ?? "");
  if (!["cash", "check", "online"].includes(method)) {
    return { error: "Say how this is being paid." };
  }

  const checkDate = String(formData.get("check_date") ?? "").trim();
  if (kind === "prepayment") {
    if (method !== "check") {
      return { error: "A prepayment is a postdated cheque, so the method must be a cheque." };
    }
    if (!checkDate) return { error: "Enter the date written on the cheque." };
    if (checkDate <= new Date().toISOString().slice(0, 10)) {
      return {
        error: "A prepayment cheque must be dated ahead. Dated today, it is an ordinary payment.",
      };
    }
  }

  const applications: { supplier_invoice_id: string; amount: number }[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("pay:")) continue;
    const amount = round2(Number(String(raw).trim()) || 0);
    if (amount <= 0) continue;
    applications.push({ supplier_invoice_id: key.slice("pay:".length), amount });
  }

  // A postdated cheque is often written before the bills it will settle have
  // arrived, so it may start with nothing attached. Everything else must say
  // what it is paying.
  if (applications.length === 0 && kind !== "prepayment") {
    return { error: "Enter an amount against at least one invoice." };
  }
  if (kind === "prepayment" && applications.length === 0) {
    const faceValue = round2(Number(formData.get("face_amount") ?? 0));
    if (faceValue <= 0) {
      return {
        error:
          "Enter the amount of the cheque, or attach the invoices it settles.",
      };
    }
  }

  const supabase = await createClient();

  const { data: invoices } = await supabase
    .from("supplier_invoices")
    .select("id, invoice_no, total, amount_paid, job_id, maintenance_jobs(job_kind, job_no)")
    .in(
      "id",
      applications.map((row) => row.supplier_invoice_id),
    )
    .returns<
      {
        id: string;
        invoice_no: string;
        total: string;
        amount_paid: string;
        job_id: string | null;
        maintenance_jobs: { job_kind: string; job_no: string } | null;
      }[]
    >();

  for (const application of applications) {
    const invoice = invoices?.find((row) => row.id === application.supplier_invoice_id);
    if (!invoice) return { error: "One of the invoices could not be found." };

    const outstanding = round2(Number(invoice.total) - Number(invoice.amount_paid));
    if (application.amount > outstanding) {
      return {
        error: `${invoice.invoice_no}: only ${outstanding.toFixed(2)} is outstanding.`,
      };
    }

    if (invoice.job_id && invoice.maintenance_jobs?.job_kind === "contracted") {
      const { data: certified } = await supabase
        .from("maintenance_progress")
        .select("tranche_amount")
        .eq("job_id", invoice.job_id)
        .eq("status", "approved");

      const approvedTotal = round2(
        (certified ?? []).reduce((sum, row) => sum + Number(row.tranche_amount), 0),
      );

      const { data: alreadyPaid } = await supabase
        .from("supplier_invoices")
        .select("amount_paid")
        .eq("job_id", invoice.job_id);

      const paidTotal = round2(
        (alreadyPaid ?? []).reduce((sum, row) => sum + Number(row.amount_paid), 0),
      );

      if (paidTotal + application.amount > approvedTotal) {
        return {
          error:
            `${invoice.maintenance_jobs.job_no}: only ${approvedTotal.toFixed(2)} has been ` +
            `certified and approved, and ${paidTotal.toFixed(2)} is already paid. ` +
            "Get the next percent-complete tranche signed off first.",
        };
      }
    }
  }

  // Normally the voucher is worth what it settles. A postdated cheque with
  // nothing attached yet is worth its face value until bills are matched to it.
  const amount =
    applications.length > 0
      ? round2(applications.reduce((sum, row) => sum + row.amount, 0))
      : round2(Number(formData.get("face_amount") ?? 0));

  // Tax withheld on payment. Recomputed here rather than trusted from the form,
  // and refused outright where the supplier is not VAT-registered -- the
  // database enforces the same rule.
  let withheld = round2(Number(formData.get("withholding_tax") ?? 0));
  if (withheld > 0) {
    const { data: vendor } = await supabase
      .from("vendors")
      .select("is_vatable, withholding")
      .eq("id", vendorId)
      .maybeSingle<{ is_vatable: boolean; withholding: string }>();

    if (!vendor?.is_vatable) {
      return {
        error: "Nothing is withheld from a supplier that is not VAT-registered.",
      };
    }
    if (withheld > amount) {
      return { error: "Withholding cannot exceed what is being paid." };
    }
  } else {
    withheld = 0;
  }

  const { data: voucher, error } = await supabase
    .from("check_vouchers")
    .insert({
      company_id: companyId,
      vendor_id: vendorId,
      voucher_kind: kind,
      payment_method: method,
      check_date: checkDate || null,
      amount,
      withholding_tax: withheld,
      check_no: String(formData.get("check_no") ?? "").trim() || null,
      bank: String(formData.get("bank") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id, voucher_no")
    .single();

  if (error) return { error: error.message };

  if (applications.length > 0) {
    const { error: lineError } = await supabase
      .from("voucher_lines")
      .insert(applications.map((row) => ({ voucher_id: voucher.id, ...row })));
    if (lineError) return { error: lineError.message };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.payablesVouchers,
    entityTable: "check_vouchers",
    entityId: voucher.id,
    summary: `Prepared ${kind} voucher ${voucher.voucher_no} for ${amount.toFixed(2)}${
      kind === "prepayment" ? `, cheque dated ${checkDate}` : ` by ${method}`
    }.`,
    after: { kind, method, checkDate: checkDate || null, applications },
  });

  revalidatePath("/payables");
  return {
    success:
      kind === "prepayment"
        ? `${voucher.voucher_no} prepared. Attach the invoices it settles, then release it when the cheque is handed over.`
        : `${voucher.voucher_no} prepared. Send it for approval — it posts to the ledger once signed off.`,
  };
}

/**
 * Sends a voucher to the approval queue.
 *
 * Paying out is the point of no return, so it is the one step the preparer
 * cannot take alone. Approving both releases the voucher and posts it, which
 * is why the effect lives in the approvals module rather than here.
 */
export async function submitVoucherForApproval(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.payablesVouchers, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("check_vouchers")
    .select("voucher_no, status, amount, voucher_kind, vendors(name), voucher_lines(id)")
    .eq("id", id)
    .maybeSingle<{
      voucher_no: string;
      status: string;
      amount: string;
      voucher_kind: string;
      vendors: { name: string } | null;
      voucher_lines: { id: string }[];
    }>();

  if (!voucher) return { error: "Voucher not found." };
  if (voucher.status !== "draft") {
    return { error: `${voucher.voucher_no} is already ${voucher.status}.` };
  }
  if ((voucher.voucher_lines ?? []).length === 0) {
    return {
      error: `${voucher.voucher_no} settles nothing yet. Attach the invoices it pays first.`,
    };
  }

  const failure = await requestApproval({
    moduleKey: MODULE.payablesVouchers,
    entityTable: "check_vouchers",
    entityId: id,
    action: "approve",
    reason: `${voucher.voucher_no} — ${Number(voucher.amount).toFixed(2)} to ${voucher.vendors?.name ?? "supplier"}`,
    summary: `voucher ${voucher.voucher_no}`,
  });
  if (failure) return { error: failure };

  revalidatePath("/payables");
  revalidatePath(`/payables/vouchers/${id}`);
  revalidatePath("/approvals");
  return {
    success: `${voucher.voucher_no} sent for approval. It posts to the ledger once signed off.`,
  };
}

/**
 * Matches supplier invoices to a voucher already raised.
 *
 * Only for a postdated cheque written before its bills arrived, and only while
 * it is still a draft -- once released it has posted, and the lines are what it
 * posted against.
 */
export async function attachInvoicesToVoucher(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.payablesVouchers, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("check_vouchers")
    .select("voucher_no, status, amount, vendor_id, voucher_kind")
    .eq("id", id)
    .maybeSingle();

  if (!voucher) return { error: "Voucher not found." };
  if (voucher.status !== "draft") {
    return { error: `${voucher.voucher_no} is ${voucher.status}; its lines are fixed.` };
  }

  const applications: { supplier_invoice_id: string; amount: number }[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("pay:")) continue;
    const amount = round2(Number(String(raw).trim()) || 0);
    if (amount <= 0) continue;
    applications.push({ supplier_invoice_id: key.slice("pay:".length), amount });
  }
  if (applications.length === 0) {
    return { error: "Enter an amount against at least one invoice." };
  }

  const applied = round2(applications.reduce((sum, row) => sum + row.amount, 0));
  if (applied > Number(voucher.amount)) {
    return {
      error: `That is ${applied.toFixed(2)}, more than the ${Number(voucher.amount).toFixed(2)} on ${voucher.voucher_no}.`,
    };
  }

  await supabase.from("voucher_lines").delete().eq("voucher_id", id);
  const { error } = await supabase
    .from("voucher_lines")
    .insert(applications.map((row) => ({ voucher_id: id, ...row })));
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.payablesVouchers,
    entityTable: "check_vouchers",
    entityId: id,
    summary: `Attached ${applications.length} invoice(s) to ${voucher.voucher_no}, ${applied.toFixed(2)} of ${Number(voucher.amount).toFixed(2)}.`,
    after: { applications },
  });

  revalidatePath("/payables");
  revalidatePath(`/payables/vouchers/${id}`);
  return {
    success: `${applications.length} invoice(s) attached to ${voucher.voucher_no}.`,
  };
}

/**
 * Cancels a prepared voucher that will not proceed. The voucher stays on file
 * with its lines; the supplier invoices it referenced simply reopen, because
 * settlement only counts released vouchers.
 */
export async function cancelVoucher(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.payablesVouchers, "edit")) return;

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("check_vouchers")
    .select("voucher_no, status")
    .eq("id", id)
    .single();

  if (voucher?.status === "released" || voucher?.status === "cancelled") return;

  const { error } = await supabase
    .from("check_vouchers")
    .update({ status: "cancelled" })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.payablesVouchers,
    entityTable: "check_vouchers",
    entityId: id,
    summary: `Cancelled voucher ${voucher?.voucher_no ?? id}; it will not proceed.`,
    after: { status: "cancelled" },
  });

  revalidatePath("/payables");
}

/**
 * Hands the payment over, which is what posts it to the ledger.
 *
 * A postdated cheque is released the day it is handed to the supplier and does
 * not need a separate sign-off -- it is not money yet. Everything else has to
 * have been approved first, so releasing cannot be used to route around the
 * approval queue.
 */
export async function releaseVoucher(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.payablesPayments, "approve");
  } catch (error) {
    return {
      error: "Releasing a voucher needs Approve on payables payments.",
    };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("check_vouchers")
    .select("voucher_no, status, amount, voucher_kind, voucher_lines(id)")
    .eq("id", id)
    .maybeSingle<{
      voucher_no: string;
      status: string;
      amount: string;
      voucher_kind: string;
      voucher_lines: { id: string }[];
    }>();

  if (!voucher) return { error: "Voucher not found." };
  if (voucher.status === "released") {
    return { error: `${voucher.voucher_no} is already released.` };
  }
  if (voucher.status === "cancelled") {
    return { error: `${voucher.voucher_no} was cancelled.` };
  }

  const needsApproval =
    voucher.voucher_kind === "payment" || voucher.voucher_kind === "refund";
  if (needsApproval && voucher.status !== "approved") {
    return {
      error: `${voucher.voucher_no} has not been approved. Send it for approval first — that is what posts it.`,
    };
  }
  if ((voucher.voucher_lines ?? []).length === 0) {
    return {
      error: `${voucher.voucher_no} settles nothing. Attach the invoices it pays before releasing it.`,
    };
  }

  const { error } = await supabase
    .from("check_vouchers")
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "approve",
    moduleKey: MODULE.payablesPayments,
    entityTable: "check_vouchers",
    entityId: id,
    summary: `Released voucher ${voucher.voucher_no} for ${Number(voucher.amount).toFixed(2)}. Posted to the ledger.`,
    after: { status: "released" },
  });

  revalidatePath("/payables");
  revalidatePath(`/payables/vouchers/${id}`);
  revalidatePath("/accounting/journal");
  return {
    success: `${voucher.voucher_no} released and posted to the ledger.`,
  };
}
