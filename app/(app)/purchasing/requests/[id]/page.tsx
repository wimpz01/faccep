import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Purchase request" };

type RequestDetail = {
  id: string;
  company_id: string;
  request_no: string;
  status: string;
  needed_by: string | null;
  justification: string | null;
  created_at: string;
  profiles: { full_name: string; user_code: string } | null;
  locations: { code: string; name: string } | null;
  maintenance_jobs: { id: string; job_no: string; job_kind: string } | null;
  purchase_request_lines: {
    id: string;
    description: string;
    quantity: string;
    estimated_price: string;
    inventory_items: { id: string; sku: string; unit_of_measure: string } | null;
  }[];
};

type OrderFromRequest = {
  id: string;
  po_no: string;
  status: string;
  order_date: string;
  total: string;
  vendors: { name: string } | null;
};

/**
 * One purchase request, and what became of it.
 *
 * The list can only ever show a request in one line, which is enough to find
 * it and not enough to judge it. Approving a request means reading what was
 * actually asked for, why, and by when -- and afterwards, seeing whether it
 * turned into an order at all. That chain is the paper trail the module
 * exists for, so it ends here rather than in somebody's memory.
 */
export default async function PurchaseRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.purchasingRequests, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const [{ data: request }, { data: orders }] = await Promise.all([
    supabase
      .from("purchase_requests")
      .select(
        `id, company_id, request_no, status, needed_by, justification, created_at,
         profiles(full_name, user_code),
         locations(code, name),
         maintenance_jobs(id, job_no, job_kind),
         purchase_request_lines(id, description, quantity, estimated_price,
           inventory_items(id, sku, unit_of_measure))`,
      )
      .eq("id", id)
      .maybeSingle<RequestDetail>(),
    supabase
      .from("purchase_orders")
      .select("id, po_no, status, order_date, total, vendors(name)")
      .eq("request_id", id)
      .order("order_date", { ascending: false })
      .returns<OrderFromRequest[]>(),
  ]);

  if (!request || request.company_id !== companyId) notFound();

  const lines = request.purchase_request_lines ?? [];
  const estimate = round2(
    lines.reduce(
      (sum, line) => sum + Number(line.quantity) * Number(line.estimated_price),
      0,
    ),
  );
  // A cancelled order still belongs on the trail -- it is part of what
  // happened -- but it commits nothing, so it is listed and not counted.
  const liveOrders = (orders ?? []).filter(
    (order) => order.status !== "cancelled",
  );
  const ordered = round2(
    liveOrders.reduce((sum, order) => sum + Number(order.total), 0),
  );

  return (
    <>
      <PageHeader
        title={request.request_no}
        description={`Raised ${formatDate(request.created_at)}${
          request.profiles ? ` by ${request.profiles.full_name}` : ""
        } · ${
          request.locations
            ? `${request.locations.code} — ${request.locations.name}`
            : "Company-wide"
        }`}
        action={
          <Link href="/purchasing/requests" className="btn btn-secondary btn-sm">
            Back to requests
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span className="badge badge-brand">
                {request.status.replace("_", " ")}
              </span>
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Estimated value
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(estimate)}
            </p>
            <p className="text-xs muted">
              {lines.length} line{lines.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Needed by
            </p>
            <p className="text-sm font-medium mt-1">
              {request.needed_by ? formatDate(request.needed_by) : "—"}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Raised for
            </p>
            {request.maintenance_jobs ? (
              <p className="text-sm font-medium mt-1">
                <Link
                  href={`/maintenance/jobs/${request.maintenance_jobs.id}`}
                  style={{ color: "var(--color-brand-600)" }}
                >
                  {request.maintenance_jobs.job_no}
                </Link>
                <span className="block text-xs muted">
                  {request.maintenance_jobs.job_kind.replace("_", " ")}
                </span>
              </p>
            ) : (
              <p className="text-sm font-medium mt-1">Stock or general use</p>
            )}
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Card title="What was asked for" bodyClassName="">
          {lines.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Estimated price</th>
                    <th className="text-right">Estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <p className="text-sm">{line.description}</p>
                        {line.inventory_items ? (
                          <Link
                            href={`/inventory/${line.inventory_items.id}`}
                            className="text-xs"
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {line.inventory_items.sku}
                          </Link>
                        ) : (
                          <p className="text-xs muted">Not a stock item</p>
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {Number(line.quantity)}
                        {line.inventory_items ? (
                          <span className="text-xs muted">
                            {" "}
                            {line.inventory_items.unit_of_measure}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(line.estimated_price)}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(
                          round2(
                            Number(line.quantity) * Number(line.estimated_price),
                          ),
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} className="text-right font-bold">
                      Total
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(estimate)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>Nothing was listed on this request.</EmptyState>
          )}
        </Card>
      </div>

      {request.justification ? (
        <div className="mb-6">
          <Card title="Why it was asked for">
            <p className="text-sm">{request.justification}</p>
          </Card>
        </div>
      ) : null}

      <Card
        title="Ordered against this request"
        description={
          (orders ?? []).length === 0
            ? "An approved request is turned into an order from the purchase orders screen."
            : liveOrders.length > 0
              ? `${money(ordered)} committed on ${liveOrders.length} order${
                  liveOrders.length === 1 ? "" : "s"
                }. Cancelled orders are listed but not counted.`
              : "Nothing is committed — every order raised on this request was cancelled."
        }
        bodyClassName=""
      >
        {(orders ?? []).length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Ordered</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(orders ?? []).map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link
                        href={`/purchasing/orders/${order.id}`}
                        className="font-semibold text-sm tabular-nums"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {order.po_no}
                      </Link>
                    </td>
                    <td className="text-sm">{order.vendors?.name ?? "—"}</td>
                    <td className="text-xs">{formatDate(order.order_date)}</td>
                    <td className="text-right tabular-nums">
                      {money(order.total)}
                    </td>
                    <td>
                      <span className="badge">
                        {order.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>Nothing has been ordered on this request yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
