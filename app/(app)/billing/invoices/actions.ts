"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requestApproval } from "@/lib/approvals";
import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import {
  derivedRate,
  dueDateFor,
  gensetShare,
  latePenalty,
  monthLabel,
  rentForPeriod,
  round2,
  utilityCharge,
  type UtilityBillingType,
} from "@/lib/billing";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

type NewLine = {
  line_kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  is_vatable: boolean;
  sort_order: number;
};

/**
 * Generates one draft invoice per active contract for the given month.
 *
 * Everything is derived: rent from the contract's escalation schedule, water
 * and electricity from the sub-meter readings and the period's derived rate,
 * the genset share pro-rata by kWh, and penalties from what is still unpaid on
 * earlier invoices. Existing invoices for the same contract and period are
 * skipped rather than duplicated.
 */
export async function generateInvoices(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingInvoices, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const periodStart = String(formData.get("period_start") ?? "").slice(0, 10);
  if (!periodStart) return { error: "Choose the billing month." };

  const [year, month] = periodStart.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, month, 0).toISOString().slice(0, 10);

  const supabase = await createClient();

  const { data: contracts } = await supabase
    .from("contracts")
    .select(
      `id, tenant_id, start_date, end_date, monthly_rent, escalation_rate,
       rent_due_day, penalty_rate,
       water_billing_type, water_fixed_amount, water_minimum_amount,
       electric_billing_type, electric_fixed_amount, electric_minimum_amount,
       tenants(company_name, is_vatable),
       contract_units(unit_id, units(id, code, location_id)),
       contract_inclusions(inclusion, label, amount, sort_order)`,
    )
    .eq("company_id", companyId)
    .eq("status", "active")
    .lte("start_date", monthEnd)
    .gte("end_date", monthStart)
    .returns<ContractForBilling[]>();

  if (!contracts || contracts.length === 0) {
    return { error: "No active contracts cover that month." };
  }

  // Utility periods covering the month, keyed by location and utility.
  const { data: periods } = await supabase
    .from("utility_periods")
    .select(
      "id, location_id, utility, provider_amount, provider_consumption, genset_expense",
    )
    .eq("company_id", companyId)
    .lte("period_start", monthEnd)
    .gte("period_end", monthStart)
    .returns<UtilityPeriodRow[]>();

  const periodByKey = new Map(
    (periods ?? []).map((period) => [
      `${period.location_id}:${period.utility}`,
      period,
    ]),
  );

  const periodIds = (periods ?? []).map((period) => period.id);
  const { data: readings } = periodIds.length
    ? await supabase
        .from("meter_readings")
        .select("unit_id, period_id, consumption")
        .in("period_id", periodIds)
    : { data: [] };

  const readingByKey = new Map(
    (readings ?? []).map((row) => [`${row.period_id}:${row.unit_id}`, row]),
  );

  // Building totals per electric period, needed for the genset split.
  const buildingConsumption = new Map<string, number>();
  for (const row of readings ?? []) {
    buildingConsumption.set(
      row.period_id,
      (buildingConsumption.get(row.period_id) ?? 0) + Number(row.consumption ?? 0),
    );
  }

  const { data: existing } = await supabase
    .from("invoices")
    .select("contract_id")
    .eq("company_id", companyId)
    .eq("period_start", monthStart)
    .neq("status", "cancelled");

  const alreadyBilled = new Set(
    (existing ?? []).map((row) => row.contract_id).filter(Boolean),
  );

  // Outstanding utility charges from earlier invoices, for the late penalty.
  const { data: overdue } = await supabase
    .from("invoices")
    .select("id, tenant_id, due_date, total, amount_paid, credited_amount")
    .eq("company_id", companyId)
    .in("status", ["released", "partially_paid"])
    .lt("due_date", monthStart);

  const overdueByTenant = new Map<string, number>();
  for (const invoice of overdue ?? []) {
    const balance =
      Number(invoice.total) - Number(invoice.amount_paid) - Number(invoice.credited_amount);
    if (balance > 0) {
      overdueByTenant.set(
        invoice.tenant_id,
        (overdueByTenant.get(invoice.tenant_id) ?? 0) + balance,
      );
    }
  }

  let created = 0;
  let skipped = 0;
  const problems: string[] = [];

  for (const contract of contracts) {
    if (alreadyBilled.has(contract.id)) {
      skipped += 1;
      continue;
    }

    const isVatable = contract.tenants?.is_vatable ?? false;
    const inclusions = new Map(
      (contract.contract_inclusions ?? []).map((item) => [item.inclusion, item]),
    );
    const lines: NewLine[] = [];
    let order = 0;

    if (inclusions.has("rent")) {
      const rent = rentForPeriod(
        Number(contract.monthly_rent),
        Number(contract.escalation_rate),
        contract.start_date,
        monthStart,
      );
      lines.push({
        line_kind: "rent",
        description: `Monthly rent — ${monthLabel(monthStart)}`,
        quantity: 1,
        unit_price: rent,
        amount: rent,
        is_vatable: isVatable,
        sort_order: order++,
      });
    }

    for (const key of ["parking", "security_guard"] as const) {
      const inclusion = inclusions.get(key);
      if (!inclusion) continue;
      const amount = round2(Number(inclusion.amount ?? 0));
      lines.push({
        line_kind: key,
        description:
          key === "parking" ? "Parking" : "Security guard",
        quantity: 1,
        unit_price: amount,
        amount,
        is_vatable: isVatable,
        sort_order: order++,
      });
    }

    const other = inclusions.get("other");
    if (other) {
      const amount = round2(Number(other.amount ?? 0));
      lines.push({
        line_kind: "other",
        description: other.label ?? "Other charge",
        quantity: 1,
        unit_price: amount,
        amount,
        is_vatable: isVatable,
        sort_order: order++,
      });
    }

    const units = (contract.contract_units ?? [])
      .map((link) => link.units)
      .filter((unit): unit is NonNullable<typeof unit> => Boolean(unit));

    for (const utility of ["water", "electric"] as const) {
      const inclusionKey = utility === "water" ? "water" : "electricity";
      if (!inclusions.has(inclusionKey)) continue;

      const billingType = (
        utility === "water"
          ? contract.water_billing_type
          : contract.electric_billing_type
      ) as UtilityBillingType;

      const fixedAmount =
        utility === "water"
          ? contract.water_fixed_amount
          : contract.electric_fixed_amount;
      const minimumAmount =
        utility === "water"
          ? contract.water_minimum_amount
          : contract.electric_minimum_amount;

      // A fixed charge needs no meter at all.
      if (billingType === "fixed") {
        const charge = utilityCharge({
          consumption: 0,
          rate: 0,
          billingType,
          fixedAmount: fixedAmount === null ? null : Number(fixedAmount),
        });
        lines.push({
          line_kind: utility === "water" ? "water" : "electricity",
          description: `${utility === "water" ? "Water" : "Electricity"} — ${charge.basis}`,
          quantity: 1,
          unit_price: charge.amount,
          amount: charge.amount,
          is_vatable: isVatable,
          sort_order: order++,
        });
        continue;
      }

      let consumption = 0;
      let period: UtilityPeriodRow | undefined;
      let missingReading = false;

      for (const unit of units) {
        const found = periodByKey.get(`${unit.location_id}:${utility}`);
        if (!found) {
          missingReading = true;
          continue;
        }
        period = found;
        const reading = readingByKey.get(`${found.id}:${unit.id}`);
        if (!reading) {
          missingReading = true;
          continue;
        }
        consumption += Number(reading.consumption ?? 0);
      }

      if (!period) {
        problems.push(
          `${contract.tenants?.company_name}: no ${utility} period for their location.`,
        );
        continue;
      }
      if (missingReading) {
        problems.push(
          `${contract.tenants?.company_name}: missing ${utility} reading for one or more units.`,
        );
      }

      const rate = derivedRate(
        Number(period.provider_amount),
        Number(period.provider_consumption),
      );

      const charge = utilityCharge({
        consumption,
        rate,
        billingType,
        fixedAmount: fixedAmount === null ? null : Number(fixedAmount),
        minimumAmount: minimumAmount === null ? null : Number(minimumAmount),
      });

      lines.push({
        line_kind: utility === "water" ? "water" : "electricity",
        description: `${utility === "water" ? "Water" : "Electricity"} — ${charge.basis}`,
        quantity: round2(consumption),
        unit_price: rate,
        amount: charge.amount,
        is_vatable: isVatable,
        sort_order: order++,
      });

      // Genset expense split pro-rata by the tenant's kWh share (spec 6).
      if (utility === "electric" && Number(period.genset_expense) > 0) {
        const total = buildingConsumption.get(period.id) ?? 0;
        const share = gensetShare(consumption, total, Number(period.genset_expense));
        if (share > 0) {
          lines.push({
            line_kind: "genset",
            description: `Generator expense share — ${round2(consumption)} of ${round2(total)} kWh`,
            quantity: 1,
            unit_price: share,
            amount: share,
            is_vatable: isVatable,
            sort_order: order++,
          });
        }
      }
    }

    // 2% on what is still outstanding from earlier billings (spec 6).
    const outstanding = overdueByTenant.get(contract.tenant_id) ?? 0;
    if (outstanding > 0) {
      const penalty = latePenalty(outstanding, Number(contract.penalty_rate));
      if (penalty > 0) {
        lines.push({
          line_kind: "penalty",
          description: `Late payment penalty — ${Number(contract.penalty_rate)}% of ${outstanding.toFixed(2)} outstanding`,
          quantity: 1,
          unit_price: penalty,
          amount: penalty,
          is_vatable: false,
          sort_order: order++,
        });
      }
    }

    if (lines.length === 0) {
      problems.push(
        `${contract.tenants?.company_name}: no billable inclusions on the contract.`,
      );
      continue;
    }

    const { data: invoice, error } = await supabase
      .from("invoices")
      .insert({
        company_id: companyId,
        tenant_id: contract.tenant_id,
        contract_id: contract.id,
        invoice_date: monthStart,
        due_date: dueDateFor(monthStart, contract.rent_due_day),
        period_start: monthStart,
        period_end: monthEnd,
        is_vatable: isVatable,
      })
      .select("id")
      .single();

    if (error) {
      problems.push(`${contract.tenants?.company_name}: ${error.message}`);
      continue;
    }

    const { error: lineError } = await supabase
      .from("invoice_lines")
      .insert(lines.map((line) => ({ invoice_id: invoice.id, ...line })));

    if (lineError) {
      problems.push(`${contract.tenants?.company_name}: ${lineError.message}`);
      continue;
    }

    created += 1;
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    summary: `Generated ${created} draft invoice(s) for ${monthLabel(monthStart)}.`,
    after: { created, skipped, problems },
  });

  revalidatePath("/billing/invoices");

  if (created === 0) {
    return {
      error:
        problems.length > 0
          ? problems.join(" ")
          : "Nothing to generate — every active contract is already billed for that month.",
    };
  }

  return {
    success:
      `Generated ${created} draft invoice${created === 1 ? "" : "s"}` +
      (skipped ? `, skipped ${skipped} already billed` : "") +
      (problems.length ? `. Check: ${problems.join(" ")}` : "."),
  };
}

