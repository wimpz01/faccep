"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { buildArchive } from "@/lib/backup";
import { getSessionContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/**
 * Backups expose every table at once, so they are gated on being a company
 * admin rather than on any single module's permission.
 */
async function requireAdmin() {
  const context = await getSessionContext();
  if (!context?.activeCompany) throw new Error("No active company.");
  if (!context.activeCompany.isCompanyAdmin && !context.isSuperAdmin) {
    throw new Error("Only a company administrator can manage backups.");
  }
  return context;
}

export async function saveBackupSettings(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await requireAdmin();
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const enabled = formData.get("is_enabled") === "on";
  const frequency = String(formData.get("frequency") ?? "weekly");
  const retain = Number(formData.get("retain_count") ?? 8);

  if (!["daily", "weekly", "monthly"].includes(frequency)) {
    return { error: "Unknown frequency." };
  }
  if (!Number.isInteger(retain) || retain < 1 || retain > 60) {
    return { error: "Keep between 1 and 60 archives." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("backup_settings").upsert(
    {
      company_id: companyId,
      is_enabled: enabled,
      frequency,
      retain_count: retain,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: "admin.companies",
    entityTable: "backup_settings",
    entityId: companyId,
    summary: `Backups ${enabled ? `on, ${frequency}, keeping ${retain}` : "turned off"}.`,
    after: { enabled, frequency, retain },
  });

  revalidatePath("/admin/backups");
  return {
    success: enabled
      ? `Saved. A ${frequency} archive will be taken, keeping the last ${retain}.`
      : "Saved. Scheduled backups are off; you can still take one by hand.",
  };
}

/** Builds an archive now and files it. */
export async function runBackupNow(
  _prevState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  let companyName: string;
  let userId: string;
  try {
    const context = await requireAdmin();
    companyId = context.activeCompany!.companyId;
    companyName = context.activeCompany!.companyName;
    userId = context.userId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const supabase = await createClient();

  let archive;
  try {
    archive = await buildArchive(supabase, { id: companyId, name: companyName });
  } catch (error) {
    return { error: `Could not read the data: ${(error as Error).message}` };
  }

  const body = JSON.stringify(archive, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${companyId}/faccep-${stamp}.json`;

  const { error: uploadError } = await supabase.storage
    .from("backups")
    .upload(path, new Blob([body], { type: "application/json" }), {
      contentType: "application/json",
      upsert: false,
    });
  if (uploadError) return { error: `Could not store it: ${uploadError.message}` };

  const { error: recordError } = await supabase.from("backups").insert({
    company_id: companyId,
    storage_path: path,
    kind: "manual",
    size_bytes: body.length,
    table_count: archive.manifest.tableCount,
    row_count: archive.manifest.rowCount,
    schema_version: archive.manifest.schemaVersion,
    taken_by: userId,
  });
  if (recordError) return { error: recordError.message };

  await pruneOldBackups(supabase, companyId);

  await logAudit({
    action: "create",
    moduleKey: "admin.companies",
    entityTable: "backups",
    summary: `Took a backup: ${archive.manifest.rowCount} row(s) across ${archive.manifest.tableCount} table(s).`,
    after: { path, rows: archive.manifest.rowCount },
  });

  revalidatePath("/admin/backups");
  return {
    success: `Archive taken — ${archive.manifest.rowCount.toLocaleString()} rows across ${archive.manifest.tableCount} tables.`,
  };
}

/** Drops archives past the retention count, oldest first. */
export async function pruneOldBackups(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
) {
  const { data: settings } = await supabase
    .from("backup_settings")
    .select("retain_count")
    .eq("company_id", companyId)
    .maybeSingle();

  const keep = settings?.retain_count ?? 8;

  const { data: all } = await supabase
    .from("backups")
    .select("id, storage_path")
    .eq("company_id", companyId)
    .order("taken_at", { ascending: false });

  const surplus = (all ?? []).slice(keep);
  if (surplus.length === 0) return;

  await supabase.storage
    .from("backups")
    .remove(surplus.map((row) => row.storage_path));
  await supabase
    .from("backups")
    .delete()
    .in(
      "id",
      surplus.map((row) => row.id),
    );
}

export async function deleteBackup(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAdmin();
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("backups")
    .select("storage_path, taken_at")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { error: "Archive not found." };

  await supabase.storage.from("backups").remove([row.storage_path]);
  const { error } = await supabase.from("backups").delete().eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "delete",
    moduleKey: "admin.companies",
    entityTable: "backups",
    entityId: id,
    summary: `Deleted the archive taken ${row.taken_at}.`,
  });

  revalidatePath("/admin/backups");
  return { success: "Archive deleted." };
}

/** A short-lived link to download one archive. */
export async function backupDownloadUrl(storagePath: string) {
  const supabase = await createClient();
  const { data } = await supabase.storage
    .from("backups")
    .createSignedUrl(storagePath, 300);
  return data?.signedUrl ?? null;
}
