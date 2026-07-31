import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { derivedRate } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createUtilityPeriod } from "./actions";
import { NewPeriodForm } from "./period-forms";

export const metadata: Metadata = { title: "Utility periods" };

type PeriodRow = {
  id: string;
  utility: string;
  period_start: string;
  period_end: string;
  provider_amount: string;
  provider_consumption: string;
  genset_expense: string;
  is_locked: boolean;
  locations: { code: string; name: string } | null;
  meter_readings: { count: number }[];
};

export default async function UtilityPeriodsPage() {
  const context = await requirePermission(MODULE.billingUtilityRates, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.billingUtilityRates, "edit");

  const supabase = await createClient();
  const [{ data: periods }, { data: locations }] = await Promise.all([
    supabase
      .from("utility_periods")
      .select(
        "id, utility, period_start, period_end, provider_amount, provider_consumption, genset_expense, is_locked, locations(code, name), meter_readings(count)",
      )
      .eq("company_id", companyId)
      .order("period_start", { ascending: false })
      .returns<PeriodRow[]>(),
    supabase
      .from("locations")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
  ]);

  return (
    <>
      <PageHeader
        title="Utility periods"
        description="One provider bill per location, per utility, per month. The per-unit rate is derived from it."
      />

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Open a period"
            description="Enter the provider bill now or after the readings are in."
          >
            <NewPeriodForm action={createUtilityPeriod} locations={locations ?? []} />
          </Card>
        </div>
      ) : null}

      <Card title="Periods" bodyClassName="">
        {periods && periods.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Location</th>
                  <th>Utility</th>
                  <th className="text-right">Provider bill</th>
                  <th className="text-right">Consumption</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Readings</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => {
                  const rate = derivedRate(
                    Number(period.provider_amount),
                    Number(period.provider_consumption),
                  );
                  const unit = period.utility === "water" ? "cu.m" : "kWh";
                  return (
                    <tr key={period.id}>
                      <td>
                        <Link
                          href={`/billing/periods/${period.id}`}
                          className="font-semibold"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {formatDate(period.period_start)}
                        </Link>
                        <p className="text-xs muted">
                          to {formatDate(period.period_end)}
                        </p>
                      </td>
                      <td className="text-xs">
                        {period.locations?.code} — {period.locations?.name}
                      </td>
                      <td>
                        <span className="badge">{period.utility}</span>
                      </td>
                      <td className="text-right tabular-nums">
                        {money(period.provider_amount)}
                        {Number(period.genset_expense) > 0 ? (
                          <p className="text-xs muted">
                            + {money(period.genset_expense)} genset
                          </p>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">
                        {Number(period.provider_consumption)} {unit}
                      </td>
                      <td className="text-right tabular-nums">
                        {rate ? `₱${rate.toFixed(4)}` : "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {period.meter_readings?.[0]?.count ?? 0}
                      </td>
                      <td>
                        {period.is_locked ? (
                          <span className="badge">locked</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No utility periods yet
            {canEdit ? " — open the first one above." : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
