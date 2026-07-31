import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PrintButton } from "@/components/print-button";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Invoice document" };

type InvoiceDoc = {
  id: string;
  company_id: string;
  invoice_no: string;
  status: string;
  invoice_date: string;
  due_date: string;
  period_start: string | null;
  period_end: string | null;
  is_vatable: boolean;
  vat_rate: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  amount_paid: string;
  credited_amount: string;
  tenants: {
    company_name: string;
    address: string | null;
    tin: string | null;
    contact_person: string | null;
  } | null;
  contracts: { contract_no: string } | null;
  invoice_lines: {
    id: string;
    description: string;
    quantity: string;
    unit_price: string;
    amount: string;
    sort_order: number;
  }[];
};

export default async function InvoiceDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.billingInvoices, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const [{ data: invoice }, { data: company }] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        `*, tenants(company_name, address, tin, contact_person),
         contracts(contract_no),
         invoice_lines(id, description, quantity, unit_price, amount, sort_order)`,
      )
      .eq("id", id)
      .maybeSingle<InvoiceDoc>(),
    supabase
      .from("companies")
      .select("name, legal_name, address, tin, contact_number, email")
      .eq("id", companyId)
      .single(),
  ]);

  if (!invoice || invoice.company_id !== companyId) notFound();

  const lines = [...(invoice.invoice_lines ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  );
  const balance =
    Number(invoice.total) -
    Number(invoice.amount_paid) -
    Number(invoice.credited_amount);

  return (
    <>
      <div className="no-print mb-4 flex gap-2 flex-wrap items-center">
        <Link href={`/billing/invoices/${invoice.id}`} className="btn btn-secondary btn-sm">
          Back to invoice
        </Link>
        <PrintButton />
        <p className="text-xs muted">
          A printed rendering of the posted transaction — not an editable
          document.
        </p>
      </div>

      {invoice.status === "draft" ? (
        <div className="no-print card mb-4">
          <div className="card-body">
            <p className="text-sm">
              This is still a <strong>draft</strong> and has not been released.
            </p>
          </div>
        </div>
      ) : null}

      <article className="doc-sheet card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
          <div>
            <p style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 2 }}>
              {company?.legal_name ?? company?.name}
            </p>
            <p style={{ margin: 0, fontSize: "0.8rem" }}>{company?.address ?? ""}</p>
            {company?.tin ? (
              <p style={{ margin: 0, fontSize: "0.8rem" }}>TIN {company.tin}</p>
            ) : null}
            {company?.contact_number ? (
              <p style={{ margin: 0, fontSize: "0.8rem" }}>{company.contact_number}</p>
            ) : null}
          </div>
          <div style={{ textAlign: "right" }}>
            <h1 style={{ marginBottom: 4 }}>
              {invoice.is_vatable ? "VAT Invoice" : "Invoice"}
            </h1>
            <p style={{ margin: 0, fontWeight: 700 }}>{invoice.invoice_no}</p>
            <p style={{ margin: 0, fontSize: "0.8rem" }}>
              Date {formatDate(invoice.invoice_date)}
            </p>
            <p style={{ margin: 0, fontSize: "0.8rem" }}>
              Due {formatDate(invoice.due_date)}
            </p>
            {invoice.status === "cancelled" ? (
              <p style={{ margin: 0, fontWeight: 700, color: "#b91c1c" }}>CANCELLED</p>
            ) : null}
          </div>
        </div>

        <h2>Billed to</h2>
        <p style={{ marginBottom: "0.3rem" }}>
          <strong>{invoice.tenants?.company_name}</strong>
          {invoice.tenants?.contact_person
            ? ` — attn. ${invoice.tenants.contact_person}`
            : ""}
        </p>
        <p style={{ marginTop: 0, fontSize: "0.85rem" }}>
          {invoice.tenants?.address ?? ""}
          {invoice.tenants?.tin ? ` · TIN ${invoice.tenants.tin}` : ""}
        </p>
        {invoice.period_start ? (
          <p style={{ fontSize: "0.85rem" }}>
            Billing period {formatDate(invoice.period_start)} to{" "}
            {formatDate(invoice.period_end)}
            {invoice.contracts?.contract_no
              ? ` · Contract ${invoice.contracts.contract_no}`
              : ""}
          </p>
        ) : null}

        <table>
          <thead>
            <tr>
              <th>Particulars</th>
              <th style={{ textAlign: "right", width: "6rem" }}>Qty</th>
              <th style={{ textAlign: "right", width: "7rem" }}>Rate</th>
              <th style={{ textAlign: "right", width: "8rem" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td style={{ textAlign: "right" }}>{Number(line.quantity)}</td>
                <td style={{ textAlign: "right" }}>
                  {Number(line.unit_price).toFixed(4)}
                </td>
                <td style={{ textAlign: "right" }}>{money(line.amount)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} style={{ textAlign: "right", fontWeight: 700 }}>
                Subtotal
              </td>
              <td style={{ textAlign: "right" }}>{money(invoice.subtotal)}</td>
            </tr>
            {invoice.is_vatable ? (
              <tr>
                <td colSpan={3} style={{ textAlign: "right", fontWeight: 700 }}>
                  VAT ({Number(invoice.vat_rate)}%)
                </td>
                <td style={{ textAlign: "right" }}>{money(invoice.vat_amount)}</td>
              </tr>
            ) : null}
            <tr>
              <td colSpan={3} style={{ textAlign: "right", fontWeight: 700 }}>
                Total due
              </td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>
                {money(invoice.total)}
              </td>
            </tr>
            {Number(invoice.amount_paid) > 0 || Number(invoice.credited_amount) > 0 ? (
              <>
                <tr>
                  <td colSpan={3} style={{ textAlign: "right" }}>
                    Less payments and credits
                  </td>
                  <td style={{ textAlign: "right" }}>
                    ({money(Number(invoice.amount_paid) + Number(invoice.credited_amount))})
                  </td>
                </tr>
                <tr>
                  <td colSpan={3} style={{ textAlign: "right", fontWeight: 700 }}>
                    Balance
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>
                    {money(balance)}
                  </td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>

        <p style={{ fontSize: "0.8rem" }}>
          Payment is due by {formatDate(invoice.due_date)}. Water and electricity
          charges unpaid more than one week after receipt of this billing attract
          a late payment penalty.
        </p>

        <div style={{ marginTop: "2rem", fontSize: "0.8rem" }}>
          <p style={{ marginBottom: "2.5rem" }}>Prepared by:</p>
          <p>______________________________</p>
        </div>
      </article>
    </>
  );
}
