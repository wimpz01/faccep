import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { DocumentView, type DocumentData } from "./document-view";

export const metadata: Metadata = { title: "Contract document" };

type ContractDocRow = {
  id: string;
  company_id: string;
  contract_no: string;
  status: string;
  start_date: string;
  end_date: string;
  term_years: number;
  monthly_rent: string;
  security_deposit: string;
  advance_payment: string;
  escalation_rate: string;
  rent_due_day: number;
  penalty_rate: string;
  water_billing_type: string;
  water_fixed_amount: string | null;
  water_minimum_amount: string | null;
  electric_billing_type: string;
  electric_fixed_amount: string | null;
  electric_minimum_amount: string | null;
  repair_responsibility: string | null;
  renewal_terms: string | null;
  termination_grounds: string | null;
  tenants: {
    company_name: string;
    address: string | null;
    contact_person: string | null;
    tin: string | null;
    is_vatable: boolean;
  } | null;
  contract_units: {
    units: { code: string; area_sqm: string | null; locations: { name: string } | null } | null;
  }[];
  contract_inclusions: {
    inclusion: string;
    label: string | null;
    amount: string | null;
    sort_order: number;
  }[];
};

export default async function ContractDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.contracts, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();

  const [{ data: contract }, { data: company }] = await Promise.all([
    supabase
      .from("contracts")
      .select(
        `id, company_id, contract_no, status, start_date, end_date, term_years,
         monthly_rent, security_deposit, advance_payment, escalation_rate,
         rent_due_day, penalty_rate,
         water_billing_type, water_fixed_amount, water_minimum_amount,
         electric_billing_type, electric_fixed_amount, electric_minimum_amount,
         repair_responsibility, renewal_terms, termination_grounds,
         tenants(company_name, address, contact_person, tin, is_vatable),
         contract_units(units(code, area_sqm, locations(name))),
         contract_inclusions(inclusion, label, amount, sort_order)`,
      )
      .eq("id", id)
      .maybeSingle<ContractDocRow>(),
    supabase
      .from("companies")
      .select("name, legal_name, address, tin")
      .eq("id", companyId)
      .single(),
  ]);

  if (!contract || contract.company_id !== companyId) notFound();

  const data: DocumentData = {
    contractNo: contract.contract_no,
    status: contract.status,
    company: {
      name: company?.name ?? "",
      legalName: company?.legal_name ?? null,
      address: company?.address ?? null,
      tin: company?.tin ?? null,
    },
    tenant: {
      companyName: contract.tenants?.company_name ?? "",
      address: contract.tenants?.address ?? null,
      contactPerson: contract.tenants?.contact_person ?? null,
      tin: contract.tenants?.tin ?? null,
      isVatable: contract.tenants?.is_vatable ?? false,
    },
    units: (contract.contract_units ?? [])
      .map((link) => link.units)
      .filter((unit): unit is NonNullable<typeof unit> => Boolean(unit))
      .map((unit) => ({
        code: unit.code,
        areaSqm: unit.area_sqm,
        locationName: unit.locations?.name ?? "",
      })),
    inclusions: [...(contract.contract_inclusions ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        inclusion: item.inclusion,
        label: item.label,
        amount: item.amount,
      })),
    startDate: contract.start_date,
    endDate: contract.end_date,
    termYears: contract.term_years,
    monthlyRent: Number(contract.monthly_rent),
    securityDeposit: Number(contract.security_deposit),
    advancePayment: Number(contract.advance_payment),
    escalationRate: Number(contract.escalation_rate),
    rentDueDay: contract.rent_due_day,
    penaltyRate: Number(contract.penalty_rate),
    waterBillingType: contract.water_billing_type,
    waterFixedAmount:
      contract.water_fixed_amount === null ? null : Number(contract.water_fixed_amount),
    waterMinimumAmount:
      contract.water_minimum_amount === null
        ? null
        : Number(contract.water_minimum_amount),
    electricBillingType: contract.electric_billing_type,
    electricFixedAmount:
      contract.electric_fixed_amount === null
        ? null
        : Number(contract.electric_fixed_amount),
    electricMinimumAmount:
      contract.electric_minimum_amount === null
        ? null
        : Number(contract.electric_minimum_amount),
    repairResponsibility: contract.repair_responsibility,
    renewalTerms: contract.renewal_terms,
    terminationGrounds: contract.termination_grounds,
  };

  return (
    <>
      <div className="no-print mb-4">
        <Link href={`/contracts/${contract.id}`} className="btn btn-secondary btn-sm">
          Back to contract
        </Link>
      </div>
      <DocumentView data={data} />
    </>
  );
}
