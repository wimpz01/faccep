import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Building a company's data archive.
 *
 * This is a row-level export, not a database backup. It carries the data one
 * company owns, in dependency order, so it can be read by a person, diffed, or
 * loaded into another instance. It deliberately does NOT carry schema, triggers,
 * sequences, auth users or storage objects -- restoring those is the database's
 * job, not the application's.
 */

/** Tables that carry company_id, in the order a load would have to insert them. */
const COMPANY_TABLES = [
  // Foundation
  "roles",
  "locations",
  "company_users",
  "document_counters",
  "accounting_settings",
  "payment_terms",
  // Portfolio
  "units",
  "tenants",
  "contracts",
  // Accounting
  "chart_of_accounts",
  "accounting_periods",
  "journal_entries",
  // Billing
  "utility_periods",
  "meter_readings",
  "invoices",
  "credit_memos",
  "payments",
  "postdated_checks",
  // Operations
  "inventory_categories",
  "inventory_items",
  "inventory_movements",
  "tools",
  "tool_loans",
  "maintenance_schedules",
  "maintenance_jobs",
  "maintenance_progress",
  "material_requests",
  // Purchasing
  "vendors",
  "purchase_requests",
  "purchase_orders",
  "goods_receipts",
  "supplier_invoices",
  "check_vouchers",
  // Front office
  "inquiries",
  "complaints",
  "calendar_events",
  "documents",
  // Trail
  "approval_requests",
  "audit_log",
] as const;

/**
 * Tables reached through a parent rather than by company_id.
 *
 * Each is fetched by the ids already collected from its parent, which is also
 * what keeps the archive to one company's rows.
 */
const CHILD_TABLES: { table: string; parent: string; key: string }[] = [
  { table: "role_permissions", parent: "roles", key: "role_id" },
  { table: "user_permissions", parent: "company_users", key: "company_user_id" },
  { table: "unit_photos", parent: "units", key: "unit_id" },
  { table: "contract_units", parent: "contracts", key: "contract_id" },
  { table: "contract_inclusions", parent: "contracts", key: "contract_id" },
  { table: "journal_lines", parent: "journal_entries", key: "entry_id" },
  { table: "invoice_lines", parent: "invoices", key: "invoice_id" },
  { table: "payment_applications", parent: "payments", key: "payment_id" },
  { table: "maintenance_job_photos", parent: "maintenance_jobs", key: "job_id" },
  { table: "material_request_lines", parent: "material_requests", key: "request_id" },
  { table: "purchase_request_lines", parent: "purchase_requests", key: "request_id" },
  { table: "purchase_order_lines", parent: "purchase_orders", key: "po_id" },
  { table: "goods_receipt_lines", parent: "goods_receipts", key: "receipt_id" },
  { table: "voucher_lines", parent: "check_vouchers", key: "voucher_id" },
  { table: "inquiry_notes", parent: "inquiries", key: "inquiry_id" },
  { table: "complaint_updates", parent: "complaints", key: "complaint_id" },
];

export type Archive = {
  manifest: {
    format: string;
    takenAt: string;
    company: { id: string; name: string };
    schemaVersion: string | null;
    tableCount: number;
    rowCount: number;
    counts: Record<string, number>;
    excludes: string[];
  };
  data: Record<string, unknown[]>;
};

/** Supabase caps a single select; anything larger is walked in pages. */
const PAGE = 1000;

async function readAll(
  supabase: SupabaseClient,
  table: string,
  apply: (query: ReturnType<SupabaseClient["from"]>) => unknown,
) {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const query = supabase.from(table).select("*").range(from, from + PAGE - 1);
    const { data, error } = await (apply(query as never) as never as Promise<{
      data: Record<string, unknown>[] | null;
      error: { message: string } | null;
    }>);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/** Reads one company's rows out of every table, parents before children. */
export async function buildArchive(
  supabase: SupabaseClient,
  company: { id: string; name: string },
): Promise<Archive> {
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of COMPANY_TABLES) {
    const rows = await readAll(supabase, table, (query) =>
      (query as never as { eq: (a: string, b: string) => unknown }).eq(
        "company_id",
        company.id,
      ),
    );
    data[table] = rows;
    counts[table] = rows.length;
  }

  for (const { table, parent, key } of CHILD_TABLES) {
    const parentIds = (data[parent] ?? [])
      .map((row) => (row as { id?: string }).id)
      .filter((id): id is string => Boolean(id));

    if (parentIds.length === 0) {
      data[table] = [];
      counts[table] = 0;
      continue;
    }

    // Chunked so the IN list cannot outgrow what the API will accept.
    const rows: unknown[] = [];
    for (let i = 0; i < parentIds.length; i += 200) {
      const slice = parentIds.slice(i, i + 200);
      const page = await readAll(supabase, table, (query) =>
        (query as never as { in: (a: string, b: string[]) => unknown }).in(key, slice),
      );
      rows.push(...page);
    }
    data[table] = rows;
    counts[table] = rows.length;
  }

  const { data: migrations } = await supabase
    .from("_migrations")
    .select("name")
    .order("name", { ascending: false })
    .limit(1);

  const rowCount = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return {
    manifest: {
      format: "faccep-archive-1",
      takenAt: new Date().toISOString(),
      company,
      schemaVersion:
        (migrations as { name: string }[] | null)?.[0]?.name ?? null,
      tableCount: Object.keys(counts).length,
      rowCount,
      counts,
      // Named so nobody mistakes this for a full backup.
      excludes: [
        "database schema, triggers and functions",
        "auth users and passwords",
        "uploaded files in storage (unit photos, scanned contracts, job photos)",
        "other companies' data",
      ],
    },
    data,
  };
}
