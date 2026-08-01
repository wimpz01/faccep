"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { JOB_FLOW } from "./constants";

export type ActionState = { error?: string; success?: string };

const jobSchema = z.object({
  title: z.string().trim().min(3, "Describe the job in a few words."),
  description: z.string().trim().optional().or(z.literal("")),
  location_id: z.string().uuid().optional().or(z.literal("")),
  unit_id: z.string().uuid().optional().or(z.literal("")),
  job_kind: z.enum(["in_house", "contracted"]),
  vendor_id: z.string().uuid().optional().or(z.literal("")),
  assigned_to: z.string().trim().optional().or(z.literal("")),
  scheduled_for: z.string().optional().or(z.literal("")),
  contract_amount: z.coerce.number().min(0),
});

export async function createJob(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.maintenanceRepairs, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = jobSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    location_id: formData.get("location_id"),
    unit_id: formData.get("unit_id"),
    job_kind: formData.get("job_kind"),
    vendor_id: formData.get("vendor_id"),
    assigned_to: formData.get("assigned_to"),
    scheduled_for: formData.get("scheduled_for"),
    contract_amount: formData.get("contract_amount") || 0,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  if (parsed.data.job_kind === "contracted" && !parsed.data.vendor_id) {
    return { error: "Contracted work needs a vendor." };
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("maintenance_jobs")
    .insert({
      company_id: companyId,
      title: parsed.data.title,
      description: parsed.data.description || null,
      location_id: parsed.data.location_id || null,
      unit_id: parsed.data.unit_id || null,
      job_kind: parsed.data.job_kind,
      vendor_id: parsed.data.vendor_id || null,
      assigned_to: parsed.data.assigned_to || null,
      scheduled_for: parsed.data.scheduled_for || null,
      contract_amount: parsed.data.contract_amount,
    })
    .select("id, job_no")
    .single();

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.maintenanceRepairs,
    entityTable: "maintenance_jobs",
    entityId: data.id,
    summary: `Reported job ${data.job_no}: ${parsed.data.title}`,
    after: parsed.data,
  });

  redirect(`/maintenance/jobs/${data.id}`);
}

/**
 * Advances the workflow. Moving into Completed and beyond is refused by the
 * database unless before and after photos exist (spec 8.2).
 */
export async function advanceJob(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.maintenanceRepairs, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("status") ?? "");
  if (!JOB_FLOW.includes(next as never) && next !== "cancelled") {
    return { error: "Unknown status." };
  }

  const supabase = await createClient();
  const { data: job } = await supabase
    .from("maintenance_jobs")
    .select("job_no, status")
    .eq("id", id)
    .single();
  if (!job) return { error: "Job not found." };

  const stamps: Record<string, Record<string, string>> = {
    completed: { completed_at: new Date().toISOString().slice(0, 10) },
    inspected: { inspected_at: new Date().toISOString().slice(0, 10) },
    closed: { closed_at: new Date().toISOString().slice(0, 10) },
  };

  const { error } = await supabase
    .from("maintenance_jobs")
    .update({ status: next, ...(stamps[next] ?? {}) })
    .eq("id", id);

  if (error) {
    return {
      error: error.message.includes("before photo")
        ? "Attach at least one before photo and one after photo before completing this job."
        : error.message,
    };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.maintenanceRepairs,
    entityTable: "maintenance_jobs",
    entityId: id,
    summary: `Job ${job.job_no}: ${job.status} → ${next}.`,
    before: { status: job.status },
    after: { status: next },
  });

  revalidatePath(`/maintenance/jobs/${id}`);
  revalidatePath("/maintenance/jobs");
  return { success: `Moved to ${next.replace("_", " ")}.` };
}

export async function recordJobPhoto(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.maintenanceRepairs, "edit")) {
    return;
  }

  const jobId = String(formData.get("jobId") ?? "");
  const stage = String(formData.get("stage") ?? "");
  const path = String(formData.get("storagePath") ?? "");
  if (!jobId || !path || !["before", "after", "inspection"].includes(stage)) return;

  const supabase = await createClient();
  const { error } = await supabase.from("maintenance_job_photos").insert({
    job_id: jobId,
    stage,
    storage_path: path,
    caption: String(formData.get("caption") ?? "").trim() || null,
  });
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.maintenanceRepairs,
    entityTable: "maintenance_job_photos",
    entityId: jobId,
    summary: `Added a ${stage} photo.`,
  });

  revalidatePath(`/maintenance/jobs/${jobId}`);
}

