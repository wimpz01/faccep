import type { Metadata } from "next";

import { ReportShell } from "@/components/report-shell";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money, monthsUntil } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Tenants & deposits" };

type ContractRow = {
  id: string;
  contract_no: string;
  status: string;
  start_date: string;
  end_date: string;
  monthly_rent: string;
  security_deposit: string;
  advance_payment: string;
  tenants: { company_name: string; is_vatable: boolean } | null;
  contract_units: {
    units: { code: string; locations: { code: string; name: string } | null } | null;
  }[];
};

type UnitRow = {
  id: string;
  code: string;
  monthly_rate: string;
  area_sqm: string | null;
  status: string;
  locations: { code: string; name: string } | null;
};

export default async function TenantsReport() {
  const context = await requirePermission(MODULE.reportsTenants, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const [{ data: contracts }, { data: units }] = await Promise.all([
    supabase
      .from("contracts")
      .select(
        `id, contract_no, status, start_date, end_date, monthly_rent,
         security_deposit, advance_payment,
         tenants(company_name, is_vatable),
         contract_units(units(code, locations(code, name)))`,
      )
      .eq("company_id", companyId)
      .eq("status", "active")
      .order("end_date")
      .returns<ContractRow[]>(),
    supabase
      .from("units")
      .select("id, code, monthly_rate, area_sqm, status, locations(code, name)")
      .eq("company_id", companyId)
      .eq("status", "vacant")
      .order("code")
      .returns<UnitRow[]>(),
  ]);

  const active = contracts ?? [];
  const vacant = units ?? [];

  const totalRent = round2(
    active.reduce((sum, row) => sum + Number(row.monthly_rent), 0),
  );
  const totalDeposits = round2(
    active.reduce((sum, row) => sum + Number(row.security_deposit), 0),
  );

  // Deposits grouped by location, as spec 13 asks for.
  const depositsByLocation = new Map<string, number>();
  for (const contract of active) {
    const location =
      contract.contract_units?.[0]?.units?.locations?.code ?? "Unattributed";
    depositsByLocation.set(
      location,
      round2(
        (depositsByLocation.get(location) ?? 0) + Number(contract.security_deposit),
      ),
    );
  }

  return (
    <ReportShell
      title="Tenants & deposits"
      description="Active tenants, the deposits held against them, and what is currently available to let."
      showRange={false}
    >
      <div className="grid gap-4 sm:grid-cols-4 mb-5">
        <StatTile label="Active tenants" value={active.length} hint="Live contracts" />
        <StatTile label="Monthly rent" value={money(totalRent)} tone="money" hint="Contracted" />
        <StatTile
          label="Deposits held"
          value={money(totalDeposits)}
          hint="Refundable liability"
        />
        <StatTile label="Vacant units" value={vacant.length} hint="Available now" />
      </div>

      <div className="mb-5">
        <Card title="Active tenants" bodyClassName="">
          {active.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Contract</th>
                    <th>Units</th>
                    <th>Term ends</th>
                    <th>VAT</th>
                    <th className="text-right">Monthly rent</th>
                    <th className="text-right">Deposit</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((contract) => {
                    const months = monthsUntil(contract.end_date);
                    return (
                      <tr key={contract.id}>
                        <td className="text-sm">{contract.tenants?.company_name}</td>
                        <td className="text-xs">{contract.contract_no}</td>
                        <td className="text-xs">
                          {(contract.contract_units ?? [])
                            .map((link) => link.units?.code)
                            .filter(Boolean)
                            .join(", ") || "—"}
                        </td>
                        <td className="text-xs">
                          {formatDate(contract.end_date)}
                          {months !== null && months <= 6 ? (
                            <p style={{ color: "var(--danger)" }}>
                              {months <= 0 ? "expired" : `${months} month(s)`}
                            </p>
                          ) : null}
                        </td>
                        <td className="text-xs">
                          {contract.tenants?.is_vatable ? "VATable" : "Non-VAT"}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(contract.monthly_rent)}
                        </td>
                        <td className="text-right tabular-nums">
                          {money(contract.security_deposit)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td colSpan={5} className="text-right font-bold">
                      Total
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(totalRent)}
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(totalDeposits)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No active contracts.</EmptyState>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Security deposits by location" bodyClassName="">
          {depositsByLocation.size > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="text-right">Deposits held</th>
                  </tr>
                </thead>
                <tbody>
                  {[...depositsByLocation.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([location, amount]) => (
                      <tr key={location}>
                        <td className="text-sm">{location}</td>
                        <td className="text-right tabular-nums">{money(amount)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No deposits recorded.</EmptyState>
          )}
        </Card>

        <Card title="Available units" bodyClassName="">
          {vacant.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Location</th>
                    <th className="text-right">Area</th>
                    <th className="text-right">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {vacant.map((unit) => (
                    <tr key={unit.id}>
                      <td className="text-sm">{unit.code}</td>
                      <td className="text-xs">{unit.locations?.code}</td>
                      <td className="text-right tabular-nums">
                        {unit.area_sqm ? `${Number(unit.area_sqm)} sqm` : "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(unit.monthly_rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>Everything is let.</EmptyState>
          )}
        </Card>
      </div>
    </ReportShell>
  );
}