type UtilityPeriodRow = {
  id: string;
  location_id: string;
  utility: string;
  provider_amount: string;
  provider_consumption: string;
  genset_expense: string;
};

type ContractForBilling = {
  id: string;
  tenant_id: string;
  start_date: string;
  end_date: string;
  monthly_rent: string;
  escalation_rate: string;
  rent_due_day: number;
  penalty_rate: string;
  water_billing_type: string;
  water_fixed_amount: string | null;
  water_minimum_amount: string | null;
  electric_billing_type: string;
  electric_fixed_amount: string | null;
  electric_minimum_amount: string | null;
  tenants: { company_name: string; is_vatable: boolean } | null;
  contract_units: {
    unit_id: string;
    units: { id: string; code: string; location_id: string } | null;
  }[];
  contract_inclusions: {
    inclusion: string;
    label: string | null;
    amount: string | null;
    sort_order: number;
  }[];
};

/** Draft -> released. After this the invoice is immutable. */
export async function releaseInvoice(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingInvoices, "approve");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, status, total")
    .eq("id", id)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status !== "draft") return { error: "Only a draft can be released." };
  if (Number(invoice.total) <= 0) {
    return { error: "This invoice totals zero. Add lines before releasing it." };
  }

  const { error } = await supabase
    .from("invoices")
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "approve",
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    entityId: id,
    summary: `Released invoice ${invoice.invoice_no}. It is now locked.`,
    before: { status: "draft" },
    after: { status: "released" },
  });

  revalidatePath(`/billing/invoices/${id}`);
  revalidatePath("/billing/invoices");
  return { success: "Released. The invoice can no longer be edited." };
}

