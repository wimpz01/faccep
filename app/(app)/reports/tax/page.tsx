import type { Metadata } from "next";

import { ReportShell } from "@/components/report-shell";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Tax reports" };

type BillRow = {
  id: string;
  invoice_no: string;
  invoice_date: string;
  amount: string;
  vat_amount: string;
  withholding_tax: string;
  total: string;
  vendors: { id: string; name: string; tin: string | null; address: string | null } | null;
};

type SaleRow = {
  id: string;
  invoice_no: string;
  invoice_date: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  is_vatable: boolean;
  tenants: { company_name: string; tin: string | null; address: string | null } | null;
};

/** Calendar quarter containing a date, as BIR forms are filed quarterly. */
function quarterRange(quarter: string) {
  const [yearPart, quarterPart] = quarter.split("-Q");
  const year = Number(yearPart);
  const q = Number(quarterPart);
  const startMonth = (q - 1) * 3;
  const from = new Date(year, startMonth, 1);
  const to = new Date(year, startMonth + 3, 0);
  const iso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { from: iso(from), to: iso(to), year, q };
}

function currentQuarter() {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

export default async function TaxReports({
  searchParams,
}: {
  searchParams: Promise<{ quarter?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsTax, "view");
  const companyId = context.activeCompany!.companyId;

  const quarter = filters.quarter ?? currentQuarter();
  const { from, to, year, q } = quarterRange(quarter);

  const supabase = await createClient();
  const [{ data: bills }, { data: sales }, { data: company }] = await Promise.all([
    supabase
      .from("supplier_invoices")
      .select(
        "id, invoice_no, invoice_date, amount, vat_amount, withholding_tax, total, vendors(id, name, tin, address)",
      )
      .eq("company_id", companyId)
      .neq("status", "cancelled")
      .gte("invoice_date", from)
      .lte("invoice_date", to)
      .order("invoice_date")
      .returns<BillRow[]>(),
    supabase
      .from("invoices")
      .select(
        "id, invoice_no, invoice_date, subtotal, vat_amount, total, is_vatable, tenants(company_name, tin, address)",
      )
      .eq("company_id", companyId)
      .not("status", "in", "(draft,cancelled)")
      .gte("invoice_date", from)
      .lte("invoice_date", to)
      .order("invoice_date")
      .returns<SaleRow[]>(),
    supabase
      .from("companies")
      .select("name, legal_name, tin, address")
      .eq("id", companyId)
      .single(),
  ]);

  const billRows = (bills ?? []).filter((bill) => Number(bill.withholding_tax) > 0);

  // 2307 is issued per supplier, so the quarter is summarised per payee.
  const byVendor = new Map<
    string,
    { name: string; tin: string | null; address: string | null; base: number; tax: number }
  >();
  for (const bill of billRows) {
    const key = bill.vendors?.id ?? "unknown";
    const entry =
      byVendor.get(key) ??
      {
        name: bill.vendors?.name ?? "Unknown supplier",
        tin: bill.vendors?.tin ?? null,
        address: bill.vendors?.address ?? null,
        base: 0,
        tax: 0,
      };
    entry.base = round2(entry.base + Number(bill.amount));
    entry.tax = round2(entry.tax + Number(bill.withholding_tax));
    byVendor.set(key, entry);
  }

  const vendors = [...byVendor.values()].sort((a, b) => b.tax - a.tax);
  const totalWithheld = round2(vendors.reduce((sum, row) => sum + row.tax, 0));
  const totalBase = round2(vendors.reduce((sum, row) => sum + row.base, 0));

  const vatableSales = (sales ?? []).filter((sale) => sale.is_vatable);
  const exemptSales = (sales ?? []).filter((sale) => !sale.is_vatable);
  const outputVat = round2(
    vatableSales.reduce((sum, sale) => sum + Number(sale.vat_amount), 0),
  );
  const vatableBase = round2(
    vatableSales.reduce((sum, sale) => sum + Number(sale.subtotal), 0),
  );
  const inputVat = round2(
    (bills ?? []).reduce((sum, bill) => sum + Number(bill.vat_amount), 0),
  );

  const quarters = [1, 2, 3, 4].flatMap((quarterNumber) =>
    [year, year - 1].map((yearValue) => `${yearValue}-Q${quarterNumber}`),
  );

  return (
    <ReportShell
      title="Tax reports"
      description={`${company?.legal_name ?? company?.name ?? ""}${company?.tin ? ` · TIN ${company.tin}` : ""} — Q${q} ${year} (${formatDate(from)} to ${formatDate(to)})`}
      showRange={false}
    >
      <div className="no-print card mb-5">
        <div className="card-body">
          <form method="get" className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="label" htmlFor="quarter">
                Quarter
              </label>
              <select
                id="quarter"
                name="quarter"
                className="select"
                defaultValue={quarter}
              >
                {[...new Set(quarters)]
                  .sort()
                  .reverse()
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
              </select>
            </div>
            <button type="submit" className="btn btn-primary">
              Apply
            </button>
          </form>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4 mb-5">
        <StatTile
          label="Tax withheld"
          value={money(totalWithheld)}
          hint="Creditable, this quarter"
          tone="money"
        />
        <StatTile label="Output VAT" value={money(outputVat)} hint="On VATable sales" />
        <StatTile label="Input VAT" value={money(inputVat)} hint="On supplier invoices" />
        <StatTile
          label="Net VAT payable"
          value={money(round2(outputVat - inputVat))}
          hint="Output less input"
        />
      </div>

      <div className="mb-5">
        <Card
          title="BIR Form 2307 — creditable tax withheld at source"
          description="One certificate is issued per supplier per quarter. These are the figures each certificate carries."
          bodyClassName=""
        >
          {vendors.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Payee</th>
                    <th>TIN</th>
                    <th>Address</th>
                    <th className="text-right">Income payment</th>
                    <th className="text-right">Tax withheld</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((vendor) => (
                    <tr key={vendor.name}>
                      <td className="text-sm">{vendor.name}</td>
                      <td className="text-xs">
                        {vendor.tin ?? (
                          <span style={{ color: "var(--danger)" }}>missing</span>
                        )}
                      </td>
                      <td className="text-xs">{vendor.address ?? "—"}</td>
                      <td className="text-right tabular-nums">{money(vendor.base)}</td>
                      <td className="text-right tabular-nums">{money(vendor.tax)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} className="text-right font-bold">
                      Total
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(totalBase)}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(totalWithheld)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No tax was withheld in this quarter.</EmptyState>
          )}
        </Card>
      </div>

      <div className="mb-5">
        <Card
          title="BIR Form 1601-EQ — quarterly remittance summary"
          description="Total creditable income tax withheld for the quarter, which is what gets remitted."
          bodyClassName=""
        >
          <div className="table-scroll">
            <table className="table">
              <tbody>
                <tr>
                  <td className="text-sm">Quarter covered</td>
                  <td className="text-right">
                    Q{q} {year} ({formatDate(from)} – {formatDate(to)})
                  </td>
                </tr>
                <tr>
                  <td className="text-sm">Number of payees</td>
                  <td className="text-right tabular-nums">{vendors.length}</td>
                </tr>
                <tr>
                  <td className="text-sm">Total income payments subject to withholding</td>
                  <td className="text-right tabular-nums">{money(totalBase)}</td>
                </tr>
                <tr>
                  <td className="font-bold">Total tax withheld and remittable</td>
                  <td className="text-right tabular-nums font-bold">
                    {money(totalWithheld)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card
        title="VAT relief — schedule of sales"
        description="VATable and exempt sales for the quarter, per customer."
        bodyClassName=""
      >
        {(sales ?? []).length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>TIN</th>
                  <th className="text-right">VATable sales</th>
                  <th className="text-right">Exempt sales</th>
                  <th className="text-right">Output VAT</th>
                </tr>
              </thead>
              <tbody>
                {(sales ?? []).map((sale) => (
                  <tr key={sale.id}>
                    <td className="text-xs">{formatDate(sale.invoice_date)}</td>
                    <td className="text-sm">{sale.invoice_no}</td>
                    <td className="text-sm">{sale.tenants?.company_name}</td>
                    <td className="text-xs">{sale.tenants?.tin ?? "—"}</td>
                    <td className="text-right tabular-nums">
                      {sale.is_vatable ? money(sale.subtotal) : "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {sale.is_vatable ? "—" : money(sale.subtotal)}
                    </td>
                    <td className="text-right tabular-nums">
                      {sale.is_vatable ? money(sale.vat_amount) : "—"}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="text-right font-bold">
                    Total
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(vatableBase)}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(
                      round2(
                        exemptSales.reduce(
                          (sum, sale) => sum + Number(sale.subtotal),
                          0,
                        ),
                      ),
                    )}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(outputVat)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No sales in this quarter.</EmptyState>
        )}
      </Card>

      <p className="text-xs muted mt-3">
        These are the figures the forms need, laid out for transcription onto the
        BIR templates. They are not the official form layouts, and should be
        reviewed by your accountant before filing.
      </p>
    </ReportShell>
  );
}
