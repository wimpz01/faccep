import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createComplaint, updateComplaint } from "../actions";
import { COMPLAINT_STATUS_BADGE } from "../constants";
import { ComplaintForm, ComplaintUpdateForm, type UnitOption } from "../crm-forms";

export const metadata: Metadata = { title: "Complaints" };

type ComplaintRow = {
  id: string;
  complaint_no: string;
  subject: string;
  details: string | null;
  status: string;
  reported_on: string;
  resolved_on: string | null;
  resolution: string | null;
  tenants: { company_name: string } | null;
  units: { code: string } | null;
  complaint_updates: { id: string; note: string; created_at: string }[];
};

export default async function ComplaintsPage() {
  const context = await requirePermission(MODULE.crmComplaints, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.crmComplaints, "edit");

  const supabase = await createClient();
  const [{ data: complaints }, { data: tenants }, { data: units }] =
    await Promise.all([
      supabase
        .from("complaints")
        .select(
          "id, complaint_no, subject, details, status, reported_on, resolved_on, resolution, tenants(company_name), units(code), complaint_updates(id, note, created_at)",
        )
        .eq("company_id", companyId)
        .order("reported_on", { ascending: false })
        .limit(150)
        .returns<ComplaintRow[]>(),
      supabase
        .from("tenants")
        .select("id, company_name")
        .eq("company_id", companyId)
        .order("company_name"),
      supabase
        .from("units")
        .select("id, code, monthly_rate, locations(name)")
        .eq("company_id", companyId)
        .neq("status", "inactive")
        .order("code")
        .returns<
          {
            id: string;
            code: string;
            monthly_rate: string;
            locations: { name: string } | null;
          }[]
        >(),
    ]);

  const unitOptions: UnitOption[] = (units ?? []).map((unit) => ({
    id: unit.id,
    code: unit.code,
    monthly_rate: unit.monthly_rate,
    locationName: unit.locations?.name ?? "",
  }));

  const rows = complaints ?? [];
  const open = rows.filter(
    (row) => row.status === "open" || row.status === "in_progress",
  );

  return (
    <>
      <PageHeader
        title="Complaints"
        description="Every complaint stays open until somebody records how it was resolved."
        action={
          <Link href="/crm/inquiries" className="btn btn-secondary btn-sm">
            Inquiries
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile label="Open" value={open.length} hint="Awaiting resolution" />
        <StatTile
          label="Resolved"
          value={rows.filter((row) => row.status === "resolved").length}
          hint="Fixed, not yet closed"
        />
        <StatTile label="Logged" value={rows.length} hint="All time" />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card title="Log a complaint">
            <ComplaintForm
              action={createComplaint}
              tenants={tenants ?? []}
              units={unitOptions}
            />
          </Card>
        </div>
      ) : null}

      <Card title="Complaints" bodyClassName="">
        {rows.length > 0 ? (
          <div className="flex flex-col">
            {rows.map((complaint) => (
              <details
                key={complaint.id}
                className="border-b last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <summary className="cursor-pointer px-5 py-3.5 flex items-center justify-between gap-3 flex-wrap">
                  <span>
                    <span className="badge mr-2">{complaint.complaint_no}</span>
                    <span className="font-semibold text-sm">{complaint.subject}</span>
                    <span className="text-xs muted ml-2">
                      {complaint.tenants?.company_name ?? "—"}
                      {complaint.units?.code ? ` · ${complaint.units.code}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs muted">
                      {formatDate(complaint.reported_on)}
                    </span>
                    <span
                      className={COMPLAINT_STATUS_BADGE[complaint.status] ?? "badge"}
                    >
                      {complaint.status.replace("_", " ")}
                    </span>
                  </span>
                </summary>

                <div className="px-5 pb-5 flex flex-col gap-4">
                  {complaint.details ? (
                    <p className="text-sm">{complaint.details}</p>
                  ) : null}

                  {complaint.resolution ? (
                    <p className="text-sm">
                      <strong>Resolution:</strong> {complaint.resolution}
                      {complaint.resolved_on
                        ? ` (${formatDate(complaint.resolved_on)})`
                        : ""}
                    </p>
                  ) : null}

                  {(complaint.complaint_updates ?? []).length > 0 ? (
                    <div>
                      <p className="label">Follow-ups</p>
                      <ul className="text-sm flex flex-col gap-1">
                        {[...complaint.complaint_updates]
                          .sort((a, b) => b.created_at.localeCompare(a.created_at))
                          .map((update) => (
                            <li key={update.id}>
                              {update.note}{" "}
                              <span className="text-xs muted">
                                — {formatDate(update.created_at)}
                              </span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : null}

                  {canEdit ? (
                    <ComplaintUpdateForm
                      action={updateComplaint}
                      complaintId={complaint.id}
                      status={complaint.status}
                      resolution={complaint.resolution}
                    />
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <EmptyState>No complaints logged.</EmptyState>
        )}
      </Card>
    </>
  );
}