// ---------------------------------------------------------------------------
// Material requests -- the issue checklist (spec 9)
// ---------------------------------------------------------------------------

export async function createMaterialRequest(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.maintenanceMaterialRequests, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const jobId = String(formData.get("job_id") ?? "");
  const lines: { item_id: string; quantity_requested: number }[] = [];

  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("qty:")) continue;
    const quantity = Number(String(raw).trim());
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    lines.push({ item_id: key.slice("qty:".length), quantity_requested: quantity });
  }

  if (lines.length === 0) return { error: "Add at least one item." };

  const supabase = await createClient();

  const { data: request, error } = await supabase
    .from("material_requests")
    .insert({
      company_id: companyId,
      job_id: jobId || null,
      requested_by: userId,
    })
    .select("id, request_no")
    .single();

  if (error) return { error: error.message };

  const { error: lineError } = await supabase
    .from("material_request_lines")
    .insert(lines.map((line) => ({ request_id: request.id, ...line })));
  if (lineError) return { error: lineError.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.maintenanceMaterialRequests,
    entityTable: "material_requests",
    entityId: request.id,
    summary: `Raised material request ${request.request_no} with ${lines.length} item(s).`,
    after: { lines },
  });

  revalidatePath(`/maintenance/jobs/${jobId}`);
  return { success: `${request.request_no} raised.` };
}

/** Issuing takes the stock out; the checklist then tracks what was used. */
export async function issueMaterialRequest(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.maintenanceMaterialRequests, "approve");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: "Issuing materials needs Approve on material requests." };
  }

  const requestId = String(formData.get("request_id") ?? "");
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("material_requests")
    .select(
      "id, request_no, status, job_id, material_request_lines(id, item_id, quantity_requested, inventory_items(name, quantity_on_hand, unit_cost))",
    )
    .eq("id", requestId)
    .single<{
      id: string;
      request_no: string;
      status: string;
      job_id: string | null;
      material_request_lines: {
        id: string;
        item_id: string;
        quantity_requested: string;
        inventory_items: {
          name: string;
          quantity_on_hand: string;
          unit_cost: string;
        } | null;
      }[];
    }>();

  if (!request) return { error: "Request not found." };
  if (request.status !== "draft") return { error: "This request is already issued." };

  for (const line of request.material_request_lines ?? []) {
    const available = Number(line.inventory_items?.quantity_on_hand ?? 0);
    if (available < Number(line.quantity_requested)) {
      return {
        error: `Only ${available} of ${line.inventory_items?.name} on hand — raise a purchase request instead.`,
      };
    }
  }

  for (const line of request.material_request_lines ?? []) {
    const { error } = await supabase.from("inventory_movements").insert({
      company_id: companyId,
      item_id: line.item_id,
      movement_kind: "issue",
      quantity: -Number(line.quantity_requested),
      unit_cost: Number(line.inventory_items?.unit_cost ?? 0),
      reference_table: "material_requests",
      reference_id: request.id,
      note: `Issued on ${request.request_no}`,
      created_by: userId,
    });
    if (error) return { error: error.message };

    await supabase
      .from("material_request_lines")
      .update({ quantity_issued: Number(line.quantity_requested) })
      .eq("id", line.id);
  }

  await supabase
    .from("material_requests")
    .update({ status: "issued", issued_at: new Date().toISOString() })
    .eq("id", requestId);

  await logAudit({
    action: "approve",
    moduleKey: MODULE.maintenanceMaterialRequests,
    entityTable: "material_requests",
    entityId: requestId,
    summary: `Issued ${request.request_no}; stock deducted.`,
  });

  revalidatePath(`/maintenance/jobs/${request.job_id}`);
  revalidatePath("/inventory");
  return { success: "Issued. Stock has been deducted." };
}

/**
 * Closes the checklist: what was actually used, with the remainder returned to
 * stock as its own movement (spec 9).
 */
