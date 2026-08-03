import type { Metadata } from "next";

import { PageHeader, TabBar } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { can, type ModuleRow } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { decideApproval } from "./actions";
import { ApprovalList, type ApprovalRow } from "./approval-list";

export const metadata: Metadata = { title: "Approvals" };

const TAB_ALL = "all";

type RequestRow = {
  id: string;
  module_key: string;
  entity_table: string;
  entity_id: string;
  action: string;
  reason: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
  requester: { full_name: string; email: string } | null;
  decider: { full_name: string; email: string } | null;
};

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const context = await requireSession();
  const companyId = context.activeCompany!.companyId;
  const supabase = await createClient();

  const [{ data: requests }, { data: modules }] = await Promise.all([
    supabase
      .from("approval_requests")
      .select(
        `id, module_key, entity_table, entity_id, action, reason, status,
         requested_at, decided_at, decision_note,
         requester:profiles!approval_requests_requested_by_fkey(full_name, email),
         decider:profiles!approval_requests_decided_by_fkey(full_name, email)`,
      )
      .eq("company_id", companyId)
      .order("requested_at", { ascending: false })
      .limit(100)
      .returns<RequestRow[]>(),
    supabase
      .from("modules")
      .select(
        "key, label, module_group, description, sort_order, supports_approve, supports_void",
      )
      .returns<ModuleRow[]>(),
  ]);

  const moduleList = modules ?? [];
  const moduleLabels = new Map(moduleList.map((mod) => [mod.key, mod.label]));
  const moduleOrder = new Map(moduleList.map((mod) => [mod.key, mod.sort_order]));
  const rows = requests ?? [];

  /**
   * A tab per module that actually has requests, in the side panel's own
   * order. Deriving them from the rows rather than listing them by hand means
   * a tab is never a dead end, and a newly approval-gated module gets its tab
   * the moment somebody uses it.
   */
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.module_key, (counts.get(row.module_key) ?? 0) + 1);
  }
  const moduleTabs = [...counts.keys()].sort(
    (a, b) =>
      (moduleOrder.get(a) ?? 999) - (moduleOrder.get(b) ?? 999) ||
      a.localeCompare(b),
  );

  const active = counts.has(tab ?? "") ? tab! : TAB_ALL;
  const visible =
    active === TAB_ALL ? rows : rows.filter((row) => row.module_key === active);

  const toRow = (request: RequestRow): ApprovalRow => ({
    id: request.id,
    moduleLabel: moduleLabels.get(request.module_key) ?? request.module_key,
    action: request.action,
    reason: request.reason,
    status: request.status,
    requested_at: request.requested_at,
    decided_at: request.decided_at,
    decision_note: request.decision_note,
    requester: request.requester?.email ?? "unknown",
    decider: request.decider?.email ?? "—",
    // Approve on this request's own module, not a blanket right.
    canDecide: can(context.permissions, request.module_key, "approve"),
  });

  const pending = visible.filter((row) => row.status === "pending").map(toRow);
  const decided = visible.filter((row) => row.status !== "pending").map(toRow);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Cancellations, voids and requests waiting for sign-off. Approving here also applies the change."
      />

      <TabBar
        active={active}
        tabs={[
          {
            value: TAB_ALL,
            label: "All",
            href: "/approvals",
            count: rows.length,
          },
          ...moduleTabs.map((key) => ({
            value: key,
            label: moduleLabels.get(key) ?? key,
            href: `/approvals?tab=${encodeURIComponent(key)}`,
            count: counts.get(key),
          })),
        ]}
      />

      <ApprovalList
        pending={pending}
        decided={decided}
        decideAction={decideApproval}
      />
    </>
  );
}
