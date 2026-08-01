"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const money = z.coerce.number().min(0, "Amounts cannot be negative.");

// These inputs are disabled when the billing type does not use them, and a
// disabled input is never submitted -- so formData.get returns null, not "".
const optionalMoney = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value === "" || value == null ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= 0), {
    message: "Enter a valid amount.",
  });

const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((value) => value ?? "");

const billingType = z.enum(["fixed", "minimum_overage", "consumption"]);

const contractSchema = z
  .object({
    tenant_id: z.string().uuid("Choose a tenant."),
    start_date: z.string().min(10, "Choose a start date."),
    end_date: z.string().min(10, "Choose an end date."),
    term_years: z.coerce.number().int().min(1, "Term must be at least 1 year."),
    monthly_rent: money,
    security_deposit: money,
    advance_payment: money,
    escalation_rate: z.coerce
      .number()
      .refine((value) => [0, 3, 5].includes(value), {
        message: "Escalation must be 0%, 3% or 5%.",
      }),
    rent_due_day: z.coerce
      .number()
      .int()
      .min(1)
      .max(28, "Use a day between 1 and 28 so it exists in every month."),
    penalty_rate: z.coerce.number().min(0),
    water_billing_type: billingType,
    water_fixed_amount: optionalMoney,
    water_minimum_amount: optionalMoney,
    electric_billing_type: billingType,
    electric_fixed_amount: optionalMoney,
    electric_minimum_amount: optionalMoney,
    repair_responsibility: optionalText,
    renewal_terms: optionalText,
    termination_grounds: optionalText,
    notes: optionalText,
  })
  .refine((data) => data.end_date > data.start_date, {
    message: "End date must fall after the start date.",
    path: ["end_date"],
  })
  .refine(
    (data) =>
      data.water_billing_type !== "fixed" || data.water_fixed_amount !== null,
    { message: "Fixed water billing needs a fixed amount.", path: ["water_fixed_amount"] },
  )
  .refine(
    (data) =>
      data.water_billing_type !== "minimum_overage" ||
      data.water_minimum_amount !== null,
    {
      message: "Minimum + overage water billing needs a minimum amount.",
      path: ["water_minimum_amount"],
    },
  )
  .refine(
    (data) =>
      data.electric_billing_type !== "fixed" ||
      data.electric_fixed_amount !== null,
    {
      message: "Fixed electric billing needs a fixed amount.",
      path: ["electric_fixed_amount"],
    },
  )
  .refine(
    (data) =>
      data.electric_billing_type !== "minimum_overage" ||
      data.electric_minimum_amount !== null,
    {
      message: "Minimum + overage electric billing needs a minimum amount.",
      path: ["electric_minimum_amount"],
    },
  );

function readForm(formData: FormData) {
  return contractSchema.safeParse({
    tenant_id: formData.get("tenant_id"),
    start_date: formData.get("start_date"),
    end_date: formData.get("end_date"),
    term_years: formData.get("term_years"),
    monthly_rent: formData.get("monthly_rent"),
    security_deposit: formData.get("security_deposit"),
    advance_payment: formData.get("advance_payment"),
    escalation_rate: formData.get("escalation_rate"),
    rent_due_day: formData.get("rent_due_day"),
    penalty_rate: formData.get("penalty_rate"),
    water_billing_type: formData.get("water_billing_type"),
    water_fixed_amount: formData.get("water_fixed_amount"),
    water_minimum_amount: formData.get("water_minimum_amount"),
    electric_billing_type: formData.get("electric_billing_type"),
    electric_fixed_amount: formData.get("electric_fixed_amount"),
    electric_minimum_amount: formData.get("electric_minimum_amount"),
    repair_responsibility: formData.get("repair_responsibility"),
    renewal_terms: formData.get("renewal_terms"),
    termination_grounds: formData.get("termination_grounds"),
    notes: formData.get("notes"),
  });
}

function toRow(values: z.infer<typeof contractSchema>) {
  return {
    tenant_id: values.tenant_id,
    start_date: values.start_date,
    end_date: values.end_date,
    term_years: values.term_years,
    monthly_rent: values.monthly_rent,
    security_deposit: values.security_deposit,
    advance_payment: values.advance_payment,
    escalation_rate: values.escalation_rate,
    rent_due_day: values.rent_due_day,
    penalty_rate: values.penalty_rate,
    water_billing_type: values.water_billing_type,
    water_fixed_amount: values.water_fixed_amount,
    water_minimum_amount: values.water_minimum_amount,
    electric_billing_type: values.electric_billing_type,
    electric_fixed_amount: values.electric_fixed_amount,
    electric_minimum_amount: values.electric_minimum_amount,
    repair_responsibility: values.repair_responsibility || null,
    renewal_terms: values.renewal_terms || null,
    termination_grounds: values.termination_grounds || null,
    notes: values.notes || null,
  };
}

