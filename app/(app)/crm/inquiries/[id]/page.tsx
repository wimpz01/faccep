import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { updateInquiryStatus } from "../../actions";
import { INQUIRY_STATUS_BADGE } from "../../constants";
import { InquiryStatusForm } from "../../crm-forms";

export const metadata: Metadata = { title: "Inquiry" };

type InquiryDetail = {
  id: string;
  company_id: string;
  inquiry_no: string;
  company_name: string | null;
  contact_person: string;
  mobile_number: string | null;
  email: string | null;
  requirement: string | null;
  source: string | null;
  status: string;
  follow_up_on: string | null;
  proposed_rent: string | null;
  proposed_term_years: number | null;
  created_at: string;
  units: {
    id: string;
    code: string;
    area_sqm: string | null;
    monthly_rate: string;
    locations: { code: string; name: string } | null;
  } | null;
  inquiry_notes: { id: string; note: string; created_at: string }[];
};

export default async function InquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.crmInquiries, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.crmInquiries, "edit");

  const supabase = await createClient();
  const { data: inquiry } = await supabase
    .from("inquiries")
    .select(
      `*, units(id, code, area_sqm, monthly_rate, locations(code, name)),
       inquiry_notes(id, note, created_at)`,
    )
    .eq("id", id)
    .maybeSingle<InquiryDetail>();

  if (!inquiry || inquiry.company_id !== companyId) notFound();

  const notes = [...(inquiry.inquiry_notes ?? [])].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  return (
    <>
      <PageHeader
        title={`${inquiry.inquiry_no} — ${inquiry.contact_person}`}
        description={inquiry.company_name ?? undefined}
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/crm/inquiries" className="btn btn-secondary btn-sm">
              Back
            </Link>
            <Link
              href={`/crm/inquiries/${inquiry.id}/proposal`}
              className="btn btn-primary btn-sm"
            >
              Proposal
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span className={INQUIRY_STATUS_BADGE[inquiry.status] ?? "badge"}>
                {inquiry.status.replace("_", " ")}
              </span>
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Contact
            </p>
            <p className="text-sm mt-1">{inquiry.mobile_number ?? "—"}</p>
            <p className="text-xs muted break-all">{inquiry.email ?? ""}</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Unit of interest
            </p>
            <p className="text-sm mt-1">
              {inquiry.units
                ? `${inquiry.units.locations?.code} · ${inquiry.units.code}`
                : "Not decided"}
            </p>
            {inquiry.units?.area_sqm ? (
              <p className="text-xs muted">{Number(inquiry.units.area_sqm)} sqm</p>
            ) : null}
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Proposed
            </p>
            <p
              className="text-lg font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {inquiry.proposed_rent ? money(inquiry.proposed_rent) : "—"}
            </p>
            <p className="text-xs muted">
              {inquiry.proposed_term_years ?? 1} year term
            </p>
          </div>
        </div>
      </div>

      {inquiry.requirement ? (
        <div className="mb-6">
          <Card title="What they are looking for">
            <p className="text-sm">{inquiry.requirement}</p>
            {inquiry.source ? (
              <p className="text-xs muted mt-2">Source: {inquiry.source}</p>
            ) : null}
          </Card>
        </div>
      ) : null}

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Move it on"
            description="Setting a follow-up date puts it on the chase list."
          >
            <InquiryStatusForm
              action={updateInquiryStatus}
              inquiryId={inquiry.id}
              status={inquiry.status}
              followUp={inquiry.follow_up_on}
            />
          </Card>
        </div>
      ) : null}

      <Card title="History" bodyClassName="">
        {notes.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <tbody>
                {notes.map((note) => (
                  <tr key={note.id}>
                    <td>
                      <p className="text-sm">{note.note}</p>
                      <p className="text-xs muted">
                        {formatDateTime(note.created_at)}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            Nothing logged yet — inquiry raised {formatDate(inquiry.created_at)}.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
