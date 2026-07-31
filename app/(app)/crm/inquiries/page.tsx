import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createInquiry } from "../actions";
import { INQUIRY_STATUS_BADGE as STATUS_BADGE } from "../constants";
import { InquiryForm, type UnitOption } from "../crm-forms";

export const metadata: Metadata = { title: "Inquiries" };

type InquiryRow = {
  id: string;
  inquiry_no: string;
  company_name: string | null;
  contact_person: string;
  mobile_number: string | null;
  status: string;
  follow_up_on: string | null;
  proposed_rent: string | null;
  created_at: string;
  units: { code: string } | null;
};

export default async function InquiriesPage() {
  const context = await requirePermission(MODULE.crmInquiries, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.crmInquiries, "edit");

  const supabase = await createClient();
  const [{ data: inquiries }, { data: units }] = await Promise.all([
    supabase
      .from("inquiries")
      .select(
        "id, inquiry_no, company_name, contact_person, mobile_number, status, follow_up_on, proposed_rent, created_at, units(code)",
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(150)
      .returns<InquiryRow[]>(),
    supabase
      .from("units")
      .select("id, code, monthly_rate, locations(name)")
      .eq("company_id", companyId)
      .eq("status", "vacant")
      .order("code")
      .returns<
        { id: string; code: string; monthly_rate: string; locations: { name: string } | null }[]
      >(),
  ]);

  const unitOptions: UnitOption[] = (units ?? []).map((unit) => ({
    id: unit.id,
    code: unit.code,
    monthly_rate: unit.monthly_rate,
    locationName: unit.locations?.name ?? "",
  }));

  const rows = inquiries ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const openRows = rows.filter((row) => row.status !== "won" && row.status !== "lost");
  const dueFollowUps = openRows.filter(
    (row) => row.follow_up_on && row.follow_up_on <= today,
  );

  return (
    <>
      <PageHeader
        title="Inquiries"
        description="Prospects, where each one has got to, and when to chase them."
        action={
          <Link href="/crm/complaints" className="btn btn-secondary btn-sm">
            Complaints
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <StatTile label="Open" value={openRows.length} hint="Still in play" />
        <StatTile
          label="Follow-ups due"
          value={dueFollowUps.length}
          hint="Today or overdue"
        />
        <StatTile
          label="Won"
          value={rows.filter((row) => row.status === "won").length}
          hint="Converted to tenants"
        />
        <StatTile label="Vacant units" value={unitOptions.length} hint="To offer" />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Log an inquiry"
            description="Picking a unit pre-fills the proposed rent from its listed rate."
          >
            <InquiryForm action={createInquiry} units={unitOptions} />
          </Card>
        </div>
      ) : null}

      <Card title="Inquiries" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Inquiry</th>
                  <th>Contact</th>
                  <th>Unit</th>
                  <th>Follow up</th>
                  <th className="text-right">Proposed rent</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((inquiry) => {
                  const overdue =
                    inquiry.follow_up_on &&
                    inquiry.follow_up_on <= today &&
                    inquiry.status !== "won" &&
                    inquiry.status !== "lost";
                  return (
                    <tr key={inquiry.id}>
                      <td>
                        <Link
                          href={`/crm/inquiries/${inquiry.id}`}
                          className="font-semibold"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {inquiry.inquiry_no}
                        </Link>
                        <p className="text-xs muted">
                          {formatDate(inquiry.created_at)}
                        </p>
                      </td>
                      <td className="text-sm">
                        {inquiry.contact_person}
                        {inquiry.company_name ? (
                          <p className="text-xs muted">{inquiry.company_name}</p>
                        ) : null}
                        {inquiry.mobile_number ? (
                          <p className="text-xs muted">{inquiry.mobile_number}</p>
                        ) : null}
                      </td>
                      <td className="text-xs">{inquiry.units?.code ?? "—"}</td>
                      <td className="text-xs">
                        {formatDate(inquiry.follow_up_on)}
                        {overdue ? (
                          <p style={{ color: "var(--danger)" }}>due</p>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">
                        {inquiry.proposed_rent ? money(inquiry.proposed_rent) : "—"}
                      </td>
                      <td>
                        <span className={STATUS_BADGE[inquiry.status] ?? "badge"}>
                          {inquiry.status.replace("_", " ")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No inquiries logged yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
