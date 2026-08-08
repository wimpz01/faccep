import type { Metadata } from "next";
import Link from "next/link";

import { FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { ItemList } from "./item-list";

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
  // What stock is worth is a money question, so it stays with the people who
  // are trusted with money questions. Storekeepers still see quantities.
  const canSeeValue = Boolean(
    context.isSuperAdmin || context.activeCompany?.isCompanyAdmin,
  );

  const supabase = await createClient();
  const [{ data: items }, { data: costs }] = await Promise.all([
    supabase
      .from("inventory_items")
      .select(
        "id, name, sku, unit_of_measure, reorder_level, unit_cost, quantity_on_hand, inventory_categories(name)",
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name")
      .returns<ItemRow[]>(),
    // Valued at what was actually paid, not at whatever unit cost was typed.
    supabase
      .from("inventory_item_costs")
      .select("item_id, average_cost, stock_value")
      .eq("company_id", companyId)
      .returns<
        { item_id: string; average_cost: string; stock_value: string }[]
      >(),
  ]);

  const costBy = new Map((costs ?? []).map((row) => [row.item_id, row]));
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
    (sum, item) => sum + Number(costBy.get(item.id)?.stock_value ?? 0),
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
        {canSeeValue ? (
          <StatTile
            label="Stock value"
            value={money(stockValue)}
            hint="On hand at average cost paid"
            tone="money"
            href="/inventory"
          />
        ) : null}
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

      <ItemList
        showValue={canSeeValue}
        title={`${shown.length} item${shown.length === 1 ? "" : "s"}`}
        rows={shown.map((item) => ({
          id: item.id,
          name: item.name,
          sku: item.sku,
          unit_of_measure: item.unit_of_measure,
          reorder_level: Number(item.reorder_level),
          unit_cost: Number(costBy.get(item.id)?.average_cost ?? item.unit_cost),
          quantity_on_hand: Number(item.quantity_on_hand),
          category: item.inventory_categories?.name ?? "—",
        }))}
      />
    </>
  );
}

