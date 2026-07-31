import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, type ModuleRow } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Audit Trail" };

const PAGE_SIZE = 50;

const ACTIONS = [
  "create",
  "update",
  "delete",
  "void",
  "approve",
  "reject",
  "login",
  "logout",
];

type AuditRow = {
  id: number;
  action: string;
  module_key: string | null;
  entity_table: string | null;
  entity_id: string | null;
  summary: string | null;
  actor_email: string | null;
  before_data: unknown;
  after_data: unknown;
  created_at: string;
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    action?: string;
    module?: string;
    q?: string;
  }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.adminAudit, "view");
  const companyId = context.activeCompany!.companyId;

  const page = Math.max(1, Number(filters.page ?? "1") || 1);
  const from = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("audit_log")
    .select(
      "id, action, module_key, entity_table, entity_id, summary, actor_email, before_data, after_data, created_at",
      { count: "exact" },
    )
    .eq("company_id", companyId);

  if (filters.action) query = query.eq("action", filters.action);
  if (filters.module) query = query.eq("module_key", filters.module);
  if (filters.q) {
    query = query.or(
      `summary.ilike.%${filters.q}%,actor_email.ilike.%${filters.q}%`,
    );
  }

  const [{ data: entries, count }, { data: modules }] = await Promise.all([
    query
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
      .returns<AuditRow[]>(),
    supabase
      .from("modules")
      .select(
        "key, label, module_group, description, sort_order, supports_approve, supports_void",
      )
      .order("sort_order")
      .returns<ModuleRow[]>(),
  ]);

  const moduleLabels = new Map(
    (modules ?? []).map((mod) => [mod.key, mod.label]),
  );
  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function pageHref(target: number) {
    const params = new URLSearchParams();
    if (filters.action) params.set("action", filters.action);
    if (filters.module) params.set("module", filters.module);
    if (filters.q) params.set("q", filters.q);
    params.set("page", String(target));
    return `/admin/audit?${params.toString()}`;
  }

  return (
    <>
      <PageHeader
        title="Audit Trail"
        description="Every create, edit, delete and void, with who did it and when. Records here can never be changed or removed."
      />

      <div className="mb-5">
        <Card>
          <form className="grid gap-3 sm:grid-cols-4 items-end" method="get">
            <div>
              <label className="label" htmlFor="filter-q">
                Search
              </label>
              <input
                id="filter-q"
                name="q"
                className="input"
                placeholder="Summary or user"
                defaultValue={filters.q ?? ""}
              />
            </div>
            <div>
              <label className="label" htmlFor="filter-action">
                Action
              </label>
              <select
                id="filter-action"
                name="action"
                className="select"
                defaultValue={filters.action ?? ""}
              >
                <option value="">All actions</option>
                {ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="filter-module">
                Module
              </label>
              <select
                id="filter-module"
                name="module"
                className="select"
                defaultValue={filters.module ?? ""}
              >
                <option value="">All modules</option>
                {(modules ?? []).map((mod) => (
                  <option key={mod.key} value={mod.key}>
                    {mod.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary">
                Filter
              </button>
              <Link href="/admin/audit" className="btn btn-secondary">
                Reset
              </Link>
            </div>
          </form>
        </Card>
      </div>

      <Card
        title={`${total} entr${total === 1 ? "y" : "ies"}`}
        description={total > PAGE_SIZE ? `Page ${page} of ${lastPage}` : undefined}
        bodyClassName=""
      >
        {entries && entries.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Module</th>
                  <th>What changed</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap text-xs muted">
                      {formatDateTime(entry.created_at)}
                    </td>
                    <td className="text-xs break-all">{entry.actor_email ?? "—"}</td>
                    <td>
                      <span className="badge">{entry.action}</span>
                    </td>
                    <td className="text-xs">
                      {entry.module_key
                        ? (moduleLabels.get(entry.module_key) ?? entry.module_key)
                        : "—"}
                    </td>
                    <td>
                      <p className="text-sm">{entry.summary}</p>
                      {entry.before_data || entry.after_data ? (
                        <details className="mt-1">
                          <summary className="text-xs muted cursor-pointer">
                            Before / after
                          </summary>
                          <pre
                            className="text-[0.7rem] mt-1 p-2 rounded overflow-x-auto"
                            style={{
                              background: "var(--surface-muted)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {JSON.stringify(
                              {
                                before: entry.before_data,
                                after: entry.after_data,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No audit entries match these filters.</EmptyState>
        )}
      </Card>

      {lastPage > 1 ? (
        <div className="flex items-center justify-between gap-3 mt-4">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="btn btn-secondary btn-sm">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs muted">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <Link href={pageHref(page + 1)} className="btn btn-secondary btn-sm">
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </>
  );
}
