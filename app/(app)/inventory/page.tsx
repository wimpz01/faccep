import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createCategory, createItem, recordMovement } from "./actions";
import { CategoryForm, ItemForm, MovementForm } from "./inventory-forms";

export const metadata: Metadata = { title: "Inventory" };

type ItemRow = {
  id: string;
  name: string;
  sku: string | null;
  unit_of_measure: string;
  reorder_level: string;
  unit_cost: string;
  quantity_on_hand: string;
  inventory_categories: { name: string } | null;
};

export default async function InventoryPage() {
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;
  const canEditItems = can(context.permissions, MODULE.inventoryItems, "edit");
  const canMove = can(context.permissions, MODULE.inventoryMovements, "edit");

  const supabase = await createClient();
  const [{ data: items }, { data: categories }, { data: movements }] =
    await Promise.all([
      supabase
        .from("inventory_items")
        .select(
          "id, name, sku, unit_of_measure, reorder_level, unit_cost, quantity_on_hand, inventory_categories(name)",
        )
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name")
        .returns<ItemRow[]>(),
      supabase
        .from("inventory_categories")
        .select("id, name")
        .eq("company_id", companyId)
        .order("name"),
      supabase
        .from("inventory_movements")
        .select(
          "id, movement_kind, quantity, note, created_at, inventory_items(name, unit_of_measure)",
        )
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(25)
        .returns<
          {
            id: string;
            movement_kind: string;
            quantity: string;
            note: string | null;
            created_at: string;
            inventory_items: { name: string; unit_of_measure: string } | null;
          }[]
        >(),
    ]);

  const rows = items ?? [];
  const belowReorder = rows.filter(
    (item) =>
      Number(item.reorder_level) > 0 &&
      Number(item.quantity_on_hand) <= Number(item.reorder_level),
  );
  const stockValue = rows.reduce(
    (sum, item) => sum + Number(item.quantity_on_hand) * Number(item.unit_cost),
    0,
  );

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Stock on hand is the sum of the movement ledger — it is never typed in directly."
        action={
          <Link href="/inventory/tools" className="btn btn-secondary btn-sm">
            Tools & equipment
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <StatTile label="Items" value={rows.length} hint="Active stock items" />
        <StatTile
          label="Stock value"
          value={money(stockValue)}
          hint="On hand at unit cost"
          tone="money"
        />
        <StatTile
          label="At or below reorder"
          value={belowReorder.length}
          hint="Needs replenishing"
        />
      </div>

      {canMove ? (
        <div className="mb-6">
          <Card
            title="Record a stock movement"
            description="Returns put unused material back on the shelf, which is what stops leftovers going missing."
          >
            <MovementForm action={recordMovement} items={rows} />
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card title="Stock on hand" bodyClassName="">
          {rows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th className="text-right">On hand</th>
                    <th className="text-right">Reorder at</th>
                    <th className="text-right">Unit cost</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const low =
                      Number(item.reorder_level) > 0 &&
                      Number(item.quantity_on_hand) <= Number(item.reorder_level);
                    return (
                      <tr key={item.id}>
                        <td>
                          <span className="font-medium text-sm">{item.name}</span>
                          {item.sku ? (
                            <p className="text-xs muted">{item.sku}</p>
                          ) : null}
                        </td>
                        <td className="text-xs">
                          {item.inventory_categories?.name ?? "—"}
                        </td>
                        <td
                          className="text-right tabular-nums"
                          style={low ? { color: "var(--danger)" } : undefined}
                        >
                          {Number(item.quantity_on_hand)} {item.unit_of_measure}
                        </td>
                        <td className="text-right tabular-nums">
                          {Number(item.reorder_level) || "—"}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(item.unit_cost)}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(
                            Number(item.quantity_on_hand) * Number(item.unit_cost),
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No stock items yet.</EmptyState>
          )}
        </Card>
      </div>

      {canEditItems ? (
        <div className="grid gap-4 lg:grid-cols-2 mb-6">
          <Card title="Add an item">
            <ItemForm action={createItem} categories={categories ?? []} />
          </Card>
          <Card
            title="Categories"
            description={
              (categories ?? []).map((category) => category.name).join(", ") ||
              "None yet."
            }
          >
            <CategoryForm action={createCategory} />
          </Card>
        </div>
      ) : null}

      <Card title="Recent movements" bodyClassName="">
        {movements && movements.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th className="text-right">Quantity</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.id}>
                    <td className="text-xs muted">
                      {formatDateTime(movement.created_at)}
                    </td>
                    <td className="text-sm">{movement.inventory_items?.name}</td>
                    <td>
                      <span className="badge">{movement.movement_kind}</span>
                    </td>
                    <td
                      className="text-right tabular-nums"
                      style={
                        Number(movement.quantity) < 0
                          ? { color: "var(--danger)" }
                          : { color: "var(--success)" }
                      }
                    >
                      {Number(movement.quantity) > 0 ? "+" : ""}
                      {Number(movement.quantity)}{" "}
                      {movement.inventory_items?.unit_of_measure}
                    </td>
                    <td className="text-xs">{movement.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No movements recorded yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
