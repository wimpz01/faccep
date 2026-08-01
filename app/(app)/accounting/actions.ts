"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/** Installs the standard Philippine SME chart for this company. */
export async function seedChart(
  _prevState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.accountingCoa, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("seed_chart_of_accounts", {
    p_company: companyId,
  });
  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.accountingCoa,
    entityTable: "chart_of_accounts",
    summary: "Seeded the standard chart of accounts.",
  });

  revalidatePath("/accounting/accounts");
  return { success: "Chart of accounts installed. Edit or extend it as needed." };
}

const accountSchema = z.object({
  code: z.string().trim().min(1, "Account code is required."),
  name: z.string().trim().min(2, "Account name is required."),
  account_type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  description: z.string().trim().optional().or(z.literal("")),
});

export async function createAccount(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.accountingCoa, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = accountSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    account_type: formData.get("account_type"),
    description: formData.get("description"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { error } = await supabase.from("chart_of_accounts").insert({
    company_id: companyId,
    ...parsed.data,
    description: parsed.data.description || null,
  });

  if (error) {
    return {
      error: error.code === "23505" ? "That account code is taken." : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.accountingCoa,
    entityTable: "chart_of_accounts",
    summary: `Added account ${parsed.data.code} ${parsed.data.name}.`,
    after: parsed.data,
  });

  revalidatePath("/accounting/accounts");
  return { success: `${parsed.data.code} added.` };
}

/**
 * Creates a journal entry from the line grid. Lines arrive as parallel arrays
 * `jl_account[]`, `jl_desc[]`, `jl_debit[]`, `jl_credit[]`.
 */
export async function createJournalEntry(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.accountingJournal, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const accounts = formData.getAll("jl_account").map(String);
  const descriptions = formData.getAll("jl_desc").map(String);
  const debits = formData.getAll("jl_debit").map(String);
  const credits = formData.getAll("jl_credit").map(String);

  const lines: {
    account_id: string;
    description: string | null;
    debit: number;
    credit: number;
    sort_order: number;
  }[] = [];

  for (let index = 0; index < accounts.length; index += 1) {
    const accountId = accounts[index];
    if (!accountId) continue;
    const debit = round2(Number(debits[index]) || 0);
    const credit = round2(Number(credits[index]) || 0);
    if (debit === 0 && credit === 0) continue;
    if (debit > 0 && credit > 0) {
      return { error: "A line cannot carry both a debit and a credit." };
    }
    lines.push({
      account_id: accountId,
      description: descriptions[index]?.trim() || null,
      debit,
      credit,
      sort_order: lines.length,
    });
  }

  if (lines.length < 2) return { error: "A journal entry needs at least two lines." };

  const totalDebit = round2(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = round2(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit !== totalCredit) {
    return {
      error: `Entry does not balance: debits ${totalDebit.toFixed(2)} against credits ${totalCredit.toFixed(2)}.`,
    };
  }

  const supabase = await createClient();
  const entryDate = String(formData.get("entry_date") ?? "").slice(0, 10);

  const { data: entry, error } = await supabase
    .from("journal_entries")
    .insert({
      company_id: companyId,
      entry_date: entryDate || new Date().toISOString().slice(0, 10),
      memo: String(formData.get("memo") ?? "").trim() || null,
    })
    .select("id, entry_no")
    .single();

  if (error) return { error: error.message };

  const { error: lineError } = await supabase
    .from("journal_lines")
    .insert(lines.map((line) => ({ entry_id: entry.id, ...line })));
  if (lineError) return { error: lineError.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.accountingJournal,
    entityTable: "journal_entries",
    entityId: entry.id,
    summary: `Drafted journal entry ${entry.entry_no} for ${totalDebit.toFixed(2)}.`,
    after: { lines },
  });

  redirect(`/accounting/journal/${entry.id}`);
}

export async function postJournalEntry(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let userId: string;
  try {
    const context = await assertPermission(MODULE.accountingJournal, "approve");
    userId = context.userId;
  } catch (error) {
    return { error: "Posting to the ledger needs Approve on journal entries." };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: entry } = await supabase
    .from("journal_entries")
    .select("entry_no, status")
    .eq("id", id)
    .single();
  if (!entry) return { error: "Entry not found." };
  if (entry.status !== "draft") return { error: "Only a draft can be posted." };

  const { error } = await supabase
    .from("journal_entries")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  await logAudit({
    action: "approve",
    moduleKey: MODULE.accountingJournal,
    entityTable: "journal_entries",
    entityId: id,
    summary: `Posted journal entry ${entry.entry_no}. It is now immutable.`,
    before: { status: "draft" },
    after: { status: "posted" },
  });

  revalidatePath(`/accounting/journal/${id}`);
  revalidatePath("/accounting/journal");
  return { success: "Posted." };
}

/**
 * Cancels a draft entry that will not proceed. The entry and its lines are
 * kept; only a posted entry needs the heavier reversal treatment.
 */
export async function cancelDraftEntry(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.accountingJournal, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for cancelling it." };

  const supabase = await createClient();
  const { data: entry } = await supabase
    .from("journal_entries")
    .select("entry_no, status, memo")
    .eq("id", id)
    .single();

  if (!entry) return { error: "Entry not found." };
  if (entry.status !== "draft") {
    return { error: "Only a draft can be cancelled. Reverse a posted entry instead." };
  }

  const { error } = await supabase
    .from("journal_entries")
    .update({
      status: "cancelled",
      memo: entry.memo
        ? `${entry.memo} — cancelled: ${reason}`
        : `Cancelled: ${reason}`,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.accountingJournal,
    entityTable: "journal_entries",
    entityId: id,
    summary: `Cancelled draft entry ${entry.entry_no}: ${reason}`,
    before: { status: "draft" },
    after: { status: "cancelled", reason },
  });

  revalidatePath(`/accounting/journal/${id}`);
  revalidatePath("/accounting/journal");
  return { success: "Cancelled. The entry is kept for the trail." };
}

/** Corrections are made by reversal, never by editing history (spec 11). */
export async function reverseJournalEntry(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.accountingJournal, "void");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: "Reversing an entry needs the Void permission on journal entries." };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for the reversal." };

  const supabase = await createClient();
  const { data: original } = await supabase
    .from("journal_entries")
    .select("entry_no, status, entry_date, journal_lines(account_id, description, debit, credit, sort_order)")
    .eq("id", id)
    .single<{
      entry_no: string;
      status: string;
      entry_date: string;
      journal_lines: {
        account_id: string;
        description: string | null;
        debit: string;
        credit: string;
        sort_order: number;
      }[];
    }>();

  if (!original) return { error: "Entry not found." };
  if (original.status !== "posted") {
    return { error: "Only a posted entry can be reversed." };
  }

  const { data: reversal, error } = await supabase
    .from("journal_entries")
    .insert({
      company_id: companyId,
      entry_date: new Date().toISOString().slice(0, 10),
      memo: `Reversal of ${original.entry_no}: ${reason}`,
      reverses_id: id,
    })
    .select("id, entry_no")
    .single();

  if (error) return { error: error.message };

  // Debits and credits swapped.
  const { error: lineError } = await supabase.from("journal_lines").insert(
    (original.journal_lines ?? []).map((line) => ({
      entry_id: reversal.id,
      account_id: line.account_id,
      description: line.description,
      debit: Number(line.credit),
      credit: Number(line.debit),
      sort_order: line.sort_order,
    })),
  );
  if (lineError) return { error: lineError.message };

  const { error: postError } = await supabase
    .from("journal_entries")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
    })
    .eq("id", reversal.id);
  if (postError) return { error: postError.message };

  await supabase.from("journal_entries").update({ status: "reversed" }).eq("id", id);

  await logAudit({
    action: "void",
    moduleKey: MODULE.accountingJournal,
    entityTable: "journal_entries",
    entityId: id,
    summary: `Reversed ${original.entry_no} with ${reversal.entry_no}: ${reason}`,
    after: { reversal_entry: reversal.entry_no },
  });

  revalidatePath("/accounting/journal");
  redirect(`/accounting/journal/${reversal.id}`);
}

