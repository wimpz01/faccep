import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { PrintButton } from "@/components/print-button";

export const metadata: Metadata = { title: "Purchase order" };

type OrderDocument = {
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
    vendor_no: string;
    tin: string | null;
    address: string | null;
    contact_person: string | null;
    contact_number: string | null;
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
  }[];
};

export default async function PurchaseOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.purchasingOrders, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();

  const [{ data: order, error: orderError }, { data: company }] =
    await Promise.all([
      supabase
        .from("purchase_orders")
        .select(
          `id, company_id, po_no, status, order_date, expected_date, total, notes,
           vendors(name, vendor_no, tin, address, contact_person, contact_number,
                   payment_terms(name, days)),
           purchase_requests(request_no), locations(code, name),
           purchase_order_lines(id, description, quantity, unit_price, amount)`,
        )
        .eq("id", id)
        .maybeSingle<OrderDocument>(),
      supabase
        .from("companies")
        .select("name, legal_name, address, tin, contact_number, email")
        .eq("id", companyId)
        .single(),
    ]);

  if (orderError) throw new Error(`Purchase order ${id}: ${orderError.message}`);
  if (!order || order.company_id !== companyId) notFound();

  const lines = order.purchase_order_lines ?? [];

  return (
    <>
      <div className="no-print flex items-center justify-between gap-3 flex-wrap mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{order.po_no}</h1>
          <p className="text-sm muted mt-0.5">
            {order.vendors?.name ?? "Supplier"} · {order.status.replace("_", " ")}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/purchasing/orders/${order.id}`}
            className="btn btn-secondary btn-sm"
          >
            Back to order
          </Link>
          <PrintButton />
        </div>
      </div>

      <div className="doc-sheet">
        <p style={{ textAlign: "center", marginBottom: "0.25rem" }}>
          <strong>{company?.legal_name ?? company?.name}</strong>
          {company?.address ? (
            <>
              <br />
              {company.address}
            </>
          ) : null}
          {company?.tin ? (
            <>
              <br />
              TIN {company.tin}
            </>
          ) : null}
          {company?.contact_number || company?.email ? (
            <>
              <br />
              {[company.contact_number, company.email].filter(Boolean).join(" · ")}
            </>
          ) : null}
        </p>

        <h1>Purchase Order</h1>

        <table>
          <tbody>
            <tr>
              <th style={{ width: "22%" }}>P.O. no.</th>
              <td style={{ width: "28%" }}>{order.po_no}</td>
              <th style={{ width: "22%" }}>Date</th>
              <td>{formatDate(order.order_date)}</td>
            </tr>
            <tr>
              <th>Supplier</th>
              <td>{order.vendors?.name ?? "—"}</td>
              <th>Supplier code</th>
              <td>{order.vendors?.vendor_no ?? "—"}</td>
            </tr>
            <tr>
              <th>Address</th>
              <td>{order.vendors?.address ?? "—"}</td>
              <th>TIN</th>
              <td>{order.vendors?.tin ?? "—"}</td>
            </tr>
            <tr>
              <th>Contact</th>
              <td>
                {[order.vendors?.contact_person, order.vendors?.contact_number]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </td>
              <th>Terms</th>
              <td>{order.vendors?.payment_terms?.name ?? "—"}</td>
            </tr>
            <tr>
              <th>Deliver to</th>
              <td>
                {order.locations
                  ? `${order.locations.code} — ${order.locations.name}`
                  : "Company-wide"}
              </td>
              <th>Required by</th>
              <td>
                {order.expected_date ? formatDate(order.expected_date) : "—"}
              </td>
            </tr>
            <tr>
              <th>Against request</th>
              <td colSpan={3}>
                {order.purchase_requests?.request_no ?? "Direct order"}
              </td>
            </tr>
          </tbody>
        </table>

        <h2>Please supply the following</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: "6%" }}>#</th>
              <th>Description</th>
              <th style={{ textAlign: "right", width: "12%" }}>Qty</th>
              <th style={{ textAlign: "right", width: "16%" }}>Unit price</th>
              <th style={{ textAlign: "right", width: "18%" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.id}>
                <td>{index + 1}</td>
                <td>{line.description}</td>
                <td style={{ textAlign: "right" }}>{Number(line.quantity)}</td>
                <td style={{ textAlign: "right" }}>
                  {Number(line.unit_price).toFixed(2)}
                </td>
                <td style={{ textAlign: "right" }}>{money(line.amount)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} style={{ fontWeight: 700, textAlign: "right" }}>
                Total
              </td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>
                {money(order.total)}
              </td>
            </tr>
          </tbody>
        </table>

        {order.notes ? (
          <>
            <h2>Notes</h2>
            <p>{order.notes}</p>
          </>
        ) : null}

        <p style={{ fontSize: "0.8rem" }}>
          Deliveries must quote this purchase order number. Goods are subject to
          inspection on receipt, and invoices are settled against the quantities
          actually received.
        </p>

        <div style={{ marginTop: "2.5rem", display: "flex", gap: "2rem" }}>
          <div style={{ flex: 1 }}>
            <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
              Prepared by
            </p>
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
              Approved by
            </p>
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
              Acknowledged by (Supplier)
            </p>
          </div>
        </div>

        {order.status === "draft" ? (
          <p
            style={{
              marginTop: "1.5rem",
              fontSize: "0.75rem",
              textAlign: "center",
            }}
          >
            Draft — this order has not been issued to the supplier.
          </p>
        ) : null}
      </div>
    </>
  );
}