/** Reads the unit checkboxes and the inclusion checklist out of the form. */
function readSelections(formData: FormData) {
  const unitIds = formData.getAll("unit_ids").map(String).filter(Boolean);

  const inclusions: {
    inclusion: string;
    label: string | null;
    amount: number | null;
    sort_order: number;
  }[] = [];

  const standard = [
    "rent",
    "parking",
    "security_guard",
    "water",
    "electricity",
  ] as const;

  standard.forEach((key, index) => {
    if (formData.get(`inclusion_${key}`) !== "on") return;
    const raw = String(formData.get(`inclusion_${key}_amount`) ?? "").trim();
    inclusions.push({
      inclusion: key,
      label: null,
      amount: raw === "" ? null : Number(raw),
      sort_order: index,
    });
  });

  const otherLabel = String(formData.get("inclusion_other_label") ?? "").trim();
  if (otherLabel) {
    const raw = String(formData.get("inclusion_other_amount") ?? "").trim();
    inclusions.push({
      inclusion: "other",
      label: otherLabel,
      amount: raw === "" ? null : Number(raw),
      sort_order: standard.length,
    });
  }

  return { unitIds, inclusions };
}

async function replaceSelections(
  contractId: string,
  unitIds: string[],
  inclusions: ReturnType<typeof readSelections>["inclusions"],
) {
  const supabase = await createClient();

  await supabase.from("contract_units").delete().eq("contract_id", contractId);
  if (unitIds.length > 0) {
    const { error } = await supabase
      .from("contract_units")
      .insert(unitIds.map((unitId) => ({ contract_id: contractId, unit_id: unitId })));
    if (error) return error.message;
  }

  await supabase
    .from("contract_inclusions")
    .delete()
    .eq("contract_id", contractId);
  if (inclusions.length > 0) {
    const { error } = await supabase
      .from("contract_inclusions")
      .insert(inclusions.map((item) => ({ contract_id: contractId, ...item })));
    if (error) return error.message;
  }

  return null;
}

