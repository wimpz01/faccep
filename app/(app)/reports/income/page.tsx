import type { Metadata } from "next";

import { ReportShell, defaultRange } from "@/components/report-shell";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Income per location" };

type InvoiceRow = {
  id: string;
  invoice_date: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  contracts: {
    contract_units: {
      units: { locations: { id: string; code: string; name: string } | null } | null;
    }[];
  } | null;
  invoice_lines: { line_kind: string; amount: string }[];
};

export default async function IncomeReport({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsSales, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;

  const supabase = await createClient();
  const { data: invoices } = await supabase
    .from("invoices")
    .select(
      `id, invoice_date, subtotal, vat_amount, total,
       contracts(contract_units(units(locations(id, code, name)))),
       invoice_lines(line_kind, amount)`,
    )
    .eq("company_id", companyId)
    .neq("status", "cancelled")
    .neq("status", "draft")
    .gte("invoice_date", from)
    .lte("invoice_date", to)
    .returns<InvoiceRow[]>();

  const rows = invoices ?? [];

  // An invoice can span units in one location; the first is used to attribute
  // it, which matches how contracts are written in practice.
  const byLocation = new Map<string, { name: string; net: number; vat: number }>();
  const byMonth = new Map<string, number>();
  const byKind = new Map<string, number>();

  for (const invoice of rows) {
    const location = invoice.contracts?.contract_units?.[0]?.units?.locations;
    const key = location?.id ?? "unattributed";
    const entry =
      byLocation.get(key) ??
      {
        name: location ? `${location.code} — ${location.name}` : "Unattributed",
        net: 0,
        vat: 0,
      };
    entry.net = round2(entry.net + Number(invoice.subtotal));
    entry.vat = round2(entry.vat + Number(invoice.vat_amount));
    byLocation.set(key, entry);

    const month = invoice.invoice_date.slice(0, 7);
    byMonth.set(month, round2((byMonth.get(month) ?? 0) + Number(invoice.subtotal)));

    for (const line of invoice.invoice_lines ?? []) {
      byKind.set(
        line.line_kind,
        round2((byKind.get(line.line_kind) ?? 0) + Number(line.amount)),
      );
    }
  }

  const locations = [...byLocation.values()].sort((a, b) => b.net - a.net);
  const totalNet = round2(locations.reduce((sum, row) => sum + row.net, 0));
  const totalVat = round2(locations.reduce((sum, row) => sum + row.vat, 0));

  return (
    <ReportShell
      title="Income per location"
      description={`Invoiced revenue from ${formatDate(from)} to ${formatDate(to)}. Drafts and cancelled invoices are excluded.`}
      from={from}
      to={to}
    >
      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <StatTile label="Net revenue" value={money(totalNet)} tone="money" hint="Before VAT" />
        <StatTile label="VAT" value={money(totalVat)} hint="Output tax" />
        <StatTile label="Invoices" value={rows.length} hint="Released or later" />
      </div>

      <div className="mb-5">
        <Card title="By location" bodyClassName="">
          {locations.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="text-right">Net</th>
                    <th className="text-right">VAT</th>
                    <th className="text-right">Gross</th>
                    <th className="text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.map((row) => (
                    <tr key={row.name}>
                      <td className="text-sm">{row.name}</td>
                      <td className="text-right tabular-nums">{money(row.net)}</td>
                      <td className="text-right tabular-nums">{money(row.vat)}</td>
                      <td className="text-right tabular-nums">
                        {money(round2(row.net + row.vat))}
                      </td>
                      <td className="text-right tabular-nums">
                        {totalNet ? ((row.net / totalNet) * 100).toFixed(1) : "0"}%
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="font-bold">Total</td>
                    <td className="text-right tabular-nums font-bold">
                      {money(totalNet)}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(totalVat)}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(round2(totalNet + totalVat))}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>Nothing invoiced in this range.</EmptyState>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By month" bodyClassName="">
          {byMonth.size > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="text-right">Net revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byMonth.entries()]
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([month, amount]) => (
                      <tr key={month}>
                        <td className="text-sm">{month}</td>
                        <td className="text-right tabular-nums">{money(amount)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No data.</EmptyState>
          )}
        </Card>

        <Card title="By charge type" bodyClassName="">
          {byKind.size > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Charge</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byKind.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([kind, amount]) => (
                      <tr key={kind}>
                        <td className="text-sm">{kind}</td>
                        <td className="text-right tabular-nums">{money(amount)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No data.</EmptyState>
          )}
        </Card>
      </div>
    </ReportShell>
  );
}
