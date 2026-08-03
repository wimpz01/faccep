import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createAdjustment } from "../actions";
import { AdjustmentForm, type AdjustItem } from "../adjustment-form";

export const metadata: Metadata = { title: "Stock adjustment" };

type AdjustmentRow = {
  id: string;
  adjustment_no: string;
  adjustment_date: string;
  reason: string | null;
  created_at: string;
  inventory_adjustment_lines: { id: string; quantity: string }[];
  profiles: { full_name: string | null; email: string } | null;
};

export default async function StockAdjustmentPage() {
  const context = await requirePermission(MODULE.inventoryMovements, "view");
  const companyId = context.activeCompany!.companyId;
  const canAdjust = can(context.permissions, MODULE.inventoryMovements, "edit");

  const supabase = await createClient();
  const [{ data: items }, { data: adjustments }] = await Promise.all([
    supabase
      .from("inventory_items")
      .select("id, name, sku, unit_of_measure, quantity_on_hand, unit_cost")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name")
      .returns<AdjustItem[]>(),
    supabase
      .from("inventory_adjustments")
      .select(
        `id, adjustment_no, adjustment_date, reason, created_at,
         inventory_adjustment_lines(id, quantity),
         profiles!inventory_adjustments_created_by_fkey(full_name, email)`,
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<AdjustmentRow[]>(),
  ]);

  const posted = adjustments ?? [];

  return (
    <>
      <PageHeader
        title="Stock adjustment"
        description="A counted correction, posted as one numbered document. The number is issued on save."
        action={
          <Link href="/inventory/history" className="btn btn-secondary btn-sm">
            Movement history
          </Link>
        }
      />

      {canAdjust ? (
        <div className="mb-6">
          <Card
            title="New adjustment"
            description="Add a line for each item counted. Returns put unused material back on the shelf, which is what stops leftovers going missing."
          >
            <AdjustmentForm action={createAdjustment} items={items ?? []} />
          </Card>
        </div>
      ) : (
        <div className="mb-6">
          <Card title="New adjustment">
            <EmptyState>
              Adjusting stock needs Edit on inventory movements.
            </EmptyState>
          </Card>
        </div>
      )}

      <Card title="Posted adjustments" bodyClassName="">
        {posted.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Adjustment #</th>
                  <th>Date</th>
                  <th>Reason</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Net quantity</th>
                  <th>Posted by</th>
                </tr>
              </thead>
              <tbody>
                {posted.map((row) => {
                  const lines = row.inventory_adjustment_lines ?? [];
                  const net = lines.reduce(
                    (sum, line) => sum + Number(line.quantity),
                    0,
                  );
                  return (
                    <tr key={row.id}>
                      <td className="font-medium text-sm tabular-nums">
                        {row.adjustment_no}
                      </td>
                      <td className="text-xs">
                        {formatDate(row.adjustment_date)}
                        <p className="muted">{formatDateTime(row.created_at)}</p>
                      </td>
                      <td className="text-sm">{row.reason ?? "—"}</td>
                      <td className="text-right tabular-nums">{lines.length}</td>
                      <td
                        className="text-right tabular-nums"
                        style={{
                          color: net < 0 ? "var(--danger)" : "var(--success)",
                        }}
                      >
                        {net > 0 ? "+" : ""}
                        {net}
                      </td>
                      <td className="text-xs muted">
                        {row.profiles?.full_name || row.profiles?.email || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No adjustments posted yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
