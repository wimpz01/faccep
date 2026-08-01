import { NextResponse } from "next/server";

import { buildArchive } from "@/lib/backup";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The scheduled backup run.
 *
 * Called by a scheduler rather than a signed-in person, so it authenticates
 * with a shared secret and uses the service role. Vercel Cron sends its own
 * Authorization header; anything else can pass the same secret.
 *
 *   vercel.json → { "crons": [{ "path": "/api/cron/backup", "schedule": "0 18 * * *" }] }
 *
 * It runs daily and each company is archived only once its own interval has
 * elapsed, so a weekly setting does not produce seven files a week.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: due, error } = await admin.rpc("companies_due_backup");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: { company: string; ok: boolean; detail: string }[] = [];

  for (const row of (due ?? []) as { company_id: string }[]) {
    const companyId = row.company_id;
    try {
      const { data: company } = await admin
        .from("companies")
        .select("id, name")
        .eq("id", companyId)
        .single();

      const archive = await buildArchive(admin, {
        id: companyId,
        name: company?.name ?? "",
      });

      const body = JSON.stringify(archive, null, 2);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = `${companyId}/faccep-${stamp}.json`;

      const { error: uploadError } = await admin.storage
        .from("backups")
        .upload(path, new Blob([body], { type: "application/json" }), {
          contentType: "application/json",
          upsert: false,
        });
      if (uploadError) throw new Error(uploadError.message);

      await admin.from("backups").insert({
        company_id: companyId,
        storage_path: path,
        kind: "scheduled",
        size_bytes: body.length,
        table_count: archive.manifest.tableCount,
        row_count: archive.manifest.rowCount,
        schema_version: archive.manifest.schemaVersion,
      });

      // Retention, oldest first.
      const { data: settings } = await admin
        .from("backup_settings")
        .select("retain_count")
        .eq("company_id", companyId)
        .maybeSingle();
      const keep = settings?.retain_count ?? 8;

      const { data: all } = await admin
        .from("backups")
        .select("id, storage_path")
        .eq("company_id", companyId)
        .order("taken_at", { ascending: false });

      const surplus = (all ?? []).slice(keep);
      if (surplus.length > 0) {
        await admin.storage
          .from("backups")
          .remove(surplus.map((s) => s.storage_path));
        await admin
          .from("backups")
          .delete()
          .in(
            "id",
            surplus.map((s) => s.id),
          );
      }

      await admin
        .from("backup_settings")
        .update({ last_run_at: new Date().toISOString(), last_error: null })
        .eq("company_id", companyId);

      results.push({
        company: companyId,
        ok: true,
        detail: `${archive.manifest.rowCount} rows`,
      });
    } catch (failure) {
      // Recorded against the company so the failure is visible on its own
      // backups page, not only in a log nobody reads.
      const message = (failure as Error).message;
      await admin
        .from("backup_settings")
        .update({ last_run_at: new Date().toISOString(), last_error: message })
        .eq("company_id", companyId);
      results.push({ company: companyId, ok: false, detail: message });
    }
  }

  return NextResponse.json({
    ranAt: new Date().toISOString(),
    considered: (due ?? []).length,
    results,
  });
}
