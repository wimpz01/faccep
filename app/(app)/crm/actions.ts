"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
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

const inquirySchema = z.object({
  contact_person: z.string().trim().min(2, "Who got in touch?"),
  company_name: z.string().trim().optional().or(z.literal("")),
  mobile_number: z.string().trim().optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email.").optional().or(z.literal("")),
  requirement: z.string().trim().optional().or(z.literal("")),
  unit_id: z.string().uuid().optional().or(z.literal("")),
  source: z.string().trim().optional().or(z.literal("")),
  follow_up_on: z.string().optional().or(z.literal("")),
  proposed_rent: z.string().optional().or(z.literal("")),
  proposed_term_years: z.string().optional().or(z.literal("")),
});

export async function createInquiry(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.crmInquiries, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = inquirySchema.safeParse({
    contact_person: formData.get("contact_person"),
    company_name: formData.get("company_name"),
    mobile_number: formData.get("mobile_number"),
    email: formData.get("email"),
    requirement: formData.get("requirement"),
    unit_id: formData.get("unit_id"),
    source: formData.get("source"),
    follow_up_on: formData.get("follow_up_on"),
    proposed_rent: formData.get("proposed_rent"),
    proposed_term_years: formData.get("proposed_term_years"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const inquiryNo = await nextNumber(
    companyId,
    "inquiries",
    "inquiry_no",
    `INQ-${new Date().getFullYear()}-`,
  );

  const { data, error } = await supabase
    .from("inquiries")
    .insert({
      company_id: companyId,
      inquiry_no: inquiryNo,
      contact_person: parsed.data.contact_person,
      company_name: parsed.data.company_name || null,
      mobile_number: parsed.data.mobile_number || null,
      email: parsed.data.email || null,
      requirement: parsed.data.requirement || null,
      unit_id: parsed.data.unit_id || null,
      source: parsed.data.source || null,
      follow_up_on: parsed.data.follow_up_on || null,
      proposed_rent: parsed.data.proposed_rent
        ? Number(parsed.data.proposed_rent)
        : null,
      proposed_term_years: parsed.data.proposed_term_years
        ? Number(parsed.data.proposed_term_years)
        : null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.crmInquiries,
    entityTable: "inquiries",
    entityId: data.id,
    summary: `Logged inquiry ${inquiryNo} from ${parsed.data.contact_person}.`,
    after: parsed.data,
  });

  redirect(`/crm/inquiries/${data.id}`);
}

export async function updateInquiryStatus(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.crmInquiries, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const followUp = String(formData.get("follow_up_on") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (
    !["new", "contacted", "viewing", "proposal_sent", "won", "lost"].includes(status)
  ) {
    return { error: "Unknown status." };
  }

  const context = await getSessionContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("inquiries")
    .update({ status, follow_up_on: followUp || null })
    .eq("id", id);
  if (error) return { error: error.message };

  if (note) {
    await supabase
      .from("inquiry_notes")
      .insert({ inquiry_id: id, note, created_by: context?.userId ?? null });
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.crmInquiries,
    entityTable: "inquiries",
    entityId: id,
    summary: `Inquiry moved to ${status}${note ? `: ${note}` : "."}`,
    after: { status, follow_up_on: followUp || null },
  });

  revalidatePath(`/crm/inquiries/${id}`);
  revalidatePath("/crm/inquiries");
  return { success: `Marked ${status.replace("_", " ")}.` };
}

// ---------------------------------------------------------------------------
// Complaints
// ---------------------------------------------------------------------------

export async function createComplaint(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.crmComplaints, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const subject = String(formData.get("subject") ?? "").trim();
  if (subject.length < 3) return { error: "Give the complaint a subject." };

  const supabase = await createClient();
  const complaintNo = await nextNumber(
    companyId,
    "complaints",
    "complaint_no",
    `CMP-${new Date().getFullYear()}-`,
  );

  const { data, error } = await supabase
    .from("complaints")
    .insert({
      company_id: companyId,
      complaint_no: complaintNo,
      subject,
      details: String(formData.get("details") ?? "").trim() || null,
      tenant_id: String(formData.get("tenant_id") ?? "") || null,
      unit_id: String(formData.get("unit_id") ?? "") || null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.crmComplaints,
    entityTable: "complaints",
    entityId: data.id,
    summary: `Logged complaint ${complaintNo}: ${subject}`,
  });

  revalidatePath("/crm/complaints");
  return { success: `${complaintNo} logged.` };
}

export async function updateComplaint(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.crmComplaints, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!["open", "in_progress", "resolved", "closed"].includes(status)) {
    return { error: "Unknown status." };
  }
  if ((status === "resolved" || status === "closed") && !resolution) {
    return { error: "Say how it was resolved before closing it." };
  }

  const context = await getSessionContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("complaints")
    .update({
      status,
      resolution: resolution || null,
      resolved_on:
        status === "resolved" || status === "closed"
          ? new Date().toISOString().slice(0, 10)
          : null,
    })
    .eq("id", id);
  if (error) return { error: error.message };

  if (note) {
    await supabase
      .from("complaint_updates")
      .insert({ complaint_id: id, note, created_by: context?.userId ?? null });
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.crmComplaints,
    entityTable: "complaints",
    entityId: id,
    summary: `Complaint moved to ${status}${resolution ? `: ${resolution}` : "."}`,
    after: { status, resolution: resolution || null },
  });

  revalidatePath("/crm/complaints");
  return { success: `Marked ${status.replace("_", " ")}.` };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export async function createCalendarEvent(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getSessionContext();
  if (!context?.activeCompany) return { error: "No active company." };

  const title = String(formData.get("title") ?? "").trim();
  const date = String(formData.get("event_date") ?? "").slice(0, 10);
  if (!title || !date) return { error: "A title and a date are required." };

  const supabase = await createClient();
  const { error } = await supabase.from("calendar_events").insert({
    company_id: context.activeCompany.companyId,
    user_id: context.userId,
    title,
    details: String(formData.get("details") ?? "").trim() || null,
    event_date: date,
    event_time: String(formData.get("event_time") ?? "") || null,
    remind_days_before: Number(formData.get("remind_days_before") ?? 0) || 0,
  });

  if (error) return { error: error.message };

  revalidatePath("/calendar");
  return { success: "Added to your calendar." };
}

export async function toggleCalendarEvent(formData: FormData) {
  const context = await getSessionContext();
  if (!context) return;

  const id = String(formData.get("id") ?? "");
  const done = formData.get("is_done") === "true";

  const supabase = await createClient();
  await supabase
    .from("calendar_events")
    .update({ is_done: done })
    .eq("id", id)
    .eq("user_id", context.userId);

  revalidatePath("/calendar");
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function recordDocument(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.documents, "edit")) return;

  const title = String(formData.get("title") ?? "").trim();
  const path = String(formData.get("storagePath") ?? "");
  if (!title || !path) return;

  const supabase = await createClient();
  const { error } = await supabase.from("documents").insert({
    company_id: context.activeCompany!.companyId,
    title,
    doc_kind: String(formData.get("doc_kind") ?? "other"),
    storage_path: path,
    tenant_id: String(formData.get("tenant_id") ?? "") || null,
    issued_on: String(formData.get("issued_on") ?? "") || null,
    expires_on: String(formData.get("expires_on") ?? "") || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
    uploaded_by: context.userId,
  });
  if (error) return;

  await logAudit({
    action: "create",
    moduleKey: MODULE.documents,
    entityTable: "documents",
    summary: `Filed document "${title}".`,
  });

  revalidatePath("/documents");
}

export async function deleteDocument(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.documents, "delete")) return;

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: document } = await supabase
    .from("documents")
    .select("title, storage_path")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) return;

  if (document?.storage_path) {
    await supabase.storage.from("documents").remove([document.storage_path]);
  }

  await logAudit({
    action: "delete",
    moduleKey: MODULE.documents,
    entityTable: "documents",
    entityId: id,
    summary: `Removed document "${document?.title ?? id}".`,
  });

  revalidatePath("/documents");
}
