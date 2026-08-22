import type { Metadata } from "next";
import Link from "next/link";

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
  invoice_no: string;
  invoice_date: string;
  subtotal: string;
  vat_amount: string;
  total: string;
  tenants: { company_name: string } | null;
  contracts: {
    contract_no: string;
    contract_units: {
      units: {
        code: string;
        locations: { id: string; code: string; name: string } | null;
      } | null;
    }[];
  } | null;
  invoice_lines: { line_kind: string; amount: string }[];
};

const UNATTRIBUTED = "unattributed";

export default async function IncomeReport({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; location?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsSales, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;
  // The box sends "all" for the whole company; the table rows send nothing.
  const drilldown =
    filters.location && filters.location !== "all" ? filters.location : null;

  const supabase = await createClient();
  const [{ data: invoices }, { data: allLocations }] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        `id, invoice_no, invoice_date, subtotal, vat_amount, total,
         tenants(company_name),
         contracts(contract_no, contract_units(units(code, locations(id, code, name)))),
         invoice_lines(line_kind, amount)`,
      )
      .eq("company_id", companyId)
      .neq("status", "cancelled")
      .neq("status", "draft")
      .gte("invoice_date", from)
      .lte("invoice_date", to)
      .order("invoice_date")
      .returns<InvoiceRow[]>(),
    /*
     * Listed from the locations table rather than from the invoices, so a
     * property that billed nothing this range can still be chosen -- and
     * answer, plainly, that it billed nothing.
     */
    supabase
      .from("locations")
      .select("id, code, name")
      .eq("company_id", companyId)
      .order("code")
      .returns<{ id: string; code: string; name: string }[]>(),
  ]);

  const all = invoices ?? [];

  // An invoice can span units in one location; the first is used to attribute
  // it, which matches how contracts are written in practice.
  const placeOf = (invoice: InvoiceRow) =>
    invoice.contracts?.contract_units?.[0]?.units?.locations ?? null;
  const keyOf = (invoice: InvoiceRow) => placeOf(invoice)?.id ?? UNATTRIBUTED;
  const nameOf = (invoice: InvoiceRow) => {
    const place = placeOf(invoice);
    return place ? `${place.code} — ${place.name}` : "Unattributed";
  };

  // Every location in the range, built before any narrowing so the summary
  // still shows the whole picture while one place is being read.
  const byLocation = new Map<
    string,
    { key: string; name: string; net: number; vat: number; count: number }
  >();
  for (const invoice of all) {
    const key = keyOf(invoice);
    const entry =
      byLocation.get(key) ??
      { key, name: nameOf(invoice), net: 0, vat: 0, count: 0 };
    entry.net = round2(entry.net + Number(invoice.subtotal));
    entry.vat = round2(entry.vat + Number(invoice.vat_amount));
    entry.count += 1;
    byLocation.set(key, entry);
  }

  const locations = [...byLocation.values()].sort((a, b) => b.net - a.net);
  const hasUnattributed = byLocation.has(UNATTRIBUTED);
  const grandNet = round2(locations.reduce((sum, row) => sum + row.net, 0));
  const grandVat = round2(locations.reduce((sum, row) => sum + row.vat, 0));

  /*
   * What the figures below describe. Opening one location narrows every panel
   * to it -- the months, the charge types and the invoice list -- so the whole
   * report reads as that location's, not as the company's with one table
   * swapped.
   */
  const shown = drilldown
    ? all.filter((invoice) => keyOf(invoice) === drilldown)
    : all;

  /*
   * A location chosen from the box may have billed nothing in this range, so
   * it is not in byLocation at all. It still has to be named and still has to
   * narrow the report -- answering "nothing" is an answer, and silently
   * showing the whole company instead would be a lie.
   */
  const openLocation = !drilldown
    ? null
    : (byLocation.get(drilldown) ??
      (() => {
        const place = (allLocations ?? []).find((row) => row.id === drilldown);
        if (place) {
          return {
            key: place.id,
            name: `${place.code} — ${place.name}`,
            net: 0,
            vat: 0,
            count: 0,
          };
        }
        return drilldown === UNATTRIBUTED
          ? { key: UNATTRIBUTED, name: "Unattributed", net: 0, vat: 0, count: 0 }
          : null;
      })());

  const byMonth = new Map<string, number>();
  const byKind = new Map<string, number>();
  const byTenant = new Map<
    string,
    { name: string; net: number; vat: number; count: number }
  >();

  for (const invoice of shown) {
    const month = invoice.invoice_date.slice(0, 7);
    byMonth.set(
      month,
      round2((byMonth.get(month) ?? 0) + Number(invoice.subtotal)),
    );

    for (const line of invoice.invoice_lines ?? []) {
      byKind.set(
        line.line_kind,
        round2((byKind.get(line.line_kind) ?? 0) + Number(line.amount)),
      );
    }

    const tenant = invoice.tenants?.company_name ?? "Unknown tenant";
    const entry =
      byTenant.get(tenant) ?? { name: tenant, net: 0, vat: 0, count: 0 };
    entry.net = round2(entry.net + Number(invoice.subtotal));
    entry.vat = round2(entry.vat + Number(invoice.vat_amount));
    entry.count += 1;
    byTenant.set(tenant, entry);
  }

  const shownNet = round2(
    shown.reduce((sum, invoice) => sum + Number(invoice.subtotal), 0),
  );
  const shownVat = round2(
    shown.reduce((sum, invoice) => sum + Number(invoice.vat_amount), 0),
  );

  const linkTo = (location: string | null) => {
    const params = new URLSearchParams({ from, to });
    if (location) params.set("location", location);
    return `/reports/income?${params.toString()}`;
  };

  return (
    <ReportShell
      title="Income per location"
      description={`Invoiced revenue from ${formatDate(from)} to ${formatDate(to)}. Drafts and cancelled invoices are excluded.`}
      from={from}
      to={to}
      scopeNote={openLocation ? openLocation.name : undefined}
      leadingFilters={
        <div>
          <label className="label" htmlFor="location">
            Location
          </label>
          {/* The same setting the table rows change, so choosing here and
              opening a row there are one thing, not two. */}
          <select
            id="location"
            name="location"
            className="select"
            defaultValue={drilldown ?? "all"}
          >
            <option value="all">All locations</option>
            {(allLocations ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} — {row.name}
              </option>
            ))}
            {hasUnattributed ? (
              <option value={UNATTRIBUTED}>Unattributed</option>
            ) : null}
          </select>
        </div>
      }
    >
      {openLocation ? (
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <Link href={linkTo(null)} className="btn btn-secondary btn-sm no-print">
            ← All locations
          </Link>
          <p className="text-sm">
            Showing <strong>{openLocation.name}</strong> only —{" "}
            {openLocation.count} invoice(s).
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <StatTile
          label="Net revenue"
          value={money(shownNet)}
          tone="money"
          hint="Before VAT"
        />
        <StatTile label="VAT" value={money(shownVat)} hint="Output tax" />
        <StatTile
          label="Invoices"
          value={shown.length}
          hint="Released or later"
        />
      </div>

      <div className="mb-5">
        <Card
          title="By location"
          description={
            openLocation
              ? "Every location in this range. The one being read is marked."
              : "Open a location to read only its invoices, tenants and months."
          }
          bodyClassName=""
        >
          {locations.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="text-right">Invoices</th>
                    <th className="text-right">Net</th>
                    <th className="text-right">VAT</th>
                    <th className="text-right">Gross</th>
                    <th className="text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.map((row) => {
                    const open = row.key === drilldown;
                    return (
                      <tr
                        key={row.key}
                        style={
                          open
                            ? { background: "var(--color-brand-50, #eef2ff)" }
                            : undefined
                        }
                      >
                        <td className="text-sm">
                          {/* The name is the way in. Reading one location is
                              the usual next question after seeing the split. */}
                          <Link
                            href={linkTo(open ? null : row.key)}
                            style={{
                              color: "var(--color-brand-600)",
                              fontWeight: open ? 700 : undefined,
                            }}
                          >
                            {row.name}
                          </Link>
                          {open ? (
                            <span className="text-xs muted"> · open</span>
                          ) : null}
                        </td>
                        <td className="text-right tabular-nums">{row.count}</td>
                        <td className="text-right tabular-nums">
                          {money(row.net)}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(row.vat)}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(round2(row.net + row.vat))}
                        </td>
                        <td className="text-right tabular-nums">
                          {grandNet
                            ? ((row.net / grandNet) * 100).toFixed(1)
                            : "0"}
                          %
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="font-bold">Total</td>
                    <td className="text-right tabular-nums font-bold">
                      {all.length}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(grandNet)}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(grandVat)}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(round2(grandNet + grandVat))}
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

      {/* The drilldown proper: who was billed, and every invoice behind the
          figure above. Only shown once a location has been opened, since across
          the whole company it would be a list nobody reads. */}
      {openLocation ? (
        <>
          <div className="mb-5">
            <Card
              title="By tenant"
              description={`Who the ${openLocation.name} revenue was billed to.`}
              bodyClassName=""
            >
              {byTenant.size > 0 ? (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tenant</th>
                        <th className="text-right">Invoices</th>
                        <th className="text-right">Net</th>
                        <th className="text-right">VAT</th>
                        <th className="text-right">Gross</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...byTenant.values()]
                        .sort((a, b) => b.net - a.net)
                        .map((row) => (
                          <tr key={row.name}>
                            <td className="text-sm">{row.name}</td>
                            <td className="text-right tabular-nums">
                              {row.count}
                            </td>
                            <td className="text-right tabular-nums">
                              {money(row.net)}
                            </td>
                            <td className="text-right tabular-nums">
                              {money(row.vat)}
                            </td>
                            <td className="text-right tabular-nums">
                              {money(round2(row.net + row.vat))}
                            </td>
                          </tr>
                        ))}
                      <tr>
                        <td className="font-bold">Total</td>
                        <td className="text-right tabular-nums font-bold">
                          {shown.length}
                        </td>
                        <td className="text-right tabular-nums font-bold">
                          {money(shownNet)}
                        </td>
                        <td className="text-right tabular-nums font-bold">
                          {money(shownVat)}
                        </td>
                        <td className="text-right tabular-nums font-bold">
                          {money(round2(shownNet + shownVat))}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState>Nothing invoiced here in this range.</EmptyState>
              )}
            </Card>
          </div>

          <div className="mb-5">
            <Card
              title="Invoices"
              description="Every invoice behind the figures above."
              bodyClassName=""
            >
              {shown.length > 0 ? (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Invoice</th>
                        <th>Tenant</th>
                        <th>Unit</th>
                        <th className="text-right">Net</th>
                        <th className="text-right">VAT</th>
                        <th className="text-right">Gross</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((invoice) => (
                        <tr key={invoice.id}>
                          <td className="text-xs">
                            {formatDate(invoice.invoice_date)}
                          </td>
                          <td className="text-sm">
                            <Link
                              href={`/billing/invoices/${invoice.id}`}
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              {invoice.invoice_no}
                            </Link>
                          </td>
                          <td className="text-sm">
                            {invoice.tenants?.company_name ?? "—"}
                          </td>
                          <td className="text-xs">
                            {(invoice.contracts?.contract_units ?? [])
                              .map((link) => link.units?.code)
                              .filter(Boolean)
                              .join(", ") || "—"}
                          </td>
                          <td className="text-right tabular-nums">
                            {money(invoice.subtotal)}
                          </td>
                          <td className="text-right tabular-nums">
                            {money(invoice.vat_amount)}
                          </td>
                          <td className="text-right tabular-nums">
                            {money(invoice.total)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={4} className="text-right font-bold">
                          Total
                        </td>
                        <td className="text-right tabular-nums font-bold">
                          {money(shownNet)}
                        </td>
                        <td className="text-right tabular-nums font-bold">
                          {money(shownVat)}
                        </td>
                        <td className="text-right tabular-nums font-bold">
                          {money(round2(shownNet + shownVat))}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState>Nothing invoiced here in this range.</EmptyState>
              )}
            </Card>
          </div>
        </>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={openLocation ? `By month — ${openLocation.name}` : "By month"}
          bodyClassName=""
        >
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
                        <td className="text-right tabular-nums">
                          {money(amount)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No data.</EmptyState>
          )}
        </Card>

        <Card
          title={
            openLocation
              ? `By charge type — ${openLocation.name}`
              : "By charge type"
          }
          bodyClassName=""
        >
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
                        <td className="text-right tabular-nums">
                          {money(amount)}
                        </td>
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
