import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { borrowTool, createTool, returnTool } from "../actions";
import { BorrowForm, ToolForm } from "../inventory-forms";

export const metadata: Metadata = { title: "Tools & equipment" };

type ToolRow = {
  id: string;
  name: string;
  serial_no: string | null;
  condition: string | null;
  status: string;
  tool_loans: {
    id: string;
    borrower_name: string;
    borrowed_at: string;
    expected_return: string | null;
    returned_at: string | null;
    condition_out: string | null;
  }[];
};

export default async function ToolsPage() {
  const context = await requirePermission(MODULE.inventoryTools, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.inventoryTools, "edit");

  const supabase = await createClient();
  const { data: tools } = await supabase
    .from("tools")
    .select(
      "id, name, serial_no, condition, status, tool_loans(id, borrower_name, borrowed_at, expected_return, returned_at, condition_out)",
    )
    .eq("company_id", companyId)
    .neq("status", "retired")
    .order("name")
    .returns<ToolRow[]>();

  const rows = tools ?? [];
  const available = rows.filter((tool) => tool.status === "available");
  const today = new Date().toISOString().slice(0, 10);

  const openLoans = rows.flatMap((tool) =>
    (tool.tool_loans ?? [])
      .filter((loan) => !loan.returned_at)
      .map((loan) => ({ tool, loan })),
  );
  const overdue = openLoans.filter(
    ({ loan }) => loan.expected_return && loan.expected_return < today,
  );

  return (
    <>
      <PageHeader
        title="Tools & equipment"
        description="Tracked separately from consumable materials, with a borrow and return slip per item."
        action={
          <Link href="/inventory" className="btn btn-secondary btn-sm">
            Back to inventory
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile label="Tools" value={rows.length} hint="In service" />
        <StatTile label="Available" value={available.length} hint="Not on loan" />
        <StatTile
          label="Overdue returns"
          value={overdue.length}
          hint="Past the expected date"
        />
      </div>

      {canEdit ? (
        <div className="grid gap-4 lg:grid-cols-2 mb-6">
          <Card title="Issue a tool">
            <BorrowForm action={borrowTool} tools={available} />
          </Card>
          <Card title="Add a tool">
            <ToolForm action={createTool} />
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card title="Out on loan" bodyClassName="">
          {openLoans.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Borrower</th>
                    <th>Taken</th>
                    <th>Due back</th>
                    {canEdit ? <th className="text-right">Return</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {openLoans.map(({ tool, loan }) => {
                    const isOverdue =
                      loan.expected_return && loan.expected_return < today;
                    return (
                      <tr key={loan.id}>
                        <td>
                          <span className="font-medium text-sm">{tool.name}</span>
                          {tool.serial_no ? (
                            <p className="text-xs muted">{tool.serial_no}</p>
                          ) : null}
                        </td>
                        <td className="text-sm">{loan.borrower_name}</td>
                        <td className="text-xs">{formatDate(loan.borrowed_at)}</td>
                        <td className="text-xs">
                          {formatDate(loan.expected_return)}
                          {isOverdue ? (
                            <p style={{ color: "var(--danger)" }}>overdue</p>
                          ) : null}
                        </td>
                        {canEdit ? (
                          <td className="text-right">
                            <form
                              action={returnTool}
                              className="inline-flex gap-2 items-center"
                            >
                              <input type="hidden" name="loan_id" value={loan.id} />
                              <input
                                name="condition_in"
                                className="input"
                                placeholder="Condition"
                                style={{ maxWidth: "9rem" }}
                              />
                              <button type="submit" className="btn btn-secondary btn-sm">
                                Return
                              </button>
                            </form>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>Every tool is on the shelf.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="All tools" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Serial</th>
                  <th>Condition</th>
                  <th>Status</th>
                  <th className="text-right">Loans</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tool) => (
                  <tr key={tool.id}>
                    <td className="text-sm font-medium">{tool.name}</td>
                    <td className="text-xs">{tool.serial_no ?? "—"}</td>
                    <td className="text-xs">{tool.condition ?? "—"}</td>
                    <td>
                      <span
                        className={
                          tool.status === "available" ? "badge badge-brand" : "badge"
                        }
                      >
                        {tool.status}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {(tool.tool_loans ?? []).length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No tools recorded yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
