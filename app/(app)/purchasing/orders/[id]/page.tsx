import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createBillFromOrder } from "@/app/(app)/payables/actions";
import { BillFromOrderForm } from "@/app/(app)/payables/payables-forms";
import { round2 } from "@/lib/billing";

import {
  cancelPurchaseOrder,
  issuePurchaseOrder,
  receiveGoods,
  unissuePurchaseOrder,
} from "../../actions";
import {
  CancelOrderForm,
  ReceiveForm,
  UnissueOrderForm,
} from "../../purchasing-forms";

export const metadata: Metadata = { title: "Purchase order" };

type OrderDetail = {
  id: string;
  company_id: string;
  po_no: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  total: string;
  notes: string | null;
  vendors: {
    name: string;
    payment_terms: { name: string; days: number } | null;
  } | null;
  purchase_requests: { request_no: string } | null;
  locations: { code: string; name: string } | null;
  purchase_order_lines: {
    id: string;
    description: string;
    quantity: string;
    unit_price: string;
    amount: string;
    quantity_received: string;
  }[];
  goods_receipts: {
    id: string;
    receipt_no: string;
    received_date: string;
    notes: string | null;
  }[];
};

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.purchasingOrders, "view");
  const companyId = context.activeCompany!.companyId;
  const canIssue = can(context.permissions, MODULE.purchasingOrders, "approve");
  const canReceive = can(context.permissions, MODULE.purchasingReceiving, "edit");
  const canBill = can(context.permissions, MODULE.payablesInvoices, "edit");
  const canEditOrder = can(context.permissions, MODULE.purchasingOrders, "edit");

  const supabase = await createClient();
  const { data: order, error: orderError } = await supabase
    .from("purchase_orders")
    .select(
      `*, vendors(name, payment_terms(name, days)), purchase_requests(request_no), locations(code, name),
       purchase_order_lines(id, description, quantity, unit_price, amount, quantity_received),
       goods_receipts(id, receipt_no, received_date, notes)`,
    )
    .eq("id", id)
    .maybeSingle<OrderDetail>();

  // A failed query is not a missing order. Letting it fall through to
  // notFound() turns a broken read into a 404 and hides why.
  if (orderError) throw new Error(`Purchase order ${id}: ${orderError.message}`);
  if (!order || order.company_id !== companyId) notFound();

  const lines = order.purchase_order_lines ?? [];
  const hasReceipts = (order.goods_receipts ?? []).length > 0;
  const fullyReceived = lines.every(
    (line) => Number(line.quantity_received) >= Number(line.quantity),
  );

  // Three-way match: what was received, what has been billed, what is left.
  const { data: bills } = await supabase
    .from("supplier_invoices")
    .select("id, invoice_no, invoice_date, amount, total, status")
    .eq("po_id", order.id)
    .neq("status", "cancelled")
    .order("invoice_date")
    .returns<
      {
        id: string;
        invoice_no: string;
        invoice_date: string;
        amount: string;
        total: string;
        status: string;
      }[]
    >();

  const receivedValue = round2(
    lines.reduce(
      (sum, line) => sum + Number(line.quantity_received) * Number(line.unit_price),
      0,
    ),
  );
  const billedValue = round2(
    (bills ?? []).reduce((sum, bill) => sum + Number(bill.amount), 0),
  );
  const billable = round2(receivedValue - billedValue);

  return (
    <>
      <PageHeader
        title={order.po_no}
        description={`${order.vendors?.name ?? "Supplier"} · ordered ${formatDate(
          order.order_date,
        )} · ${
          order.locations
            ? `${order.locations.code} — ${order.locations.name}`
            : "Company-wide"
        }`}
        action={
          <div className="flex gap-2">
            <Link href="/purchasing/orders" className="btn btn-secondary btn-sm">
              Back
            </Link>
            <Link
              href={`/purchasing/orders/${order.id}/print`}
              className="btn btn-primary btn-sm"
            >
              Print
            </Link>
          </div>
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
                {order.status.replace("_", " ")}
              </span>
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Order total
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(order.total)}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Expected
            </p>
            <p className="text-sm font-medium mt-1">
              {formatDate(order.expected_date)}
            </p>
            {order.vendors?.payment_terms ? (
              <p className="text-xs muted">
                Terms: {order.vendors.payment_terms.name}
              </p>
            ) : null}
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              From request
            </p>
            <p className="text-sm font-medium mt-1">
              {order.purchase_requests?.request_no ?? "Direct order"}
            </p>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Card title="Lines" bodyClassName="">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Unit price</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Received</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td className="text-sm">{line.description}</td>
                    <td className="text-right tabular-nums">{Number(line.quantity)}</td>
                    <td className="text-right tabular-nums">
                      {Number(line.unit_price).toFixed(4)}
                    </td>
                    <td className="text-right tabular-nums">{money(line.amount)}</td>
                    <td className="text-right tabular-nums">
                      {Number(line.quantity_received)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="text-right font-bold">
                    Total
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(order.total)}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {order.status === "draft" && (canIssue || canEditOrder) ? (
        <div className="mb-6">
          <Card
            title="Issue to the supplier"
            description="Receiving is only possible once the order has been issued. Until it goes out, the order can still be cancelled."
          >
            <div className="flex items-start gap-3 flex-wrap">
              {canIssue ? (
                <form action={issuePurchaseOrder}>
                  <input type="hidden" name="id" value={order.id} />
                  <button type="submit" className="btn btn-primary">
                    Issue order
                  </button>
                </form>
              ) : null}
              {canEditOrder ? (
                <CancelOrderForm
                  action={cancelPurchaseOrder}
                  poId={order.id}
                />
              ) : null}
            </div>
          </Card>
        </div>
      ) : null}

      {order.status === "issued" && !hasReceipts && canIssue ? (
        <div className="mb-6">
          <Card
            title="Issued to the supplier"
            description="Nothing has arrived yet, so the issue can still be taken back. The order returns to draft, where it can be corrected or cancelled."
          >
            <UnissueOrderForm
              action={unissuePurchaseOrder}
              poId={order.id}
            />
          </Card>
        </div>
      ) : null}

      {order.status === "cancelled" ? (
        <div className="mb-6">
          <Card title="Cancelled">
            <p className="text-sm muted">
              Nothing more can be bought on {order.po_no}. It stays on file for
              the record.
            </p>
          </Card>
        </div>
      ) : null}

      {canReceive && order.status !== "draft" && !fullyReceived ? (
        <div className="mb-6">
          <Card
            title="Receive goods"
            description="Quantities go straight into stock for any line tied to an inventory item."
          >
            <ReceiveForm
              action={receiveGoods}
              poId={order.id}
              lines={lines.map((line) => ({
                id: line.id,
                description: line.description,
                ordered: Number(line.quantity),
                received: Number(line.quantity_received),
              }))}
            />
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card
          title="Billing"
          description="A bill raised here is matched against what was actually received, and posts straight to payables."
          bodyClassName=""
        >
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Ordered</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Already billed</th>
                  <th className="text-right">Still billable</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="tabular-nums">{money(order.total)}</td>
                  <td className="text-right tabular-nums">{money(receivedValue)}</td>
                  <td className="text-right tabular-nums">{money(billedValue)}</td>
                  <td
                    className="text-right tabular-nums font-semibold"
                    style={billable > 0 ? { color: "var(--color-gold-500)" } : undefined}
                  >
                    {money(billable)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {bills && bills.length > 0 ? (
            <div className="table-scroll" style={{ borderTop: "1px solid var(--border)" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th className="text-right">Net</th>
                    <th className="text-right">Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => (
                    <tr key={bill.id}>
                      <td className="text-sm">{bill.invoice_no}</td>
                      <td className="text-xs">{formatDate(bill.invoice_date)}</td>
                      <td className="text-right tabular-nums">{money(bill.amount)}</td>
                      <td className="text-right tabular-nums">{money(bill.total)}</td>
                      <td>
                        <span className="badge">{bill.status.replace("_", " ")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
            {canBill && billable > 0 ? (
              <BillFromOrderForm
                action={createBillFromOrder}
                poId={order.id}
                poNo={order.po_no}
                vendorName={order.vendors?.name ?? "the supplier"}
                billable={billable}
              />
            ) : receivedValue === 0 ? (
              <p className="text-sm muted">
                Nothing received yet — receive the goods before billing them.
              </p>
            ) : billable <= 0 ? (
              <p className="text-sm muted">
                Everything received on this order has been billed.
              </p>
            ) : (
              <p className="text-sm muted">
                Recording a bill needs edit rights on supplier invoices.
              </p>
            )}
          </div>
        </Card>
      </div>

      <Card title="Receipts" bodyClassName="">
        {(order.goods_receipts ?? []).length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Date</th>
                  <th>Notes</th>
                  <th className="text-right">Bill it</th>
                </tr>
              </thead>
              <tbody>
                {order.goods_receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td className="text-sm font-medium">{receipt.receipt_no}</td>
                    <td className="text-xs">{formatDate(receipt.received_date)}</td>
                    <td className="text-xs">{receipt.notes ?? "—"}</td>
                    <td className="text-right">
                      {canBill ? (
                        <Link
                          href={`/payables?receipt=${receipt.id}`}
                          className="btn btn-secondary btn-sm"
                        >
                          Create supplier invoice
                        </Link>
                      ) : (
                        <span className="text-xs muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>Nothing received against this order yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
