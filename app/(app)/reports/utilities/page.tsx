import type { Metadata } from "next";

import { ReportShell, defaultRange } from "@/components/report-shell";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { derivedRate, reconcile, round3 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Utility over/loss" };

type PeriodRow = {
  id: string;
  utility: string;
  period_start: string;
  period_end: string;
  provider_amount: string;
  provider_consumption: string;
  genset_expense: string;
  locations: { code: string; name: string } | null;
  meter_readings: { consumption: string }[];
};

export default async function UtilitiesReport({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsUtilities, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;

  const supabase = await createClient();
  const { data: periods } = await supabase
    .from("utility_periods")
    .select(
      "id, utility, period_start, period_end, provider_amount, provider_consumption, genset_expense, locations(code, name), meter_readings(consumption)",
    )
    .eq("company_id", companyId)
    .gte("period_start", from)
    .lte("period_start", to)
    .order("period_start", { ascending: false })
    .returns<PeriodRow[]>();

  const rows = (periods ?? []).map((period) => {
    const tenantTotal = (period.meter_readings ?? []).reduce(
      (sum, reading) => sum + Number(reading.consumption ?? 0),
      0,
    );
    const rate = derivedRate(
      Number(period.provider_amount),
      Number(period.provider_consumption),
    );
    const check = reconcile(Number(period.provider_consumption), tenantTotal);
    return {
      ...period,
      tenantTotal,
      rate,
      check,
      // The unbilled consumption valued at the period's own rate.
      lossValue: check.difference * rate,
    };
  });

  const totalProviderCost = rows.reduce(
    (sum, row) => sum + Number(row.provider_amount),
    0,
  );
  const totalBilled = rows.reduce((sum, row) => sum + row.tenantTotal * row.rate, 0);
  const totalLoss = rows.reduce((sum, row) => sum + row.lossValue, 0);

  return (
    <ReportShell
      title="Utility over/loss"
      description={`What the provider charged against what the sub-meters account for, ${formatDate(from)} to ${formatDate(to)}.`}
      from={from}
      to={to}
    >
      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <StatTile
          label="Provider cost"
          value={money(totalProviderCost)}
          hint="Billed to the building"
          tone="money"
        />
        <StatTile
          label="Recovered from tenants"
          value={money(totalBilled)}
          hint="At the derived rate"
        />
        <StatTile
          label="Unrecovered"
          value={money(totalLoss)}
          hint="System loss and common areas"
        />
      </div>

      <Card title="Period by period" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Location</th>
                  <th>Utility</th>
                  <th className="text-right">Provider</th>
                  <th className="text-right">Sub-metered</th>
                  <th className="text-right">Difference</th>
                  <th className="text-right">%</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const unit = row.utility === "water" ? "cu.m" : "kWh";
                  const concerning = Math.abs(row.check.percentage) > 15;
                  return (
                    <tr key={row.id}>
                      <td className="text-xs">
                        {formatDate(row.period_start)}
                        <p className="muted">to {formatDate(row.period_end)}</p>
                      </td>
                      <td className="text-xs">{row.locations?.code}</td>
                      <td>
                        <span className="badge">{row.utility}</span>
                      </td>
                      <td className="text-right tabular-nums">
                        {round3(Number(row.provider_consumption))} {unit}
                        <p className="text-xs muted">{money(row.provider_amount)}</p>
                      </td>
                      <td className="text-right tabular-nums">
                        {round3(row.tenantTotal)} {unit}
                      </td>
                      <td className="text-right tabular-nums">
                        {round3(row.check.difference)} {unit}
                      </td>
                      <td
                        className="text-right tabular-nums"
                        style={concerning ? { color: "var(--danger)" } : undefined}
                      >
                        {row.check.percentage}%
                      </td>
                      <td className="text-right tabular-nums">
                        {money(row.lossValue)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No utility periods in this range.</EmptyState>
        )}
      </Card>

      <p className="text-xs muted mt-3">
        A persistent gap above roughly 15% usually means an unmetered common
        area, a faulty sub-meter, or a reading that was missed for the period.
      </p>
    </ReportShell>
  );
}
