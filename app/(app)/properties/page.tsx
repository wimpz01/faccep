import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { PROPERTY_TYPES } from "../portfolio/locations/constants";

export const metadata: Metadata = { title: "Properties & Units" };

type LocationWithUnits = {
  id: string;
  code: string;
  name: string;
  property_type: string;
  address: string | null;
  is_active: boolean;
  units: { id: string; status: string; monthly_rate: string }[];
};

const TYPE_LABELS = Object.fromEntries(
  PROPERTY_TYPES.map((type) => [type.value, type.label]),
);

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const context = await requirePermission(MODULE.properties, "view");
  const companyId = context.activeCompany!.companyId;
  const canEditUnits = can(context.permissions, MODULE.units, "edit");

  const supabase = await createClient();
  const { data: locations } = await supabase
    .from("locations")
    .select(
      "id, code, name, property_type, address, is_active, units(id, status, monthly_rate)",
    )
    .eq("company_id", companyId)
    .order("code")
    .returns<LocationWithUnits[]>();

  const rows = (locations ?? []).map((location) => {
    const units = location.units ?? [];
    const active = units.filter((unit) => unit.status !== "inactive");
    const occupied = active.filter((unit) => unit.status === "occupied");
    const vacant = active.filter((unit) => unit.status === "vacant");
    return {
      ...location,
      total: active.length,
      occupied: occupied.length,
      vacant: vacant.length,
      occupancy: active.length === 0 ? 0 : (occupied.length / active.length) * 100,
      // What the location would bill if every unit were let at its listed rate.
      potential: active.reduce((sum, unit) => sum + Number(unit.monthly_rate), 0),
      contracted: occupied.reduce(
        (sum, unit) => sum + Number(unit.monthly_rate),
        0,
      ),
    };
  });

  const totals = rows.reduce(
    (acc, row) => ({
      units: acc.units + row.total,
      occupied: acc.occupied + row.occupied,
      vacant: acc.vacant + row.vacant,
      contracted: acc.contracted + row.contracted,
    }),
    { units: 0, occupied: 0, vacant: 0, contracted: 0 },
  );

  // Clicking a figure narrows the list to the properties behind it.
  const shown =
    view === "vacant"
      ? rows.filter((row) => row.vacant > 0)
      : view === "let"
        ? rows.filter((row) => row.occupied > 0)
        : rows;
  const filterLabel =
    view === "vacant"
      ? "properties with a unit standing empty"
      : view === "let"
        ? "properties with a unit let"
        : null;

  const overallOccupancy =
    totals.units === 0 ? 0 : (totals.occupied / totals.units) * 100;

  return (
    <>
      <PageHeader
        title="Properties & Units"
        description="Occupancy and unit inventory per location."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Occupancy"
          value={`${overallOccupancy.toFixed(0)}%`}
          hint={`${totals.occupied} of ${totals.units} units`}
          href="/properties"
        />
        <StatTile
          label="Vacant units"
          value={totals.vacant}
          hint="Available to let"
          href="/properties?view=vacant"
        />
        <StatTile
          label="Contracted rent"
          value={money(totals.contracted)}
          hint="Monthly, occupied units"
          href="/properties?view=let"
          tone="money"
        />
        <StatTile
          label="Locations"
          value={rows.length}
          hint="In this company"
          href="/properties"
        />
      </div>

      {filterLabel ? (
        <FilterNote
          label={filterLabel}
          count={shown.length}
          clearHref="/properties"
        />
      ) : null}

      <Card title="Locations" bodyClassName="">
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Type</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Occupied</th>
                  <th className="text-right">Vacant</th>
                  <th className="text-right">Occupancy</th>
                  <th className="text-right">Contracted rent</th>
                  {canEditUnits ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        href={`/properties/${row.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {row.name}
                      </Link>
                      <p className="text-xs muted">
                        <span className="badge mr-1">{row.code}</span>
                        {row.address ?? "No address"}
                      </p>
                    </td>
                    <td className="text-xs">
                      {TYPE_LABELS[row.property_type] ?? row.property_type}
                    </td>
                    <td className="text-right tabular-nums">{row.total}</td>
                    <td className="text-right tabular-nums">{row.occupied}</td>
                    <td className="text-right tabular-nums">{row.vacant}</td>
                    <td className="text-right tabular-nums">
                      {row.occupancy.toFixed(0)}%
                    </td>
                    <td className="text-right tabular-nums">
                      {money(row.contracted)}
                    </td>
                    {canEditUnits ? (
                      <td className="text-right">
                        <Link
                          href={`/properties/${row.id}#add-unit`}
                          className="btn btn-primary btn-sm"
                        >
                          Add unit
                        </Link>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No locations yet. Add one under Administration → Locations.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