/** Cancellation is approval-gated (spec 2). */
export async function requestInvoiceCancellation(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingInvoices, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for the cancellation." };

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, status")
    .eq("id", id)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status === "cancelled") return { error: "Already cancelled." };
  if (invoice.status === "draft") {
    return { error: "A draft is not released yet — delete it instead." };
  }

  const failure = await requestApproval({
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    entityId: id,
    action: "cancel",
    reason,
    summary: `invoice ${invoice.invoice_no}`,
  });
  if (failure) return { error: failure };

  revalidatePath(`/billing/invoices/${id}`);
  return { success: "Cancellation requested. It takes effect once approved." };
}

export async function createCreditMemo(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingCreditMemos, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const invoiceId = String(formData.get("invoice_id") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const reason = String(formData.get("reason") ?? "").trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Enter the amount to credit." };
  }
  if (!reason) return { error: "Give a reason for the credit memo." };

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, total, credited_amount, status")
    .eq("id", invoiceId)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status === "draft") {
    return { error: "Edit the draft directly rather than crediting it." };
  }

  const remaining = Number(invoice.total) - Number(invoice.credited_amount);
  if (amount > remaining) {
    return {
      error: `That exceeds the uncredited balance of ${remaining.toFixed(2)}.`,
    };
  }

  const { data: memo, error } = await supabase
    .from("credit_memos")
    .insert({
      company_id: companyId,
      invoice_id: invoiceId,
      amount,
      reason,
    })
    .select("id, memo_no")
    .single();

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.billingCreditMemos,
    entityTable: "credit_memos",
    entityId: memo.id,
    summary: `Issued ${memo.memo_no} for ${amount.toFixed(2)} against invoice ${invoice.invoice_no}: ${reason}`,
    after: { amount, reason },
  });

  revalidatePath(`/billing/invoices/${invoiceId}`);
  return { success: `Credit memo ${memo.memo_no} issued.` };
}

/**
 * Cancels a draft that will not proceed.
 *
 * No approval is needed — a draft never reached the ledger — but the document
 * and its lines are kept exactly as they were, with the reason recorded.
 * Nothing is deleted.
 */
export async function cancelDraftInvoice(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingInvoices, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for cancelling it." };

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, status")
    .eq("id", id)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status !== "draft") {
    return {
      error:
        "Only a draft can be cancelled outright. A released invoice needs an approved cancellation.",
    };
  }

  const { error } = await supabase
    .from("invoices")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: reason,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    entityId: id,
    summary: `Cancelled draft invoice ${invoice.invoice_no}: ${reason}`,
    before: { status: "draft" },
    after: { status: "cancelled", reason },
  });

  revalidatePath(`/billing/invoices/${id}`);
  revalidatePath("/billing/invoices");
  return { success: "Cancelled. The record is kept for the trail." };
}
