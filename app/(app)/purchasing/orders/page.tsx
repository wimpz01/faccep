import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createPurchaseOrder } from "../actions";
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

const STATUS_BADGE: Record<string, string> = {
  draft: "badge",
  issued: "badge badge-brand",
  partially_received: "badge badge-brand",
  received: "badge",
  closed: "badge",
  cancelled: "badge",
};

export default async function PurchaseOrdersPage() {
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
        .select("id, request_no, locations(code, name)")
        .eq("company_id", companyId)
        .eq("status", "approved")
        .order("request_no")
        .returns<
          {
            id: string;
            request_no: string;
            locations: { code: string; name: string } | null;
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
  }));

  const rows = orders ?? [];
  const outstanding = rows.filter((row) =>
    ["issued", "partially_received"].includes(row.status),
  );

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
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile label="Awaiting delivery" value={outstanding.length} hint="Issued or part received" />
        <StatTile
          label="Committed"
          value={money(outstanding.reduce((sum, row) => sum + Number(row.total), 0))}
          hint="Value still on order"
          tone="money"
        />
        <StatTile
          label="Approved requests"
          value={(approved ?? []).length}
          hint="Ready to turn into orders"
        />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Create an order"
            description="An order raised against a request is refused unless that request is approved."
          >
            <PurchaseOrderForm
              action={createPurchaseOrder}
              vendors={vendors ?? []}
              items={items ?? []}
              expenseAccounts={expenseAccounts ?? []}
              approvedRequests={approvedRequests}
              locations={locations ?? []}
            />
          </Card>
        </div>
      ) : null}

      <Card title="Orders" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Ordered</th>
                  <th>Expected</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link
                        href={`/purchasing/orders/${order.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {order.po_no}
                      </Link>
                      {order.purchase_requests?.request_no ? (
                        <p className="text-xs muted">
                          from {order.purchase_requests.request_no}
                        </p>
                      ) : null}
                    </td>
                    <td className="text-sm">{order.vendors?.name ?? "—"}</td>
                    <td className="text-xs">{formatDate(order.order_date)}</td>
                    <td className="text-xs">{formatDate(order.expected_date)}</td>
                    <td className="text-right tabular-nums">{money(order.total)}</td>
                    <td>
                      <span className={STATUS_BADGE[order.status] ?? "badge"}>
                        {order.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No purchase orders yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