export async function createContract(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.contracts, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { unitIds, inclusions } = readSelections(formData);
  if (unitIds.length === 0) {
    return { error: "Select at least one unit for this contract." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contracts")
    .insert({ company_id: companyId, ...toRow(parsed.data) })
    .select("id, contract_no")
    .single();

  if (error) {
    // Raised by reject_blacklisted_tenant.
    if (error.message.includes("blacklisted")) {
      return { error: "This tenant is blacklisted and cannot be given a contract." };
    }
    return { error: error.message };
  }

  const selectionError = await replaceSelections(data.id, unitIds, inclusions);
  if (selectionError) return { error: selectionError };

  await logAudit({
    action: "create",
    moduleKey: MODULE.contracts,
    entityTable: "contracts",
    entityId: data.id,
    summary: `Created contract ${data.contract_no} (draft).`,
    after: { ...toRow(parsed.data), units: unitIds.length },
  });

  // The same form is embedded in the tenant set-up, which wants to stay put.
  const returnTo = String(formData.get("return_to") ?? "");
  redirect(returnTo.startsWith("/") ? returnTo : `/contracts/${data.id}`);
}

export async function updateContract(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.contracts, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { unitIds, inclusions } = readSelections(formData);
  if (unitIds.length === 0) {
    return { error: "Select at least one unit for this contract." };
  }

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("contracts")
    .select(
      "contract_no, start_date, end_date, term_years, monthly_rent, security_deposit, advance_payment, escalation_rate, rent_due_day, penalty_rate, water_billing_type, electric_billing_type",
    )
    .eq("id", id)
    .single();

  const row = toRow(parsed.data);
  const { error } = await supabase.from("contracts").update(row).eq("id", id);

  if (error) return { error: error.message };

  const selectionError = await replaceSelections(id, unitIds, inclusions);
  if (selectionError) return { error: selectionError };

  const diff = before
    ? changedFields(before, {
        start_date: row.start_date,
        end_date: row.end_date,
        term_years: row.term_years,
        monthly_rent: row.monthly_rent,
        security_deposit: row.security_deposit,
        advance_payment: row.advance_payment,
        escalation_rate: row.escalation_rate,
        rent_due_day: row.rent_due_day,
        penalty_rate: row.penalty_rate,
        water_billing_type: row.water_billing_type,
        electric_billing_type: row.electric_billing_type,
      })
    : { before: {}, after: row };

  await logAudit({
    action: "update",
    moduleKey: MODULE.contracts,
    entityTable: "contracts",
    entityId: id,
    summary: `Updated contract ${before?.contract_no ?? id}.`,
    before: diff.before,
    after: diff.after,
  });

  revalidatePath(`/contracts/${id}`);
  const returnTo = String(formData.get("return_to") ?? "");
  if (returnTo.startsWith("/")) revalidatePath(returnTo);

  return { success: "Contract saved." };
}

/**
 * Draft -> active. Gated on Approve rather than Edit: activating a contract
 * commits the units and starts the billing obligation.
 */
export async function activateContract(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.contracts, "approve");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: contract } = await supabase
    .from("contracts")
    .select("contract_no, status, contract_units(unit_id)")
    .eq("id", id)
    .single<{
      contract_no: string;
      status: string;
      contract_units: { unit_id: string }[];
    }>();

  if (!contract) return { error: "Contract not found." };
  if (contract.status !== "draft") {
    return { error: "Only a draft contract can be activated." };
  }
  if ((contract.contract_units ?? []).length === 0) {
    return { error: "Add at least one unit before activating." };
  }

  const { error } = await supabase
    .from("contracts")
    .update({ status: "active" })
    .eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "approve",
    moduleKey: MODULE.contracts,
    entityTable: "contracts",
    entityId: id,
    summary: `Activated contract ${contract.contract_no}. Units are now occupied.`,
    before: { status: "draft" },
    after: { status: "active" },
  });

  revalidatePath(`/contracts/${id}`);
  revalidatePath("/contracts");
  revalidatePath("/properties");
  return { success: "Contract activated." };
}

export async function terminateContract(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.contracts, "approve");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("termination_reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for the termination." };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("contracts")
    .select("contract_no, status")
    .eq("id", id)
    .single();

  if (before?.status === "terminated") {
    return { error: "This contract is already terminated." };
  }

  const { error } = await supabase
    .from("contracts")
    .update({
      status: "terminated",
      terminated_at: new Date().toISOString().slice(0, 10),
      termination_reason: reason,
    })
    .eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.contracts,
    entityTable: "contracts",
    entityId: id,
    summary: `Terminated contract ${before?.contract_no ?? id}: ${reason}`,
    before: { status: before?.status },
    after: { status: "terminated", termination_reason: reason },
  });

  revalidatePath(`/contracts/${id}`);
  revalidatePath("/contracts");
  revalidatePath("/properties");
  return { success: "Contract terminated. Units released." };
}

/** Records the scanned wet-signed copy (spec 4.2 -- no e-signature). */
export async function recordSignedCopy(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.contracts, "edit")) return;

  const id = String(formData.get("id") ?? "");
  const path = String(formData.get("storagePath") ?? "");
  const signedAt = String(formData.get("signed_at") ?? "");
  if (!id || !path) return;

  const supabase = await createClient();
  const { error } = await supabase
    .from("contracts")
    .update({
      signed_document_path: path,
      signed_at: signedAt || new Date().toISOString().slice(0, 10),
    })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.contracts,
    entityTable: "contracts",
    entityId: id,
    summary: "Attached the scanned signed contract.",
    after: { signed_document_path: path },
  });

  revalidatePath(`/contracts/${id}`);
}

export async function deleteContract(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.contracts, "delete")) return;

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("contracts")
    .select("contract_no, status")
    .eq("id", id)
    .single();

  // Only a draft may be removed outright; anything that has been live is
  // terminated instead so the history survives.
  if (before?.status !== "draft") return;

  const { error } = await supabase.from("contracts").delete().eq("id", id);
  if (error) return;

  await logAudit({
    action: "delete",
    moduleKey: MODULE.contracts,
    entityTable: "contracts",
    entityId: id,
    summary: `Deleted draft contract ${before?.contract_no ?? id}.`,
    before: before ?? undefined,
  });

  redirect("/contracts");
}
