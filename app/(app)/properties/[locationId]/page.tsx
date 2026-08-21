import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { PROPERTY_TYPES } from "../../portfolio/locations/constants";
import {
  createUnit,
  deleteUnit,
  deleteUnitPhoto,
  recordUnitPhoto,
  setUnitInactive,
  updateUnit,
} from "./actions";
import { UnitForm, UnitPhotoUploader } from "./unit-form";

export const metadata: Metadata = { title: "Units" };

type UnitRow = {
  id: string;
  code: string;
  floor: string | null;
  area_sqm: string | null;
  monthly_rate: string;
  status: string;
  description: string | null;
  appliances: string[];
  water_meter_serial: string | null;
  electric_meter_serial: string | null;
  unit_photos: { id: string; storage_path: string; caption: string | null }[];
  contract_units: {
    contracts: {
      id: string;
      contract_no: string;
      status: string;
      tenants: { company_name: string } | null;
    } | null;
  }[];
};

const STATUS_STYLES: Record<string, string> = {
  occupied: "badge badge-brand",
  vacant: "badge",
  reserved: "badge",
  inactive: "badge",
};

const TYPE_LABELS = Object.fromEntries(
  PROPERTY_TYPES.map((type) => [type.value, type.label]),
);

export default async function LocationUnitsPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;
  const context = await requirePermission(MODULE.properties, "view");
  const companyId = context.activeCompany!.companyId;
  const canEditUnits = can(context.permissions, MODULE.units, "edit");
  const canDeleteUnits = can(context.permissions, MODULE.units, "delete");

  const supabase = await createClient();

  const { data: location } = await supabase
    .from("locations")
    .select("id, code, name, property_type, address, company_id")
    .eq("id", locationId)
    .maybeSingle();

  if (!location || location.company_id !== companyId) notFound();

  const { data: units } = await supabase
    .from("units")
    .select(
      `id, code, floor, area_sqm, monthly_rate, status, description, appliances,
       water_meter_serial, electric_meter_serial,
       unit_photos(id, storage_path, caption),
       contract_units(contracts(id, contract_no, status, tenants(company_name)))`,
    )
    .eq("location_id", locationId)
    .order("code")
    .returns<UnitRow[]>();

  /*
   * Rates proposed but not yet agreed. Shown beside the rate in force so the
   * list never implies a figure is live when it is still with an approver.
   */
  const { data: pendingRates } = await supabase
    .from("unit_rate_changes")
    .select("unit_id, proposed_rate")
    .eq("company_id", companyId)
    .eq("status", "pending")
    .returns<{ unit_id: string; proposed_rate: string }[]>();

  const pendingRate = new Map(
    (pendingRates ?? []).map((row) => [row.unit_id, Number(row.proposed_rate)]),
  );

  // Private bucket, so every thumbnail needs a short-lived signed URL.
  const photoPaths = (units ?? []).flatMap((unit) =>
    (unit.unit_photos ?? []).map((photo) => photo.storage_path),
  );
  const signedUrls = new Map<string, string>();
  if (photoPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("unit-photos")
      .createSignedUrls(photoPaths, 3600);
    for (const entry of signed ?? []) {
      if (entry.path && entry.signedUrl) signedUrls.set(entry.path, entry.signedUrl);
    }
  }

  return (
    <>
      <PageHeader
        title={location.name}
        description={`${TYPE_LABELS[location.property_type] ?? location.property_type} · ${
          location.address ?? "No address on file"
        }`}
        action={
          <Link href="/properties" className="btn btn-secondary btn-sm">
            Back to properties
          </Link>
        }
      />

      {canEditUnits ? (
        <div id="add-unit" className="mb-6" style={{ scrollMarginTop: "1rem" }}>
          <Card
            title="Add a unit"
            description="Sub-meter serials feed the utility computation in Phase 3."
          >
            <UnitForm
              action={createUnit}
              locationId={locationId}
              companyId={companyId}
              submitLabel="Create unit"
              onRecordPhoto={recordUnitPhoto}
            />
          </Card>
        </div>
      ) : null}

      <Card
        title={`${units?.length ?? 0} unit${units?.length === 1 ? "" : "s"}`}
        bodyClassName=""
      >
        {units && units.length > 0 ? (
          <div className="flex flex-col">
            {units.map((unit) => {
              const activeContract = (unit.contract_units ?? [])
                .map((link) => link.contracts)
                .find(
                  (contract) =>
                    contract?.status === "active" || contract?.status === "draft",
                );
              const everContracted = (unit.contract_units ?? []).length > 0;

              return (
                <details
                  key={unit.id}
                  className="border-b last:border-b-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <summary className="cursor-pointer px-5 py-3.5 flex items-center justify-between gap-3 flex-wrap">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="badge">{unit.code}</span>
                      <span className="font-semibold text-sm tabular-nums">
                        {money(unit.monthly_rate)}
                      </span>
                      {/* A rate nobody has agreed yet is not the rate. */}
                      {pendingRate.get(unit.id) !== undefined ? (
                        <span
                          className="text-xs"
                          style={{ color: "var(--color-gold-500)" }}
                        >
                          {money(pendingRate.get(unit.id)!)} awaiting approval
                        </span>
                      ) : null}
                      {unit.area_sqm ? (
                        <span className="text-xs muted">{unit.area_sqm} sqm</span>
                      ) : null}
                      {activeContract?.tenants ? (
                        <span className="text-xs muted">
                          · {activeContract.tenants.company_name}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={STATUS_STYLES[unit.status] ?? "badge"}>
                        {unit.status}
                      </span>
                      <span className="text-xs muted">
                        {canEditUnits ? "Edit" : "Details"}
                      </span>
                    </span>
                  </summary>

                  <div className="px-5 pb-5 flex flex-col gap-5">
                    {canEditUnits ? (
                      <UnitForm
                        action={updateUnit}
                        locationId={locationId}
                        companyId={companyId}
                        unit={unit}
                        submitLabel="Save unit"
                        onRecordPhoto={recordUnitPhoto}
                      />
                    ) : (
                      <dl className="grid gap-3 sm:grid-cols-3 text-sm">
                        <div>
                          <dt className="label">Floor</dt>
                          <dd>{unit.floor ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="label">Water meter</dt>
                          <dd>{unit.water_meter_serial ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="label">Electric meter</dt>
                          <dd>{unit.electric_meter_serial ?? "—"}</dd>
                        </div>
                        <div className="sm:col-span-3">
                          <dt className="label">Appliances</dt>
                          <dd>
                            {unit.appliances.length > 0
                              ? unit.appliances.join(", ")
                              : "—"}
                          </dd>
                        </div>
                      </dl>
                    )}

                    <div>
                      <p className="label">Photos</p>
                      {unit.unit_photos && unit.unit_photos.length > 0 ? (
                        <div className="flex gap-3 flex-wrap mb-3">
                          {unit.unit_photos.map((photo) => (
                            <figure key={photo.id} className="w-40">
                              {signedUrls.get(photo.storage_path) ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={signedUrls.get(photo.storage_path)}
                                  alt={photo.caption ?? `Unit ${unit.code}`}
                                  className="w-40 h-28 object-cover rounded-lg border"
                                  style={{ borderColor: "var(--border)" }}
                                />
                              ) : (
                                <div
                                  className="w-40 h-28 rounded-lg border grid place-items-center text-xs muted"
                                  style={{ borderColor: "var(--border)" }}
                                >
                                  Unavailable
                                </div>
                              )}
                              {canEditUnits ? (
                                <form action={deleteUnitPhoto} className="mt-1">
                                  <input type="hidden" name="id" value={photo.id} />
                                  <input
                                    type="hidden"
                                    name="locationId"
                                    value={locationId}
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-danger btn-sm w-full"
                                  >
                                    Remove
                                  </button>
                                </form>
                              ) : null}
                            </figure>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm muted mb-3">No photos yet.</p>
                      )}

                      {canEditUnits ? (
                        <UnitPhotoUploader
                          unitId={unit.id}
                          companyId={companyId}
                          locationId={locationId}
                          onRecord={recordUnitPhoto}
                        />
                      ) : null}
                    </div>

                    {canEditUnits ? (
                      <div className="flex gap-2 flex-wrap">
                        {!activeContract ? (
                          <form action={setUnitInactive}>
                            <input type="hidden" name="id" value={unit.id} />
                            <input
                              type="hidden"
                              name="locationId"
                              value={locationId}
                            />
                            <input
                              type="hidden"
                              name="inactive"
                              value={String(unit.status !== "inactive")}
                            />
                            <button type="submit" className="btn btn-secondary btn-sm">
                              {unit.status === "inactive"
                                ? "Return to vacant pool"
                                : "Retire unit"}
                            </button>
                          </form>
                        ) : (
                          <p className="text-xs muted">
                            On contract {activeContract.contract_no} — end or
                            terminate it before retiring this unit.
                          </p>
                        )}

                        {canDeleteUnits && !everContracted ? (
                          <form action={deleteUnit}>
                            <input type="hidden" name="id" value={unit.id} />
                            <input
                              type="hidden"
                              name="locationId"
                              value={locationId}
                            />
                            <button type="submit" className="btn btn-danger btn-sm">
                              Delete unit
                            </button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <EmptyState>
            No units in this location yet
            {canEditUnits ? " — add the first one above." : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
