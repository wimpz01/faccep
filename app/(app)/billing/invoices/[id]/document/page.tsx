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
  contracts: {
    contract_no: string;
    contract_units: { unit_id: string; units: { code: string } | null }[];
  } | null;
  invoice_lines: {
    id: string;
    line_kind: string;
    description: string;
    quantity: string;
    unit_price: string;
    amount: string;
    sort_order: number;
    utility_period_id: string | null;
    utility_periods: { period_start: string; period_end: string } | null;
    tax_treatment: string;
    vat_mode: string | null;
    vat_rate: string;
    net_amount: string;
    vat_amount: string;
    line_total: string;
  }[];
};

/** How a line's tax treatment reads on the tenant's copy. */
const TREATMENT_NOTE: Record<string, string> = {
  non_vat: "Non-VAT",
  vat_exempt: "VAT exempt",
  zero_rated: "Zero-rated",
  no_tax: "No tax",
};

type ReadingRow = {
  period_id: string;
  unit_id: string;
  previous_reading: string;
  present_reading: string;
  consumption: string;
  utility_periods: { utility: string } | null;
};

/**
 * What a charge is called on the tenant's copy.
 *
 * The stored description carries the workings -- "Water — 187 x 23.3333" --
 * which belong in the billing screens, not on the bill. A tenant wants to see
 * what they are being charged for and the meter behind it. The exception is a
 * charge the contract named itself: there the description is the name.
 */
