import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { deleteAdjustment, saveAdjustment } from "../../actions";
import {
  AdjustmentForm,
  type AdjustItem,
  type ExistingLine,
} from "../../adjustment-form";

export const metadata: Metadata = { title: "Adjustment" };

const KIND_LABEL: Record<string, string> = {
  adjustment: "Count correction",
  receipt: "Receipt — in",
  return: "Return — in",
  issue: "Issue — out",
};

type Detail = {
  id: string;
  company_id: string;
  adjustment_no: string;
  adjustment_date: string;
  reason: string | null;
  status: string;
  movement_kind: string;
  posted_at: string | null;
  created_at: string;
  profiles: { full_name: string | null; email: string } | null;
  inventory_adjustment_lines: (ExistingLine & {
    id: string;
    inventory_items: { name: string; sku: string | null; unit_of_measure: string } | null;
  })[];
};

export default async function AdjustmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.inventoryMovements, "view");
  const companyId = context.activeCompany!.companyId;
  const canAdjust = can(context.permissions, MODULE.inventoryMovements, "edit");

  const supabase = await createClient();
  const { data: adjustment } = await supabase
    .from("inventory_adjustments")
    .select(
      `id, company_id, adjustment_no, adjustment_date, reason, status, movement_kind,
       posted_at, created_at,
       profiles!inventory_adjustments_created_by_fkey(full_name, email),
       inventory_adjustment_lines(id, item_id, quantity, unit_cost, note,
         inventory_items(name, sku, unit_of_measure))`,
    )
    .eq("id", id)
    .maybeSingle<Detail>();

  if (!adjustment || adjustment.company_id !== companyId) notFound();

  const isDraft = adjustment.status === "draft";
  const lines = adjustment.inventory_adjustment_lines ?? [];

  const { data: items } = await supabase
    .from("inventory_items")
    .select("id, name, sku, unit_of_measure, quantity_on_hand, unit_cost")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("name")
    .returns<AdjustItem[]>();

  return (
    <>
      <PageHeader
        title={adjustment.adjustment_no}
        description={`${KIND_LABEL[adjustment.movement_kind] ?? adjustment.movement_kind} · ${formatDate(adjustment.adjustment_date)} · ${
          isDraft ? "draft — nothing has moved yet" : "posted"
        }`}
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/inventory/adjustments" className="btn btn-secondary btn-sm">
              Back
            </Link>
            {isDraft && canAdjust ? (
              <form action={deleteAdjustment}>
                <input type="hidden" name="adjustment_id" value={adjustment.id} />
                <button type="submit" className="btn btn-secondary btn-sm">
                  Delete draft
                </button>
              </form>
            ) : null}
          </div>
        }
      />

      {isDraft && canAdjust ? (
        <Card
          title="Edit this draft"
          description="Change what you need, then post it. Nothing moves until you do."
        >
          <AdjustmentForm
            action={saveAdjustment}
            items={items ?? []}
            adjustmentId={adjustment.id}
            initialKind={adjustment.movement_kind}
            initialDate={adjustment.adjustment_date}
            initialReason={adjustment.reason ?? ""}
            initialLines={lines.map((line) => ({
              item_id: line.item_id,
              quantity: line.quantity,
              unit_cost: line.unit_cost,
              note: line.note,
            }))}
          />
        </Card>
      ) : (
        <Card
          title={isDraft ? "Draft" : "Posted"}
          description={
            isDraft
              ? "Editing a draft needs Edit on inventory movements."
              : `Written to the ledger ${
                  adjustment.posted_at ? formatDateTime(adjustment.posted_at) : ""
                } by ${adjustment.profiles?.full_name || adjustment.profiles?.email || "—"}. A posted adjustment cannot be taken back — post a correcting one instead.`
          }
          bodyClassName=""
        >
          {lines.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU #</th>
                    <th>Item</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit cost</th>
                    <th className="text-right">Value</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const quantity = Number(line.quantity);
                    const cost = Number(line.unit_cost ?? 0);
                    return (
                      <tr key={line.id}>
                        <td className="text-xs tabular-nums muted">
                          {line.inventory_items?.sku ?? "—"}
                        </td>
                        <td className="text-sm">{line.inventory_items?.name}</td>
                        <td
                          className="text-right tabular-nums"
                          style={{
                            color: quantity < 0 ? "var(--danger)" : "var(--success)",
                          }}
                        >
                          {quantity > 0 ? "+" : ""}
                          {quantity} {line.inventory_items?.unit_of_measure}
                        </td>
                        <td className="text-right tabular-nums text-sm">
                          {money(cost)}
                        </td>
                        <td className="text-right tabular-nums text-sm">
                          {money(Math.abs(quantity) * cost)}
                        </td>
                        <td className="text-xs">{line.note ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>This adjustment has no lines.</EmptyState>
          )}
        </Card>
      )}
    </>
  );
}
