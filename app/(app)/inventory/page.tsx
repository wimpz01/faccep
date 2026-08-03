import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

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

/**
 * What is on the shelf, and nothing else.
 *
 * Adding, importing, adjusting and reading the ledger back each have their own
 * page under Inventory in the side panel. They are separate jobs, so they are
 * separate screens rather than tabs stacked on this one.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;
  const canEditItems = can(context.permissions, MODULE.inventoryItems, "edit");

  const supabase = await createClient();
  const { data: items } = await supabase
    .from("inventory_items")
    .select(
      "id, name, sku, unit_of_measure, reorder_level, unit_cost, quantity_on_hand, inventory_categories(name)",
    )
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("name")
    .returns<ItemRow[]>();

  const rows = items ?? [];
  const belowReorder = rows.filter(
    (item) =>
      Number(item.reorder_level) > 0 &&
      Number(item.quantity_on_hand) <= Number(item.reorder_level),
  );
  // Clicking a figure narrows the list to exactly what it counted.
  const shown = view === "reorder" ? belowReorder : rows;
  const filterLabel =
    view === "reorder" ? "items at or below their reorder level" : null;

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
          <div className="flex gap-2 flex-wrap">
            <a href="/inventory/export" className="btn btn-secondary btn-sm">
              Export CSV
            </a>
            {canEditItems ? (
              <Link href="/inventory/new" className="btn btn-primary btn-sm">
                + Add new item
              </Link>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <StatTile
          label="Items"
          value={rows.length}
          hint="Active stock items"
          href="/inventory"
        />
        <StatTile
          label="Stock value"
          value={money(stockValue)}
          hint="On hand at unit cost"
          tone="money"
          href="/inventory"
        />
        <StatTile
          label="At or below reorder"
          value={belowReorder.length}
          hint="Needs replenishing"
          href="/inventory?view=reorder"
        />
      </div>

      {filterLabel ? (
        <FilterNote
          label={filterLabel}
          count={shown.length}
          clearHref="/inventory"
        />
      ) : null}

      <Card
        title="Item list"
        description="Everything on file. Open an item to see what it cost, who supplied it and where it went."
        bodyClassName=""
      >
        {shown.length > 0 ? (
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
                {shown.map((item) => {
                  const low =
                    Number(item.reorder_level) > 0 &&
                    Number(item.quantity_on_hand) <= Number(item.reorder_level);
                  return (
                    <tr key={item.id}>
                      <td>
                        <Link
                          href={`/inventory/${item.id}`}
                          className="font-medium text-sm"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {item.name}
                        </Link>
                        {item.sku ? (
                          <p className="text-xs muted tabular-nums">{item.sku}</p>
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
          <EmptyState>
            No stock items yet. Use <strong>Add new item</strong> above.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
