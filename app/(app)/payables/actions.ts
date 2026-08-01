"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const invoiceSchema = z.object({
  vendor_id: z.string().uuid("Choose a supplier."),
  invoice_no: z.string().trim().min(1, "Supplier invoice number is required."),
  invoice_date: z.string().min(10, "Choose the invoice date."),
  due_date: z.string().min(10, "Choose the due date."),
  amount: z.coerce.number().min(0),
  vat_amount: z.coerce.number().min(0),
  withholding_tax: z.coerce.number().min(0),
  po_id: z.string().uuid().optional().or(z.literal("")),
  job_id: z.string().uuid().optional().or(z.literal("")),
  expense_account_id: z.string().uuid().optional().or(z.literal("")),
  notes: z.string().trim().optional().or(z.literal("")),
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
    po_id: formData.get("po_id"),
    job_id: formData.get("job_id"),
    expense_account_id: formData.get("expense_account_id"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  // Total payable is net of creditable withholding tax, which is remitted to
  // the BIR rather than to the supplier.
  const total = round2(
    parsed.data.amount + parsed.data.vat_amount - parsed.data.withholding_tax,
  );
  if (total < 0) return { error: "Withholding tax exceeds the invoice value." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("supplier_invoices")
    .insert({
      company_id: companyId,
      ...parsed.data,
      po_id: parsed.data.po_id || null,
      job_id: parsed.data.job_id || null,
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
          ? "That invoice number is already recorded for this supplier."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.payablesInvoices,
    entityTable: "supplier_invoices",
    entityId: data.id,
    summary: `Recorded ${data.bill_no} (supplier ref. ${parsed.data.invoice_no}) for ${total.toFixed(2)}.`,
    after: { ...parsed.data, total },
  });

  revalidatePath("/payables");
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
    .select("id, po_no, vendor_id, company_id")
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

  const amount = round2(applications.reduce((sum, row) => sum + row.amount, 0));

  const { data: voucher, error } = await supabase
    .from("check_vouchers")
    .insert({
      company_id: companyId,
      vendor_id: vendorId,
      amount,
      check_no: String(formData.get("check_no") ?? "").trim() || null,
      bank: String(formData.get("bank") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id, voucher_no")
    .single();

  if (error) return { error: error.message };

  const { error: lineError } = await supabase
    .from("voucher_lines")
    .insert(applications.map((row) => ({ voucher_id: voucher.id, ...row })));
  if (lineError) return { error: lineError.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.payablesVouchers,
    entityTable: "check_vouchers",
    entityId: voucher.id,
    summary: `Prepared voucher ${voucher.voucher_no} for ${amount.toFixed(2)}.`,
    after: { applications },
  });

  revalidatePath("/payables");
  return { success: `${voucher.voucher_no} prepared. Release it to settle the invoices.` };
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

export async function releaseVoucher(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.payablesPayments, "approve")) return;

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("check_vouchers")
    .select("voucher_no, status, amount")
    .eq("id", id)
    .single();
  if (voucher?.status !== "draft" && voucher?.status !== "approved") return;

  const { error } = await supabase
    .from("check_vouchers")
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "approve",
    moduleKey: MODULE.payablesPayments,
    entityTable: "check_vouchers",
    entityId: id,
    summary: `Released voucher ${voucher.voucher_no} for ${Number(voucher.amount).toFixed(2)}.`,
    after: { status: "released" },
  });

  revalidatePath("/payables");
}
