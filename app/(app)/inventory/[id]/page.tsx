import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, StatTile, TabBar } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { updateItem } from "../actions";
import { ItemSettingsForm } from "../item-settings-form";

export const metadata: Metadata = { title: "Stock item" };

type ItemDetail = {
  id: string;
  company_id: string;
  sku: string;
  name: string;
  category_id: string | null;
  unit_of_measure: string;
  reorder_level: string;
  unit_cost: string;
  quantity_on_hand: string;
  is_active: boolean;
  inventory_account_id: string | null;
  adjustment_account_id: string | null;
  inventory_categories: { name: string } | null;
};

/** A receipt line, carrying the order and supplier it came from. */
type PurchaseRow = {
  quantity: string;
  goods_receipts: {
    receipt_no: string;
    received_date: string;
    purchase_orders: {
      po_no: string;
      vendors: { name: string; vendor_no: string } | null;
      locations: { code: string; name: string } | null;
    } | null;
  } | null;
  purchase_order_lines: { unit_price: string; description: string } | null;
};

/** An issue line, carrying the job it was drawn for. */
type UsageRow = {
  quantity_requested: string;
  quantity_issued: string;
  quantity_used: string;
  quantity_returned: string;
  material_requests: {
    request_no: string;
    created_at: string;
    maintenance_jobs: {
      id: string;
      job_no: string;
      title: string;
      locations: { code: string } | null;
    } | null;
  } | null;
};

type MovementRow = {
  id: string;
  movement_kind: string;
  quantity: string;
  unit_cost: string;
  note: string | null;
  created_at: string;
};

const MOVEMENT_LABEL: Record<string, string> = {
  receipt: "Received",
  issue: "Issued",
  return: "Returned",
  adjustment: "Adjusted",
};

const TAB_DETAILS = "details";
const TAB_PURCHASES = "purchases";
const TAB_USAGE = "usage";
const TAB_LEDGER = "ledger";

