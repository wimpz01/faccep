import type { Metadata } from "next";
import Link from "next/link";

import { FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createPurchaseOrder } from "../actions";
import { OrderList } from "../order-list";
import { PurchaseOrderForm } from "../purchasing-forms";

export const metadata: Metadata = { title: "Purchase orders" };

type OrderRow = {
  id: string;
  po_no: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  total: string;
  vendors: { name: string } | null;
  purchase_requests: { request_no: string } | null;
};

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; add?: string }>;
}) {
  const { view, add } = await searchParams;
  const context = await requirePermission(MODULE.purchasingOrders, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.purchasingOrders, "edit");

  const supabase = await createClient();
  const [
    { data: orders },
    { data: vendors },
    { data: items },
    { data: approved },
    { data: expenseAccounts },
    { data: locations },
  ] = await Promise.all([
      supabase
        .from("purchase_orders")
        .select(
          "id, po_no, status, order_date, expected_date, total, vendors(name), purchase_requests(request_no)",
        )
        .eq("company_id", companyId)
        .order("order_date", { ascending: false })
        .limit(100)
        .returns<OrderRow[]>(),
      supabase
        .from("vendors")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("status", "approved")
        .order("name"),
      supabase
        .from("inventory_items")
        .select("id, name, unit_of_measure")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("purchase_requests")
        .select(
          "id, request_no, locations(code, name), purchase_request_lines(item_id, description, quantity, estimated_price)",
        )
        .eq("company_id", companyId)
        .eq("status", "approved")
        .order("request_no")
        .returns<
          {
            id: string;
            request_no: string;
            locations: { code: string; name: string } | null;
            purchase_request_lines: {
              item_id: string | null;
              description: string;
              quantity: string;
              estimated_price: string;
            }[];
          }[]
        >(),
      // Services and utilities are charged to one of these, not to Inventory.
      supabase
        .from("chart_of_accounts")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("account_type", "expense")
        .eq("is_active", true)
        .order("code"),
      supabase
        .from("locations")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("code"),
    ]);

  const approvedRequests = (approved ?? []).map((request) => ({
    id: request.id,
    request_no: request.request_no,
    locationLabel: request.locations
      ? `${request.locations.code} — ${request.locations.name}`
      : "Company-wide",
    // Carried onto the order so an approved request does not have to be
    // keyed in a second time.
    lines: (request.purchase_request_lines ?? []).map((line) => ({
      itemId: line.item_id ?? "",
      description: line.description,
      quantity: String(Number(line.quantity)),
      price: String(Number(line.estimated_price)),
    })),
  }));

  const rows = orders ?? [];
  const outstanding = rows.filter((row) =>
    ["issued", "partially_received"].includes(row.status),
  );

  // Clicking a figure narrows the list below it to exactly what it counted.
  const shown = view === "outstanding" ? outstanding : rows;
  const filterLabel =
    view === "outstanding" ? "orders still awaiting delivery" : null;
  const adding = canEdit && add === "1";

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Receiving against an order updates stock automatically."
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/purchasing/requests" className="btn btn-secondary btn-sm">
              Requests
            </Link>
            <Link href="/purchasing/vendors" className="btn btn-secondary btn-sm">
              Suppliers
            </Link>
            {canEdit ? (
              adding ? (
                <Link
                  href="/purchasing/orders"
                  className="btn btn-secondary btn-sm"
                >
                  Close
                </Link>
              ) : (
                <Link
                  href="/purchasing/orders?add=1"
                  className="btn btn-primary btn-sm"
                >
                  + Create order
                </Link>
              )
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile
          label="Awaiting delivery"
          value={outstanding.length}
          hint="Issued or part received"
          href="/purchasing/orders?view=outstanding"
        />
        <StatTile
          label="Committed"
          value={money(outstanding.reduce((sum, row) => sum + Number(row.total), 0))}
          hint="Value still on order"
          tone="money"
          href="/purchasing/orders?view=outstanding"
        />
        <StatTile
          label="Approved requests"
          value={(approved ?? []).length}
          hint="Ready to turn into orders"
          href="/purchasing/requests?view=approved"
        />
      </div>

      {adding ? (
        <div className="mb-6">
          <PurchaseOrderForm
            action={createPurchaseOrder}
            vendors={vendors ?? []}
            items={items ?? []}
            expenseAccounts={expenseAccounts ?? []}
            approvedRequests={approvedRequests}
            locations={locations ?? []}
          />
        </div>
      ) : null}

      {filterLabel ? (
        <FilterNote
          label={filterLabel}
          count={shown.length}
          clearHref="/purchasing/orders"
        />
      ) : null}

      <OrderList
        rows={shown.map((order) => ({
          id: order.id,
          po_no: order.po_no,
          fromRequest: order.purchase_requests?.request_no ?? null,
          vendor: order.vendors?.name ?? "—",
          order_date: order.order_date,
          expected_date: order.expected_date,
          total: Number(order.total),
          status: order.status,
        }))}
      />
    </>
  );
}
