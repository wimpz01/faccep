import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card, EmptyState, PageHeader, StatTile, formatDateTime } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import {
  backupDownloadUrl,
  deleteBackup,
  runBackupNow,
  saveBackupSettings,
} from "./actions";
import {
  BackupSettingsForm,
  DeleteBackupForm,
  DownloadBackupButton,
  RunBackupForm,
} from "./backup-forms";

export const metadata: Metadata = { title: "Backups" };

type BackupRow = {
  id: string;
  storage_path: string;
  kind: string;
  size_bytes: string;
  table_count: number;
  row_count: number;
  schema_version: string | null;
  taken_at: string;
  profiles: { full_name: string | null } | null;
};

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function BackupsPage() {
  const context = await requireSession();
  if (!context.activeCompany) redirect("/no-company");

  // Backups expose every table at once, so they are admin-only.
  if (!context.activeCompany.isCompanyAdmin && !context.isSuperAdmin) {
    redirect("/dashboard");
  }

  const companyId = context.activeCompany.companyId;
  const supabase = await createClient();

  const [{ data: settings }, { data: backups }] = await Promise.all([
    supabase
      .from("backup_settings")
      .select("is_enabled, frequency, retain_count, last_run_at, last_error")
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase
      .from("backups")
      .select(
        "id, storage_path, kind, size_bytes, table_count, row_count, schema_version, taken_at, profiles(full_name)",
      )
      .eq("company_id", companyId)
      .order("taken_at", { ascending: false })
      .returns<BackupRow[]>(),
  ]);

  const current = settings ?? {
    is_enabled: false,
    frequency: "weekly",
    retain_count: 8,
    last_run_at: null,
    last_error: null,
  };
  const rows = backups ?? [];
  const latest = rows[0];

  return (
    <>
      <PageHeader
        title="Backups"
        description="A portable copy of this company's data that you hold, for migrating to another server or keeping your own archive."
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile
          label="Archives on file"
          value={rows.length}
          hint={`Keeping the last ${current.retain_count}`}
        />
        <StatTile
          label="Last taken"
          value={latest ? formatDateTime(latest.taken_at).split(",")[0] : "Never"}
          hint={latest ? `${latest.row_count.toLocaleString()} rows` : "No archive yet"}
        />
        <StatTile
          label="Schedule"
          value={current.is_enabled ? current.frequency : "Off"}
          hint={current.is_enabled ? "Runs automatically" : "Take one by hand"}
        />
      </div>

      {current.last_error ? (
        <div
          className="card mb-6"
          style={{ borderColor: "var(--danger)", borderWidth: "1.5px" }}
        >
          <div className="card-body">
            <p className="text-sm">
              <strong style={{ color: "var(--danger)" }}>
                The last scheduled run failed.
              </strong>{" "}
              <span className="muted">{current.last_error}</span>
            </p>
          </div>
        </div>
      ) : null}

      <div className="mb-6">
        <Card
          title="What a backup covers"
          description="Worth reading before you rely on it."
        >
          <div className="grid gap-4 sm:grid-cols-2 text-sm">
            <div>
              <p className="label">Included</p>
              <ul className="muted" style={{ listStyle: "disc", paddingLeft: "1.1rem" }}>
                <li>Every row this company owns, across all tables</li>
                <li>Contracts, invoices, payments, the ledger, stock and purchasing</li>
                <li>The audit trail</li>
              </ul>
            </div>
            <div>
              <p className="label">Not included</p>
              <ul className="muted" style={{ listStyle: "disc", paddingLeft: "1.1rem" }}>
                <li>Sign-in accounts and passwords</li>
                <li>Uploaded files — unit photos, scanned contracts, job photos</li>
                <li>The database schema itself</li>
              </ul>
            </div>
          </div>
          <p className="text-xs muted mt-4">
            This is a data archive, not a database backup. Supabase already backs
            up the database daily, and restoring that is what recovers a broken
            system — it brings back the schema, the triggers and the sign-in
            accounts together. Use these archives to move a company to another
            server, to hand data to an auditor, or to keep a copy somewhere your
            hosting account cannot reach.
          </p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mb-6">
        <Card title="Schedule" description="When to take one without being asked.">
          <BackupSettingsForm action={saveBackupSettings} settings={current} />
        </Card>
        <Card
          title="Take one now"
          description="Reads every table for this company and files the archive. Large companies take a few seconds."
        >
          <RunBackupForm action={runBackupNow} />
        </Card>
      </div>

      <Card title="Archives" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Taken</th>
                  <th>By</th>
                  <th className="text-right">Rows</th>
                  <th className="text-right">Size</th>
                  <th>Schema</th>
                  <th className="text-right">File</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((backup) => (
                  <tr key={backup.id}>
                    <td className="text-xs">
                      {formatDateTime(backup.taken_at)}
                      <p className="muted">
                        <span className="badge">{backup.kind}</span>
                      </p>
                    </td>
                    <td className="text-xs">
                      {backup.profiles?.full_name ?? "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {backup.row_count.toLocaleString()}
                      <p className="text-xs muted">{backup.table_count} tables</p>
                    </td>
                    <td className="text-right tabular-nums">
                      {fileSize(Number(backup.size_bytes))}
                    </td>
                    <td className="text-xs muted">
                      {backup.schema_version ?? "—"}
                    </td>
                    <td className="text-right">
                      <div className="inline-flex gap-1 justify-end">
                        <DownloadBackupButton
                          getUrl={backupDownloadUrl}
                          storagePath={backup.storage_path}
                        />
                        <DeleteBackupForm
                          action={deleteBackup}
                          backupId={backup.id}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No archives yet. Take one now, or turn the schedule on.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