export default async function StockItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; from?: string; to?: string }>;
}) {
  const { id } = await params;
  const { tab, from, to } = await searchParams;
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;
  const canEditItems = can(context.permissions, MODULE.inventoryItems, "edit");
  // Same rule as the list: hiding the total there but showing it here would
  // just mean one more click to see it.
  const canSeeValue = Boolean(
    context.isSuperAdmin || context.activeCompany?.isCompanyAdmin,
  );

  const supabase = await createClient();

  const { data: item } = await supabase
    .from("inventory_items")
    .select(
      `id, company_id, sku, name, category_id, unit_of_measure, reorder_level,
       unit_cost, quantity_on_hand, is_active, inventory_account_id,
       adjustment_account_id, inventory_categories(name)`,
    )
    .eq("id", id)
    .maybeSingle<ItemDetail>();

  if (!item || item.company_id !== companyId) notFound();

  /*
   * What the stock is worth is a fact about now, so it is read whole rather
   * than derived from whatever date range is being looked at.
   */
  const [{ data: costing }, { data: categories }, { data: accounts }] =
    await Promise.all([
      supabase
        .from("inventory_item_costs")
        .select("average_cost, stock_value, quantity_in, spent_in")
        .eq("item_id", id)
        .maybeSingle<{
          average_cost: string;
          stock_value: string;
          quantity_in: string;
          spent_in: string;
        }>(),
      supabase
        .from("inventory_categories")
        .select("id, name")
        .eq("company_id", companyId)
        .order("name")
        .returns<{ id: string; name: string }[]>(),
      supabase
        .from("chart_of_accounts")
        .select("id, code, name, account_type")
        .eq("company_id", companyId)
        .in("account_type", ["asset", "expense"])
        .order("code")
        .returns<
          { id: string; code: string; name: string; account_type: string }[]
        >(),
    ]);

  const [{ data: purchases }, { data: usage }, { data: movements }] =
    await Promise.all([
      // Every time this item was actually received, with what it cost and
      // who supplied it.
      supabase
        .from("goods_receipt_lines")
        .select(
          `quantity,
           goods_receipts(receipt_no, received_date,
             purchase_orders(po_no, vendors(name, vendor_no), locations(code, name))),
           purchase_order_lines!inner(unit_price, description, item_id)`,
        )
        .eq("purchase_order_lines.item_id", id)
        .returns<PurchaseRow[]>(),
      // Every job it was drawn for.
      supabase
        .from("material_request_lines")
        .select(
          `quantity_requested, quantity_issued, quantity_used, quantity_returned,
           material_requests(request_no, created_at,
             maintenance_jobs(id, job_no, title, locations(code)))`,
        )
        .eq("item_id", id)
        .returns<UsageRow[]>(),
      supabase
        .from("inventory_movements")
        .select("id, movement_kind, quantity, unit_cost, note, created_at")
        .eq("item_id", id)
        // The ledger carries its own date, so it is narrowed here rather than
        // after the fact -- otherwise the row limit would bite before the
        // filter did, and an older range would look empty.
        .gte("created_at", from ? `${from}T00:00:00` : "1900-01-01")
        .lte("created_at", to ? `${to}T23:59:59` : "2999-12-31")
        .order("created_at", { ascending: false })
        .limit(100)
        .returns<MovementRow[]>(),
    ]);

  /**
   * Both of these carry their date on an embedded row, which PostgREST will
   * not filter on, so they are narrowed once they are here. Blank ends mean
   * "no bound" rather than "today", so an untouched page still shows
   * everything the item has ever done.
   */
  const inRange = (date: string | null | undefined) => {
    if (!date) return false;
    const day = date.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };
  const filtering = Boolean(from || to);

  const purchaseRows = (purchases ?? [])
    .filter(
      (row) => !filtering || inRange(row.goods_receipts?.received_date),
    )
    .sort((a, b) =>
      (b.goods_receipts?.received_date ?? "").localeCompare(
        a.goods_receipts?.received_date ?? "",
      ),
    );
  const usageRows = (usage ?? [])
    .filter((row) => !filtering || inRange(row.material_requests?.created_at))
    .sort((a, b) =>
      (b.material_requests?.created_at ?? "").localeCompare(
        a.material_requests?.created_at ?? "",
      ),
    );

  const onHand = Number(item.quantity_on_hand);
  const totalBought = purchaseRows.reduce(
    (sum, row) => sum + Number(row.quantity),
    0,
  );
  const totalSpent = purchaseRows.reduce(
    (sum, row) =>
      sum + Number(row.quantity) * Number(row.purchase_order_lines?.unit_price ?? 0),
    0,
  );
  const totalUsed = usageRows.reduce(
    (sum, row) => sum + Number(row.quantity_used),
    0,
  );
  // What it has actually cost on average, rather than the standing unit cost.
  const averageCost = totalBought > 0 ? totalSpent / totalBought : 0;

  // Opening an item shows what it is; its history is a click away.
  const active = [TAB_DETAILS, TAB_PURCHASES, TAB_USAGE, TAB_LEDGER].includes(
    tab ?? "",
  )
    ? (tab as string)
    : TAB_DETAILS;
  const base = `/inventory/${item.id}`;

  /** Switching tabs keeps whatever date range is being looked at. */
  const tabHref = (value: string) => {
    const query = new URLSearchParams({ tab: value });
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    return `${base}?${query.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={item.name}
        description={`${item.sku} · ${item.inventory_categories?.name ?? "Uncategorised"}`}
        action={
          <Link href="/inventory" className="btn btn-secondary btn-sm">
            Back to inventory
          </Link>
        }
      />

      {/* The tab rides along, so filtering does not throw you back to the
          first one. Setup has no dates to narrow, so it has no filter. */}
      {active !== TAB_DETAILS ? (
      <div className="card mb-5">
        <div className="card-body">
          <form method="get" className="grid gap-3 sm:grid-cols-5 items-end">
            <input type="hidden" name="tab" value={active} />
            <div>
              <label className="label" htmlFor="from">
                From
              </label>
              <input
                id="from"
                name="from"
                type="date"
                className="input"
                defaultValue={from ?? ""}
              />
            </div>
            <div>
              <label className="label" htmlFor="to">
                To
              </label>
              <input
                id="to"
                name="to"
                type="date"
                className="input"
                defaultValue={to ?? ""}
              />
            </div>
            <div className="flex items-center gap-2">
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
              {filtering ? (
                <Link
                  href={`${base}?tab=${active}`}
                  className="btn btn-secondary"
                >
                  Clear
                </Link>
              ) : null}
            </div>
            <div className="sm:col-span-2">
              <p className="text-xs muted">
                {filtering
                  ? `Showing ${from ? formatDate(from) : "the beginning"} to ${to ? formatDate(to) : "today"}. On hand and stock value are always current.`
                  : "Leave blank for everything. Narrow it to work out what a period actually used."}
              </p>
            </div>
          </form>
        </div>
      </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="On hand"
          value={`${onHand} ${item.unit_of_measure}`}
          hint={
            Number(item.reorder_level) > 0 && onHand <= Number(item.reorder_level)
              ? "At or below reorder level"
              : `Reorder at ${Number(item.reorder_level)}`
          }
        />
        {canSeeValue ? (
        <StatTile
          label="Stock value"
          value={money(costing?.stock_value ?? onHand * Number(item.unit_cost))}
          hint={
            Number(costing?.quantity_in ?? 0) > 0
              ? `At ${money(costing!.average_cost)} average each`
              : `At ${money(item.unit_cost)} each — nothing received yet`
          }
          tone="money"
        />
        ) : null}
        <StatTile
          label={filtering ? "Bought in range" : "Bought to date"}
          value={`${totalBought} ${item.unit_of_measure}`}
          hint={
            totalBought > 0
              ? `${money(totalSpent)} · avg ${money(averageCost)}`
              : "Never purchased through an order"
          }
        />
        <StatTile
          label={filtering ? "Used in range" : "Used on jobs"}
          value={`${totalUsed} ${item.unit_of_measure}`}
          hint={`Across ${usageRows.length} request(s)`}
        />
      </div>

      <TabBar
        active={active}
        tabs={[
          {
            value: TAB_DETAILS,
            label: "Item setup",
            href: tabHref(TAB_DETAILS),
          },
          {
            value: TAB_PURCHASES,
            label: "Purchase history",
            href: tabHref(TAB_PURCHASES),
            count: purchaseRows.length,
          },
          {
            value: TAB_USAGE,
            label: "Where it was used",
            href: tabHref(TAB_USAGE),
            count: usageRows.length,
          },
          {
            value: TAB_LEDGER,
            label: "Movement ledger",
            href: tabHref(TAB_LEDGER),
            count: (movements ?? []).length,
          },
        ]}
      />

      {active === TAB_DETAILS ? (
        <Card
          title="Item setup"
          description="What this item is and where it belongs in the accounts. What is on hand comes from the ledger, so it is not editable here."
        >
          <ItemSettingsForm
            action={updateItem}
            canEdit={canEditItems}
            averageCost={
              Number(costing?.quantity_in ?? 0) > 0
                ? Number(costing!.average_cost).toFixed(2)
                : null
            }
            item={{
              id: item.id,
              sku: item.sku,
              name: item.name,
              category_id: item.category_id,
              unit_of_measure: item.unit_of_measure,
              reorder_level: item.reorder_level,
              unit_cost: item.unit_cost,
              is_active: item.is_active,
              inventory_account_id: item.inventory_account_id,
              adjustment_account_id: item.adjustment_account_id,
            }}
            categories={categories ?? []}
            assetAccounts={(accounts ?? []).filter(
              (account) => account.account_type === "asset",
            )}
            expenseAccounts={(accounts ?? []).filter(
              (account) => account.account_type === "expense",
            )}
          />
        </Card>
      ) : null}

      {active === TAB_PURCHASES ? (
        <Card
          title="Purchase history"
          description="Taken from goods actually received against an order, so it reflects deliveries rather than intentions."
          bodyClassName=""
        >
          {purchaseRows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Supplier</th>
                    <th>Order</th>
                    <th>Property</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseRows.map((row, index) => {
                    const order = row.goods_receipts?.purchase_orders;
                    const price = Number(row.purchase_order_lines?.unit_price ?? 0);
                    return (
                      <tr key={`${row.goods_receipts?.receipt_no}-${index}`}>
                        <td className="text-xs">
                          {formatDate(row.goods_receipts?.received_date ?? null)}
                          <p className="muted">{row.goods_receipts?.receipt_no}</p>
                        </td>
                        <td className="text-sm">
                          {order?.vendors?.name ?? "—"}
                          {order?.vendors?.vendor_no ? (
                            <p className="text-xs muted">
                              {order.vendors.vendor_no}
                            </p>
                          ) : null}
                        </td>
                        <td className="text-xs">{order?.po_no ?? "—"}</td>
                        <td className="text-xs">
                          {order?.locations
                            ? order.locations.code
                            : "Company-wide"}
                        </td>
                        <td className="text-right tabular-nums">
                          {Number(row.quantity)} {item.unit_of_measure}
                        </td>
                        <td className="text-right tabular-nums">{money(price)}</td>
                        <td className="text-right tabular-nums">
                          {money(Number(row.quantity) * price)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td colSpan={4} className="font-semibold">
                      Total received
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {totalBought} {item.unit_of_measure}
                    </td>
                    <td />
                    <td className="text-right tabular-nums font-semibold">
                      {money(totalSpent)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              Nothing received against a purchase order yet. Stock added by a
              direct movement appears in the ledger.
            </EmptyState>
          )}
        </Card>
      ) : null}

      {active === TAB_USAGE ? (
        <Card
          title="Where it was used"
          description="Material requests this item was drawn for, and the job behind each one."
          bodyClassName=""
        >
          {usageRows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Job</th>
                    <th>Property</th>
                    <th className="text-right">Issued</th>
                    <th className="text-right">Used</th>
                    <th className="text-right">Returned</th>
                  </tr>
                </thead>
                <tbody>
                  {usageRows.map((row, index) => {
                    const job = row.material_requests?.maintenance_jobs;
                    return (
                      <tr key={`${row.material_requests?.request_no}-${index}`}>
                        <td className="text-xs">
                          {row.material_requests?.request_no ?? "—"}
                          <p className="muted">
                            {formatDate(
                              row.material_requests?.created_at?.slice(0, 10) ??
                                null,
                            )}
                          </p>
                        </td>
                        <td className="text-sm">
                          {job ? (
                            <Link
                              href={`/maintenance/jobs/${job.id}`}
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              {job.job_no}
                            </Link>
                          ) : (
                            <span className="muted">Not against a job</span>
                          )}
                          {job?.title ? (
                            <p className="text-xs muted">{job.title}</p>
                          ) : null}
                        </td>
                        <td className="text-xs">
                          {job?.locations?.code ?? "—"}
                        </td>
                        <td className="text-right tabular-nums">
                          {Number(row.quantity_issued)}
                        </td>
                        <td className="text-right tabular-nums">
                          {Number(row.quantity_used)}
                        </td>
                        <td
                          className="text-right tabular-nums"
                          style={
                            Number(row.quantity_returned) > 0
                              ? { color: "var(--success)" }
                              : undefined
                          }
                        >
                          {Number(row.quantity_returned) || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>This item has not been issued to a job yet.</EmptyState>
          )}
        </Card>
      ) : null}

      {active === TAB_LEDGER ? (
        <Card
          title="Movement ledger"
          description="Every change to the balance. On hand is the sum of this list, never typed in."
          bodyClassName=""
        >
        {movements && movements.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Movement</th>
                  <th className="text-right">Quantity</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs">
                      {formatDate(row.created_at.slice(0, 10))}
                    </td>
                    <td className="text-xs">
                      <span className="badge">
                        {MOVEMENT_LABEL[row.movement_kind] ?? row.movement_kind}
                      </span>
                    </td>
                    <td
                      className="text-right tabular-nums"
                      style={
                        Number(row.quantity) < 0
                          ? { color: "var(--danger)" }
                          : undefined
                      }
                    >
                      {Number(row.quantity) > 0 ? "+" : ""}
                      {Number(row.quantity)} {item.unit_of_measure}
                    </td>
                    <td className="text-xs muted">{row.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          ) : (
            <EmptyState>No movements recorded for this item.</EmptyState>
          )}
        </Card>
      ) : null}
    </>
  );
}
