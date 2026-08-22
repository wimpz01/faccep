import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createLocation, setLocationActive, updateLocation } from "./actions";
import { PROPERTY_TYPES } from "./constants";
import { LocationForm } from "./location-form";

export const metadata: Metadata = { title: "Locations" };

type LocationRow = {
  id: string;
  code: string;
  invoice_prefix: string;
  name: string;
  property_type: string;
  address: string | null;
  is_active: boolean;
};

const TYPE_LABELS = Object.fromEntries(
  PROPERTY_TYPES.map((type) => [type.value, type.label]),
);

export default async function LocationsPage() {
  const context = await requirePermission(MODULE.adminLocations, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.adminLocations, "edit");

  const supabase = await createClient();
  const { data: locations } = await supabase
    .from("locations")
    .select("id, code, invoice_prefix, name, property_type, address, is_active")
    .eq("company_id", companyId)
    .order("code")
    .returns<LocationRow[]>();

  return (
    <>
      <PageHeader
        title="Locations"
        description={`Buildings and properties owned by ${context.activeCompany!.companyName}.`}
        action={
          canEdit ? (
            <Link href="/portfolio/locations/import" className="btn btn-secondary btn-sm">
              Import locations
            </Link>
          ) : undefined
        }
      />

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Add a location"
            description="Units, tenants and billing all hang off a location."
          >
            <LocationForm action={createLocation} submitLabel="Create location" />
          </Card>
        </div>
      ) : null}

      <Card title="All locations" bodyClassName="">
        {locations && locations.length > 0 ? (
          <div className="flex flex-col">
            {locations.map((location) => (
              <details
                key={location.id}
                className="border-b last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <summary className="cursor-pointer px-5 py-3.5 flex items-center justify-between gap-3 flex-wrap">
                  <span>
                    <span className="badge mr-2">{location.code}</span>
                    <span className="font-semibold text-sm">{location.name}</span>
                    <span className="text-xs muted ml-2">
                      {TYPE_LABELS[location.property_type] ?? location.property_type}
                      {" · bills as "}
                      {location.invoice_prefix}-
                      {String(new Date().getFullYear()).slice(2)}-00001
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {location.is_active ? (
                      <span className="badge badge-brand">Active</span>
                    ) : (
                      <span className="badge">Inactive</span>
                    )}
                    <span className="text-xs muted">
                      {canEdit ? "Edit" : "Details"}
                    </span>
                  </span>
                </summary>

                <div className="px-5 pb-5">
                  {canEdit ? (
                    <>
                      <LocationForm
                        action={updateLocation}
                        location={location}
                        submitLabel="Save changes"
                      />
                      <form action={setLocationActive} className="mt-4">
                        <input type="hidden" name="id" value={location.id} />
                        <input
                          type="hidden"
                          name="is_active"
                          value={String(!location.is_active)}
                        />
                        <button type="submit" className="btn btn-danger btn-sm">
                          {location.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                      </form>
                    </>
                  ) : (
                    <p className="text-sm">{location.address ?? "No address on file."}</p>
                  )}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <EmptyState>
            No locations yet
            {canEdit ? " — add the first one above." : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
