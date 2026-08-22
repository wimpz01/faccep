import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { effectiveRate } from "@/lib/billing";
import { formatDate } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { saveMeterReadings, setPeriodLocked, updateUtilityPeriod } from "../actions";
import { addHouseMeter, saveHouseReadings } from "../house-actions";
import { HouseMeterGrid, type HouseMeterRow } from "../house-meter-grid";
import { ProviderBillForm, ReadingGrid, type ReadingRow } from "../period-forms";

export const metadata: Metadata = { title: "Utility period" };

type PeriodDetail = {
  id: string;
  company_id: string;
  location_id: string;
  utility: string;
  period_start: string;
  period_end: string;
  provider_amount: string;
  provider_consumption: string;
  manual_rate: number | null;
  extra_expense: string;
  is_locked: boolean;
  notes: string | null;
  locations: { code: string; name: string } | null;
};

type UnitRow = {
  id: string;
  code: string;
  contract_units: {
    contracts: {
      status: string;
      tenants: { company_name: string } | null;
    } | null;
  }[];
};

export default async function UtilityPeriodPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.billingUtilityRates, "view");
  const companyId = context.activeCompany!.companyId;
  const canEditPeriod = can(context.permissions, MODULE.billingUtilityRates, "edit");
  const canEditReadings = can(context.permissions, MODULE.billingMeterReadings, "edit");

  const supabase = await createClient();

  const { data: period } = await supabase
    .from("utility_periods")
    .select(
      "id, company_id, location_id, utility, period_start, period_end, provider_amount, provider_consumption, manual_rate, extra_expense, is_locked, notes, locations(code, name)",
    )
    .eq("id", id)
    .maybeSingle<PeriodDetail>();

  if (!period || period.company_id !== companyId) notFound();

  const [{ data: units }, { data: readings }] = await Promise.all([
    supabase
      .from("units")
      .select("id, code, contract_units(contracts(status, tenants(company_name)))")
      .eq("location_id", period.location_id)
      .neq("status", "inactive")
      .order("code")
      .returns<UnitRow[]>(),
    supabase
      .from("meter_readings")
      .select("unit_id, previous_reading, present_reading, consumption")
      .eq("period_id", id),
  ]);

  const readingByUnit = new Map(
    (readings ?? []).map((row) => [row.unit_id, row]),
  );

  // Carry each unit's previous reading forward from the last period, unless a
  // reading has already been saved for this one.
  const previousByUnit = new Map<string, number>();
  const unitIds = (units ?? []).map((unit) => unit.id);
  if (unitIds.length > 0) {
    const { data: history } = await supabase
      .from("meter_readings")
      .select("unit_id, present_reading, utility_periods!inner(utility, period_start)")
      .in("unit_id", unitIds)
      .lt("utility_periods.period_start", period.period_start)
      .eq("utility_periods.utility", period.utility)
      .order("unit_id")
      .returns<
        {
          unit_id: string;
          present_reading: string;
          utility_periods: { utility: string; period_start: string };
        }[]
      >();

    for (const row of history ?? []) {
      const current = previousByUnit.get(row.unit_id);
      // Rows are unordered per unit, so keep the highest reading seen.
      const value = Number(row.present_reading);
      if (current === undefined || value > current) {
        previousByUnit.set(row.unit_id, value);
      }
    }
  }

  const rows: ReadingRow[] = (units ?? []).map((unit) => {
    const saved = readingByUnit.get(unit.id);
    const tenant = (unit.contract_units ?? [])
      .map((link) => link.contracts)
      .find((contract) => contract?.status === "active")?.tenants?.company_name;

    return {
      unitId: unit.id,
      unitCode: unit.code,
      tenantName: tenant ?? null,
      previous: saved
        ? Number(saved.previous_reading)
        : (previousByUnit.get(unit.id) ?? 0),
      present: saved ? Number(saved.present_reading) : null,
    };
  });

  /*
   * The building's own meters for this property and utility, with anything
   * already read this period. Every meter is listed whether read or not:
   * one nobody has read is exactly what the balance needs to show.
   */
  const [{ data: houseMeters }, { data: houseReadings }] = await Promise.all([
    supabase
      .from("house_meters")
      .select("id, label, serial, direction")
      .eq("location_id", period.location_id)
      .eq("utility", period.utility)
      .eq("is_active", true)
      .order("direction")
      .order("label")
      .returns<
        {
          id: string;
          label: string;
          serial: string | null;
          direction: "consumption" | "supply";
        }[]
      >(),
    supabase
      .from("house_meter_readings")
      .select("house_meter_id, previous_reading, present_reading")
      .eq("period_id", period.id)
      .returns<
        {
          house_meter_id: string;
          previous_reading: string;
          present_reading: string;
        }[]
      >(),
  ]);

  const houseSaved = new Map(
    (houseReadings ?? []).map((row) => [row.house_meter_id, row]),
  );

  /*
   * Last period's present reading becomes this one's previous, the same way
   * a tenant's does. A meter is a running total on a dial: starting it from
   * nought every month would read the whole life of the meter as one month's
   * usage, and the balance would be nonsense the first time somebody forgot
   * to type the previous figure by hand.
   *
   * Only for a meter not yet read this period. Once a reading is saved its
   * own previous stands, so a correction typed here is not overwritten by
   * history on the next visit.
   */
  const carriedForward = new Map<string, number>();
  const houseMeterIds = (houseMeters ?? []).map((meter) => meter.id);

  if (houseMeterIds.length > 0) {
    const { data: houseHistory } = await supabase
      .from("house_meter_readings")
      .select(
        "house_meter_id, present_reading, utility_periods!inner(period_start)",
      )
      .in("house_meter_id", houseMeterIds)
      .lt("utility_periods.period_start", period.period_start)
      .returns<
        {
          house_meter_id: string;
          present_reading: string;
          utility_periods: { period_start: string };
        }[]
      >();

    for (const row of houseHistory ?? []) {
      // Unordered per meter, so keep the highest seen -- a dial only climbs.
      const seen = carriedForward.get(row.house_meter_id);
      const value = Number(row.present_reading);
      if (seen === undefined || value > seen) {
        carriedForward.set(row.house_meter_id, value);
      }
    }
  }

  const houseRows: HouseMeterRow[] = (houseMeters ?? []).map((meter) => {
    const saved = houseSaved.get(meter.id);
    return {
      id: meter.id,
      label: meter.label,
      serial: meter.serial,
      direction: meter.direction,
      previous: saved
        ? Number(saved.previous_reading)
        : (carriedForward.get(meter.id) ?? 0),
      present: saved ? Number(saved.present_reading) : null,
    };
  });

  const tenantConsumption = (readings ?? []).reduce(
    (sum, row) => sum + Number(row.consumption ?? 0),
    0,
  );

  // What tenants are charged, which is the period's own rate where one is set.
  const rate = effectiveRate({
    providerAmount: Number(period.provider_amount),
    providerConsumption: Number(period.provider_consumption),
    manualRate: period.manual_rate === null ? null : Number(period.manual_rate),
  });

  return (
    <>
      <PageHeader
        title={`${period.utility === "water" ? "Water" : "Electricity"} — ${formatDate(period.period_start)}`}
        description={`${period.locations?.code} ${period.locations?.name} · to ${formatDate(period.period_end)}`}
        action={
          <div className="flex gap-2">
            <Link href="/billing/periods" className="btn btn-secondary btn-sm">
              Back
            </Link>
            {canEditPeriod ? (
              <form action={setPeriodLocked}>
                <input type="hidden" name="id" value={period.id} />
                <input
                  type="hidden"
                  name="locked"
                  value={String(!period.is_locked)}
                />
                <button type="submit" className="btn btn-secondary btn-sm">
                  {period.is_locked ? "Unlock period" : "Lock period"}
                </button>
              </form>
            ) : null}
          </div>
        }
      />

      <div className="mb-6">
        <Card
          title="Provider bill"
          description="Tenants are charged this bill divided by the building's total consumption, unless a rate is set here instead."
        >
          <ProviderBillForm
            action={updateUtilityPeriod}
            period={period}
            tenantConsumption={tenantConsumption}
            isLocked={period.is_locked || !canEditPeriod}
          />
        </Card>
      </div>

      <div className="mb-6">
        <Card
          title="Meter readings"
          description={`${rows.length} unit${rows.length === 1 ? "" : "s"} in this location.`}
        >
        <ReadingGrid
          action={saveMeterReadings}
          periodId={period.id}
          utility={period.utility}
          rows={rows}
          rate={rate}
          extraExpense={Number(period.extra_expense)}
          isLocked={period.is_locked}
          canEdit={canEditReadings}
        />
        </Card>
      </div>

      {/* Where the provider's units actually went. Kept apart from the
          tenant grid because none of it is charged to anybody. */}
      <Card
        title="Building meters and the balance"
        description="The property's own meters, and what they leave unaccounted for against the provider bill."
      >
        <HouseMeterGrid
          action={saveHouseReadings}
          addAction={addHouseMeter}
          periodId={period.id}
          utility={period.utility}
          meters={houseRows}
          providerConsumption={Number(period.provider_consumption)}
          tenantConsumption={tenantConsumption}
          rate={rate}
          isLocked={period.is_locked}
          canEdit={canEditReadings}
        />
      </Card>
    </>
  );
}
