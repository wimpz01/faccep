import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, FilterNote, PageHeader, StatTile, TabBar, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createCategory, createItem, importItems, recordMovement } from "./actions";
import {
  CategoryForm,
  ImportItemsForm,
  ItemForm,
  MovementForm,
} from "./inventory-forms";

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

type CategoryRow = {
  id: string;
  name: string;
  inventory_items: { id: string }[];
};

const TAB_ITEMS = "items";
const TAB_MOVEMENT = "movement";
const TAB_CATEGORIES = "categories";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; add?: string; view?: string }>;
}) {
  const { tab, add, view } = await searchParams;
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;
  const canEditItems = can(context.permissions, MODULE.inventoryItems, "edit");
  const canMove = can(context.permissions, MODULE.inventoryMovements, "edit");

  const active = [TAB_ITEMS, TAB_MOVEMENT, TAB_CATEGORIES].includes(tab ?? "")
    ? (tab as string)
    : TAB_ITEMS;
  const addOpen = add === "1" && canEditItems;

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
        .select("id, name, inventory_items(id)")
        .eq("company_id", companyId)
        .order("name")
        .returns<CategoryRow[]>(),
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
  // Clicking a figure narrows the item list to exactly what it counted.
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
            {canEditItems ? (
              <Link
                href={addOpen ? "/inventory" : "/inventory?add=1"}
                className={addOpen ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"}
              >
                {addOpen ? "Close" : "Add new item"}
              </Link>
            ) : null}
            <a href="/inventory/export" className="btn btn-secondary btn-sm">
              Export CSV
            </a>
            <Link href="/inventory/tools" className="btn btn-secondary btn-sm">
              Tools &amp; equipment
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <StatTile
          label="Items"
          value={rows.length}
          hint="Active stock items"
          href="/inventory?tab=items"
        />
        <StatTile
          label="Stock value"
          value={money(stockValue)}
          hint="On hand at unit cost"
          tone="money"
          href="/inventory?tab=items"
        />
        <StatTile
          label="At or below reorder"
          value={belowReorder.length}
          hint="Needs replenishing"
          href="/inventory?tab=items&view=reorder"
        />
      </div>

      {addOpen ? (
        <div className="grid gap-4 lg:grid-cols-2 mb-6">
          <Card
            title="Add an item"
            description="One at a time. The code is issued on save."
          >
            <ItemForm action={createItem} categories={categories ?? []} />
          </Card>
          <Card
            title="Import a list"
            description="Many at once from a spreadsheet, instead of typing them in one by one."
          >
            <ImportItemsForm action={importItems} />
          </Card>
        </div>
      ) : null}

      <TabBar
        active={active}
        tabs={[
          {
            value: TAB_ITEMS,
            label: "Item list",
            href: "/inventory",
            count: rows.length,
          },
          {
            value: TAB_MOVEMENT,
            label: "Record movement",
            href: `/inventory?tab=${TAB_MOVEMENT}`,
          },
          {
            value: TAB_CATEGORIES,
            label: "Categories",
            href: `/inventory?tab=${TAB_CATEGORIES}`,
            count: (categories ?? []).length,
          },
        ]}
      />

      {filterLabel && active === TAB_ITEMS ? (

        <FilterNote

          label={filterLabel}

          count={shown.length}

          clearHref={`/inventory?tab=${TAB_ITEMS}`}

        />

      ) : null}

      

      {active === TAB_ITEMS ? (
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
      ) : null}

      {active === TAB_CATEGORIES ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {canEditItems ? (
            <Card
              title="Add a category"
              description="Groups items on the list and in reports."
            >
              <CategoryForm action={createCategory} />
            </Card>
          ) : null}
          <Card title="Categories" bodyClassName="">
            {(categories ?? []).length > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th className="text-right">Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(categories ?? []).map((category) => (
                      <tr key={category.id}>
                        <td className="text-sm">{category.name}</td>
                        <td className="text-right tabular-nums">
                          {(category.inventory_items ?? []).length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState>No categories yet.</EmptyState>
            )}
          </Card>
        </div>
      ) : null}

      {active === TAB_MOVEMENT ? (
        <>
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
      ) : null}
    </>
  );
}
