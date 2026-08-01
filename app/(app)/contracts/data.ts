import "server-only";

import { createClient } from "@/lib/supabase/server";

import type { TenantOption, UnitOption } from "./contract-form";

type UnitJoin = {
  id: string;
  code: string;
  monthly_rate: string;
  status: string;
  locations: { name: string } | null;
};

/**
 * Tenants and units offered by the contract form.
 *
 * Units already occupied are still listed when they belong to the contract
 * being edited, so reopening a saved contract does not silently drop them.
 */
export async function loadContractOptions(
  companyId: string,
  includeUnitIds: string[] = [],
) {
  const supabase = await createClient();

  const [{ data: tenants }, { data: units }] = await Promise.all([
    supabase
      .from("tenants")
      .select("id, company_name")
      .eq("company_id", companyId)
      .neq("status", "blacklisted")
      .order("company_name")
      .returns<TenantOption[]>(),
    supabase
      .from("units")
      .select("id, code, monthly_rate, status, locations(name)")
      .eq("company_id", companyId)
      .neq("status", "inactive")
      .order("code")
      .returns<UnitJoin[]>(),
  ]);

  const unitOptions: UnitOption[] = (units ?? [])
    .filter(
      (unit) => unit.status !== "occupied" || includeUnitIds.includes(unit.id),
    )
    .map((unit) => ({
      id: unit.id,
      code: unit.code,
      monthly_rate: unit.monthly_rate,
      status: unit.status,
      locationName: unit.locations?.name ?? "Unassigned",
    }));

  return { tenants: tenants ?? [], units: unitOptions };
}

