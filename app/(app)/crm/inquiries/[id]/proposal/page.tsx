import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth";
import { escalatedAmount } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { ProposalView, type ProposalData } from "./proposal-view";

export const metadata: Metadata = { title: "Proposal" };

type InquiryRow = {
  id: string;
  company_id: string;
  inquiry_no: string;
  company_name: string | null;
  contact_person: string;
  email: string | null;
  mobile_number: string | null;
  requirement: string | null;
  proposed_rent: string | null;
  proposed_term_years: number | null;
  units: {
    code: string;
    area_sqm: string | null;
    monthly_rate: string;
    description: string | null;
    appliances: string[];
    locations: { code: string; name: string; address: string | null } | null;
  } | null;
};

export default async function ProposalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.crmInquiries, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const [{ data: inquiry }, { data: company }] = await Promise.all([
    supabase
      .from("inquiries")
      .select(
        `id, company_id, inquiry_no, company_name, contact_person, email, mobile_number,
         requirement, proposed_rent, proposed_term_years,
         units(code, area_sqm, monthly_rate, description, appliances,
               locations(code, name, address))`,
      )
      .eq("id", id)
      .maybeSingle<InquiryRow>(),
    supabase
      .from("companies")
      .select("name, legal_name, address, contact_number, email")
      .eq("id", companyId)
      .single(),
  ]);

  if (!inquiry || inquiry.company_id !== companyId) notFound();

  const rent = Number(inquiry.proposed_rent ?? inquiry.units?.monthly_rate ?? 0);
  const term = inquiry.proposed_term_years ?? 1;

  const data: ProposalData = {
    inquiryNo: inquiry.inquiry_no,
    prospect: {
      contactPerson: inquiry.contact_person,
      companyName: inquiry.company_name,
      email: inquiry.email,
      mobile: inquiry.mobile_number,
    },
    company: {
      name: company?.legal_name ?? company?.name ?? "",
      address: company?.address ?? null,
      contactNumber: company?.contact_number ?? null,
      email: company?.email ?? null,
    },
    unit: inquiry.units
      ? {
          code: inquiry.units.code,
          areaSqm: inquiry.units.area_sqm,
          description: inquiry.units.description,
          appliances: inquiry.units.appliances ?? [],
          locationName: inquiry.units.locations?.name ?? "",
          locationAddress: inquiry.units.locations?.address ?? null,
        }
      : null,
    rent,
    termYears: term,
    // Indicative schedule at the standard 5% escalation, shown as an example.
    schedule: Array.from({ length: Math.min(term, 5) }, (_, index) => ({
      year: index + 1,
      rent: escalatedAmount(rent, 5, index),
    })),
    requirement: inquiry.requirement,
  };

  return (
    <>
      <div className="no-print mb-4">
        <Link
          href={`/crm/inquiries/${inquiry.id}`}
          className="btn btn-secondary btn-sm"
        >
          Back to inquiry
        </Link>
      </div>
      <ProposalView data={data} />
    </>
  );
}
