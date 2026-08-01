import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, StatTile, TabBar } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Stock item" };

type ItemDetail = {
  id: string;
  company_id: string;
  sku: string;
  name: string;
  unit_of_measure: string;
  reorder_level: string;
  unit_cost: string;
  quantity_on_hand: string;
  is_active: boolean;
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

const TAB_PURCHASES = "purchases";
const TAB_USAGE = "usage";
const TAB_LEDGER = "ledger";

export default async function StockItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();

  const { data: item } = await supabase
    .from("inventory_items")
    .select(
      `id, company_id, sku, name, unit_of_measure, reorder_level, unit_cost,
       quantity_on_hand, is_active, inventory_categories(name)`,
    )
    .eq("id", id)
    .maybeSingle<ItemDetail>();

  if (!item || item.company_id !== companyId) notFound();

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
        .order("created_at", { ascending: false })
        .limit(100)
        .returns<MovementRow[]>(),
    ]);

  const purchaseRows = (purchases ?? []).sort((a, b) =>
    (b.goods_receipts?.received_date ?? "").localeCompare(
      a.goods_receipts?.received_date ?? "",
    ),
  );
  const usageRows = (usage ?? []).sort((a, b) =>
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

  const active = [TAB_PURCHASES, TAB_USAGE, TAB_LEDGER].includes(tab ?? "")
    ? (tab as string)
    : TAB_PURCHASES;
  const base = `/inventory/${item.id}`;

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
        <StatTile
          label="Stock value"
          value={money(onHand * Number(item.unit_cost))}
          hint={`At ${money(item.unit_cost)} each`}
          tone="money"
        />
        <StatTile
          label="Bought to date"
          value={`${totalBought} ${item.unit_of_measure}`}
          hint={
            totalBought > 0
              ? `${money(totalSpent)} · avg ${money(averageCost)}`
              : "Never purchased through an order"
          }
        />
        <StatTile
          label="Used on jobs"
          value={`${totalUsed} ${item.unit_of_measure}`}
          hint={`Across ${usageRows.length} request(s)`}
        />
      </div>

      <TabBar
        active={active}
        tabs={[
          {
            value: TAB_PURCHASES,
            label: "Purchase history",
            href: base,
            count: purchaseRows.length,
          },
          {
            value: TAB_USAGE,
            label: "Where it was used",
            href: `${base}?tab=${TAB_USAGE}`,
            count: usageRows.length,
          },
          {
            value: TAB_LEDGER,
            label: "Movement ledger",
            href: `${base}?tab=${TAB_LEDGER}`,
            count: (movements ?? []).length,
          },
        ]}
      />

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