export async function closeMaterialRequest(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.maintenanceMaterialRequests, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const requestId = String(formData.get("request_id") ?? "");
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("material_requests")
    .select(
      "id, request_no, status, job_id, material_request_lines(id, item_id, quantity_issued, inventory_items(name, unit_cost))",
    )
    .eq("id", requestId)
    .single<{
      id: string;
      request_no: string;
      status: string;
      job_id: string | null;
      material_request_lines: {
        id: string;
        item_id: string;
        quantity_issued: string;
        inventory_items: { name: string; unit_cost: string } | null;
      }[];
    }>();

  if (!request) return { error: "Request not found." };
  if (request.status !== "issued") {
    return { error: "Only an issued request can be closed off." };
  }

  let returnedTotal = 0;

  for (const line of request.material_request_lines ?? []) {
    const issued = Number(line.quantity_issued);
    const used = Number(formData.get(`used:${line.id}`) ?? 0);

    if (!Number.isFinite(used) || used < 0 || used > issued) {
      return {
        error: `Used quantity for ${line.inventory_items?.name} must be between 0 and ${issued}.`,
      };
    }

    const returned = issued - used;

    await supabase
      .from("material_request_lines")
      .update({ quantity_used: used, quantity_returned: returned })
      .eq("id", line.id);

    if (returned > 0) {
      returnedTotal += returned;
      const { error } = await supabase.from("inventory_movements").insert({
        company_id: companyId,
        item_id: line.item_id,
        movement_kind: "return",
        quantity: returned,
        unit_cost: Number(line.inventory_items?.unit_cost ?? 0),
        reference_table: "material_requests",
        reference_id: request.id,
        note: `Returned unused from ${request.request_no}`,
        created_by: userId,
      });
      if (error) return { error: error.message };
    }
  }

  await supabase
    .from("material_requests")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", requestId);

  await logAudit({
    action: "update",
    moduleKey: MODULE.maintenanceMaterialRequests,
    entityTable: "material_requests",
    entityId: requestId,
    summary: `Closed ${request.request_no}; ${returnedTotal} unit(s) returned to stock.`,
    after: { returnedTotal },
  });

  revalidatePath(`/maintenance/jobs/${request.job_id}`);
  revalidatePath("/inventory");
  return {
    success:
      returnedTotal > 0
        ? `Closed. ${returnedTotal} unused unit(s) went back into stock.`
        : "Closed. Everything issued was used.",
  };
}

// ---------------------------------------------------------------------------
// Contractor progress sign-off (spec 8.2)
// ---------------------------------------------------------------------------

export async function certifyProgress(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let userId: string;
  try {
    const context = await assertPermission(MODULE.maintenanceProgressSignoff, "edit");
    companyId = context.activeCompany!.companyId;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const jobId = String(formData.get("job_id") ?? "");
  const percent = Number(formData.get("percent_complete") ?? 0);
  const amount = Number(formData.get("tranche_amount") ?? 0);
  const note = String(formData.get("note") ?? "").trim();

  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return { error: "Percent complete must be between 1 and 100." };
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "Enter the tranche amount." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("maintenance_progress").insert({
    company_id: companyId,
    job_id: jobId,
    percent_complete: percent,
    tranche_amount: amount,
    note: note || null,
    certified_by: userId,
  });

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.maintenanceProgressSignoff,
    entityTable: "maintenance_progress",
    entityId: jobId,
    summary: `Certified ${percent}% complete for a tranche of ${amount.toFixed(2)}.`,
    after: { percent, amount },
  });

  revalidatePath(`/maintenance/jobs/${jobId}`);
  return {
    success: "Certified. Payables will not release the tranche until it is approved.",
  };
}

export async function approveProgress(formData: FormData) {
  const context = await getSessionContext();
  if (
    !context ||
    !can(context.permissions, MODULE.maintenanceProgressSignoff, "approve")
  ) {
    return;
  }

  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected") return;

  const supabase = await createClient();
  const { data: progress } = await supabase
    .from("maintenance_progress")
    .select("job_id, percent_complete, tranche_amount")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("maintenance_progress")
    .update({
      status: decision,
      approved_by: context.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: decision === "approved" ? "approve" : "reject",
    moduleKey: MODULE.maintenanceProgressSignoff,
    entityTable: "maintenance_progress",
    entityId: id,
    summary: `${decision === "approved" ? "Approved" : "Rejected"} the ${Number(progress?.percent_complete)}% tranche.`,
  });

  revalidatePath(`/maintenance/jobs/${progress?.job_id}`);
}