const PARTICULARS: Record<string, string> = {
  rent: "Rent",
  parking: "Parking",
  security_guard: "Security guard",
  water: "Water",
  electricity: "Electricity",
  genset: "Generator expense share",
  water_expense: "Water expense share",
  penalty: "Late payment penalty",
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
         contracts(contract_no, contract_units(unit_id, units(code))),
         invoice_lines(id, line_kind, description, quantity, unit_price, amount,
           sort_order, utility_period_id, tax_treatment, vat_mode, vat_rate,
           net_amount, vat_amount, line_total,
           utility_periods(period_start, period_end))`,
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

  /*
   * The meters behind the utility charges.
   *
   * A tenant checking their bill wants the two numbers off the meter, not the
   * arithmetic that turned them into pesos. Each unit is its own contract here,
   * so an invoice has one meter per utility -- but the reading is looked up per
   * unit rather than assumed, so a contract covering two would print both
   * rather than quietly show one of them.
   */
  const periodIds = [
    ...new Set(
      lines.map((line) => line.utility_period_id).filter(Boolean) as string[],
    ),
  ];
  const unitIds = (invoice.contracts?.contract_units ?? []).map(
    (link) => link.unit_id,
  );

  const { data: readings } =
    periodIds.length > 0 && unitIds.length > 0
      ? await supabase
          .from("meter_readings")
          .select(
            "period_id, unit_id, previous_reading, present_reading, consumption, utility_periods(utility)",
          )
          .in("period_id", periodIds)
          .in("unit_id", unitIds)
          .returns<ReadingRow[]>()
      : { data: [] as ReadingRow[] };

  const unitCode = new Map(
    (invoice.contracts?.contract_units ?? []).map((link) => [
      link.unit_id,
      link.units?.code ?? "",
    ]),
  );
  const readingsByPeriod = new Map<string, ReadingRow[]>();
  for (const row of readings ?? []) {
    const held = readingsByPeriod.get(row.period_id) ?? [];
    held.push(row);
    readingsByPeriod.set(row.period_id, held);
  }

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
            {/* Always plain "Invoice". "VAT Invoice" is a BIR designation the
                printed form should not be claiming on its own; whether VAT was
                charged is answered by the VAT line in the totals. */}
            <h1 style={{ marginBottom: 4 }}>Invoice</h1>
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
              <th style={{ textAlign: "right", width: "6rem" }}>Previous</th>
              <th style={{ textAlign: "right", width: "6rem" }}>Present</th>
              <th style={{ textAlign: "right", width: "6rem" }}>Usage</th>
              <th style={{ textAlign: "right", width: "7rem" }}>Net</th>
              <th style={{ textAlign: "right", width: "6rem" }}>VAT</th>
              <th style={{ textAlign: "right", width: "8rem" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const meters = line.utility_period_id
                ? (readingsByPeriod.get(line.utility_period_id) ?? [])
                : [];
              const metered =
                line.line_kind === "water" || line.line_kind === "electricity";
              const particulars =
                PARTICULARS[line.line_kind] ?? line.description;
              const unit = line.line_kind === "water" ? "cu.m" : "kWh";

              // One row per meter when a contract holds more than one, so
              // every figure printed is a meter the tenant can go and read.
              if (metered && meters.length > 0) {
                return meters.map((meter, index) => (
                  <tr key={`${line.id}-${meter.unit_id}`}>
                    <td>
                      {particulars}
                      {meters.length > 1 && unitCode.get(meter.unit_id)
                        ? ` — ${unitCode.get(meter.unit_id)}`
                        : ""}
                      {/* The provider's own cycle, which rarely matches the
                          calendar month the rent is for. Said here so the bill
                          does not imply these readings are the month's. */}
                      {index === 0 && line.utility_periods ? (
                        <p style={{ margin: 0, fontSize: "0.75rem" }}>
                          Metered {formatDate(line.utility_periods.period_start)}{" "}
                          to {formatDate(line.utility_periods.period_end)}
                        </p>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {Number(meter.previous_reading)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {Number(meter.present_reading)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {Number(meter.consumption)} {unit}
                    </td>
                    {/* The charge is on the line, not the meter, so it is
                        shown once against the last of them. */}
                    <td style={{ textAlign: "right" }}>
                      {index === meters.length - 1 ? money(line.net_amount) : ""}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {index === meters.length - 1
                        ? Number(line.vat_amount) > 0
                          ? money(line.vat_amount)
                          : (TREATMENT_NOTE[line.tax_treatment] ?? "—")
                        : ""}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {index === meters.length - 1 ? money(line.line_total) : ""}
                    </td>
                  </tr>
                ));
              }

              return (
                <tr key={line.id}>
                  <td>
                    {particulars}
                    {metered && line.utility_periods ? (
                      <p style={{ margin: 0, fontSize: "0.75rem" }}>
                        Metered {formatDate(line.utility_periods.period_start)}{" "}
                        to {formatDate(line.utility_periods.period_end)}
                      </p>
                    ) : null}
                  </td>
                  <td />
                  <td />
                  <td style={{ textAlign: "right" }}>
                    {metered ? `${Number(line.quantity)} ${unit}` : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>{money(line.net_amount)}</td>
                  <td style={{ textAlign: "right" }}>
                    {Number(line.vat_amount) > 0
                      ? money(line.vat_amount)
                      : (TREATMENT_NOTE[line.tax_treatment] ?? "—")}
                  </td>
                  <td style={{ textAlign: "right" }}>{money(line.line_total)}</td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={6} style={{ textAlign: "right", fontWeight: 700 }}>
                Subtotal
              </td>
              <td style={{ textAlign: "right" }}>{money(invoice.subtotal)}</td>
            </tr>
            {invoice.is_vatable ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "right", fontWeight: 700 }}>
                  VAT ({Number(invoice.vat_rate)}%)
                </td>
                <td style={{ textAlign: "right" }}>{money(invoice.vat_amount)}</td>
              </tr>
            ) : null}
            <tr>
              <td colSpan={6} style={{ textAlign: "right", fontWeight: 700 }}>
                Total due
              </td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>
                {money(invoice.total)}
              </td>
            </tr>
            {Number(invoice.amount_paid) > 0 || Number(invoice.credited_amount) > 0 ? (
              <>
                <tr>
                  <td colSpan={6} style={{ textAlign: "right" }}>
                    Less payments and credits
                  </td>
                  <td style={{ textAlign: "right" }}>
                    ({money(Number(invoice.amount_paid) + Number(invoice.credited_amount))})
                  </td>
                </tr>
                <tr>
                  <td colSpan={6} style={{ textAlign: "right", fontWeight: 700 }}>
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