export async function createPeriod(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.accountingPeriods, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const start = String(formData.get("start_date") ?? "").slice(0, 10);
  const end = String(formData.get("end_date") ?? "").slice(0, 10);
  const name = String(formData.get("name") ?? "").trim();

  if (!start || !end || end < start) {
    return { error: "Give a valid period range." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("accounting_periods").insert({
    company_id: companyId,
    name: name || start.slice(0, 7),
    start_date: start,
    end_date: end,
  });

  if (error) {
    return {
      error:
        error.code === "23505" ? "A period already starts on that date." : error.message,
    };
  }

  revalidatePath("/accounting/periods");
  return { success: "Period opened." };
}

/**
 * Opens or closes a period.
 *
 * The database refuses a close while unposted documents are dated inside the
 * period; that error is surfaced verbatim rather than swallowed, because it
 * names exactly what is in the way.
 */
export async function setPeriodStatus(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.accountingPeriods, "approve")) {
    return { error: "Closing a period needs Approve on accounting periods." };
  }

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "open" && status !== "closed") return { error: "Unknown status." };

  const supabase = await createClient();
  const { data: period } = await supabase
    .from("accounting_periods")
    .select("name")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("accounting_periods")
    .update({
      status,
      closed_at: status === "closed" ? new Date().toISOString() : null,
    })
    .eq("id", id);

  if (error) {
    return {
      error: error.message.replace(/^.*?Cannot close/, "Cannot close"),
    };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.accountingPeriods,
    entityTable: "accounting_periods",
    entityId: id,
    summary: `${status === "closed" ? "Closed" : "Reopened"} period ${period?.name ?? id}.`,
    after: { status },
  });

  revalidatePath("/accounting/periods");
  return {
    success:
      status === "closed"
        ? `${period?.name ?? "Period"} closed. Nothing can post into it now.`
        : `${period?.name ?? "Period"} reopened.`,
  };
}
