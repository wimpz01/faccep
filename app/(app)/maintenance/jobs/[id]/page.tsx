import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  advanceJob,
  approveProgress,
  certifyProgress,
  closeMaterialRequest,
  createMaterialRequest,
  issueMaterialRequest,
  recordJobPhoto,
} from "../../actions";
import { JOB_FLOW } from "../../constants";
import {
  AdvanceForm,
  IssueForm,
  JobPhotoUploader,
  MaterialRequestForm,
  ProgressForm,
  UsageChecklistForm,
} from "../../job-forms";

export const metadata: Metadata = { title: "Repair job" };

type JobDetail = {
  id: string;
  company_id: string;
  job_no: string;
  title: string;
  description: string | null;
  status: string;
  job_kind: string;
  assigned_to: string | null;
  reported_at: string;
  scheduled_for: string | null;
  completed_at: string | null;
  contract_amount: string;
  actual_cost: string;
  locations: { code: string; name: string } | null;
  vendors: { name: string } | null;
  maintenance_job_photos: {
    id: string;
    stage: string;
    storage_path: string;
    caption: string | null;
  }[];
  maintenance_progress: {
    id: string;
    percent_complete: string;
    tranche_amount: string;
    note: string | null;
    status: string;
    created_at: string;
  }[];
};

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.maintenanceRepairs, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.maintenanceRepairs, "edit");
  const canRequestMaterials = can(
    context.permissions,
    MODULE.maintenanceMaterialRequests,
    "edit",
  );
  const canIssue = can(
    context.permissions,
    MODULE.maintenanceMaterialRequests,
    "approve",
  );
  const canCertify = can(
    context.permissions,
    MODULE.maintenanceProgressSignoff,
    "edit",
  );
  const canApproveProgress = can(
    context.permissions,
    MODULE.maintenanceProgressSignoff,
    "approve",
  );

  const supabase = await createClient();
  const { data: job } = await supabase
    .from("maintenance_jobs")
    .select(
      `*, locations(code, name), vendors(name),
       maintenance_job_photos(id, stage, storage_path, caption),
       maintenance_progress(id, percent_complete, tranche_amount, note, status, created_at)`,
    )
    .eq("id", id)
    .maybeSingle<JobDetail>();

  if (!job || job.company_id !== companyId) notFound();

  const [{ data: requests }, { data: items }] = await Promise.all([
    supabase
      .from("material_requests")
      .select(
        "id, request_no, status, created_at, material_request_lines(id, quantity_requested, quantity_issued, quantity_used, quantity_returned, inventory_items(name, unit_of_measure))",
      )
      .eq("job_id", id)
      .order("created_at")
      .returns<
        {
          id: string;
          request_no: string;
          status: string;
          created_at: string;
          material_request_lines: {
            id: string;
            quantity_requested: string;
            quantity_issued: string;
            quantity_used: string;
            quantity_returned: string;
            inventory_items: { name: string; unit_of_measure: string } | null;
          }[];
        }[]
      >(),
    canRequestMaterials
      ? supabase
          .from("inventory_items")
          .select("id, name, unit_of_measure, quantity_on_hand")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .order("name")
      : Promise.resolve({ data: [] }),
  ]);

  const photoPaths = (job.maintenance_job_photos ?? []).map((p) => p.storage_path);
  const signed = new Map<string, string>();
  if (photoPaths.length > 0) {
    const { data } = await supabase.storage
      .from("documents")
      .createSignedUrls(photoPaths, 3600);
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
    }
  }

  const currentIndex = JOB_FLOW.indexOf(job.status as never);
  const nextStatus = currentIndex >= 0 ? JOB_FLOW[currentIndex + 1] : undefined;
  const beforeCount = (job.maintenance_job_photos ?? []).filter(
    (p) => p.stage === "before",
  ).length;
  const afterCount = (job.maintenance_job_photos ?? []).filter(
    (p) => p.stage === "after",
  ).length;

  return (
    <>
      <PageHeader
        title={`${job.job_no} — ${job.title}`}
        description={`${job.locations?.code ?? "No location"} · reported ${formatDate(job.reported_at)}`}
        action={
          <Link href="/maintenance/jobs" className="btn btn-secondary btn-sm">
            Back
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span className="badge badge-brand">
                {job.status.replace("_", " ")}
              </span>
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Carried out by
            </p>
            <p className="text-sm font-medium mt-1">
              {job.job_kind === "contracted"
                ? (job.vendors?.name ?? "Contractor")
                : (job.assigned_to ?? "In-house")}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Contract amount
            </p>
            <p
              className="text-lg font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(job.contract_amount)}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Photos
            </p>
            <p className="text-sm font-medium mt-1">
              {beforeCount} before · {afterCount} after
            </p>
            {beforeCount === 0 || afterCount === 0 ? (
              <p className="text-xs" style={{ color: "var(--danger)" }}>
                Both are required to complete
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {job.description ? (
        <div className="mb-6">
          <Card title="Details">
            <p className="text-sm">{job.description}</p>
          </Card>
        </div>
      ) : null}

      {canEdit && nextStatus ? (
        <div className="mb-6">
          <Card
            title="Move the job on"
            description={
              nextStatus === "completed"
                ? "The database refuses this step until both a before and an after photo exist."
                : undefined
            }
          >
            <AdvanceForm
              action={advanceJob}
              jobId={job.id}
              next={nextStatus}
              label={`Mark ${nextStatus.replace("_", " ")}`}
            />
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card title="Photos">
          {(job.maintenance_job_photos ?? []).length > 0 ? (
            <div className="flex gap-3 flex-wrap mb-4">
              {job.maintenance_job_photos.map((photo) => (
                <figure key={photo.id} className="w-40">
                  {signed.get(photo.storage_path) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={signed.get(photo.storage_path)}
                      alt={photo.caption ?? photo.stage}
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
                  <figcaption className="text-xs muted mt-1">
                    <span className="badge">{photo.stage}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="text-sm muted mb-4">No photos yet.</p>
          )}

          {canEdit ? (
            <JobPhotoUploader
              jobId={job.id}
              companyId={companyId}
              onRecord={recordJobPhoto}
            />
          ) : null}
        </Card>
      </div>

      {job.job_kind === "in_house" ? (
        <div className="mb-6">
          <Card
            title="Materials"
            description="Issuing deducts stock. At close-off, whatever was not used goes back automatically."
            bodyClassName=""
          >
            <div className="card-body">
              {requests && requests.length > 0 ? (
                <div className="flex flex-col gap-5">
                  {requests.map((request) => (
                    <div key={request.id}>
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <span className="font-semibold text-sm">
                          {request.request_no}
                        </span>
                        <span className="badge">{request.status}</span>
                      </div>

                      {request.status === "issued" ? (
                        <UsageChecklistForm
                          action={closeMaterialRequest}
                          requestId={request.id}
                          lines={(request.material_request_lines ?? []).map((line) => ({
                            id: line.id,
                            name: line.inventory_items?.name ?? "Item",
                            unit: line.inventory_items?.unit_of_measure ?? "",
                            issued: Number(line.quantity_issued),
                          }))}
                        />
                      ) : (
                        <div className="table-scroll">
                          <table className="table">
                            <thead>
                              <tr>
                                <th>Item</th>
                                <th className="text-right">Requested</th>
                                <th className="text-right">Issued</th>
                                <th className="text-right">Used</th>
                                <th className="text-right">Returned</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(request.material_request_lines ?? []).map((line) => (
                                <tr key={line.id}>
                                  <td className="text-sm">
                                    {line.inventory_items?.name}
                                  </td>
                                  <td className="text-right tabular-nums">
                                    {Number(line.quantity_requested)}
                                  </td>
                                  <td className="text-right tabular-nums">
                                    {Number(line.quantity_issued)}
                                  </td>
                                  <td className="text-right tabular-nums">
                                    {Number(line.quantity_used)}
                                  </td>
                                  <td className="text-right tabular-nums">
                                    {Number(line.quantity_returned)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {request.status === "draft" && canIssue ? (
                        <div className="mt-2">
                          <IssueForm
                            action={issueMaterialRequest}
                            requestId={request.id}
                            label="Issue materials"
                          />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm muted">No material requests yet.</p>
              )}
            </div>

            {canRequestMaterials && (items ?? []).length > 0 ? (
              <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
                <p className="label">Raise a new request</p>
                <MaterialRequestForm
                  action={createMaterialRequest}
                  jobId={job.id}
                  items={items ?? []}
                />
              </div>
            ) : null}
          </Card>
        </div>
      ) : (
        <div className="mb-6">
          <Card
            title="Progress sign-off"
            description="Payables will not release a tranche without an approved percent-complete certificate."
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Certified</th>
                    <th className="text-right">% complete</th>
                    <th className="text-right">Tranche</th>
                    <th>Note</th>
                    <th>Status</th>
                    {canApproveProgress ? <th className="text-right">Decide</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {(job.maintenance_progress ?? []).length > 0 ? (
                    job.maintenance_progress.map((entry) => (
                      <tr key={entry.id}>
                        <td className="text-xs">{formatDate(entry.created_at)}</td>
                        <td className="text-right tabular-nums">
                          {Number(entry.percent_complete)}%
                        </td>
                        <td className="text-right tabular-nums">
                          {money(entry.tranche_amount)}
                        </td>
                        <td className="text-xs">{entry.note ?? "—"}</td>
                        <td>
                          <span
                            className="badge"
                            style={
                              entry.status === "approved"
                                ? { color: "var(--success)" }
                                : entry.status === "rejected"
                                  ? { color: "var(--danger)" }
                                  : undefined
                            }
                          >
                            {entry.status}
                          </span>
                        </td>
                        {canApproveProgress ? (
                          <td className="text-right">
                            {entry.status === "pending" ? (
                              <div className="inline-flex gap-1">
                                <form action={approveProgress}>
                                  <input type="hidden" name="id" value={entry.id} />
                                  <input
                                    type="hidden"
                                    name="decision"
                                    value="approved"
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-primary btn-sm"
                                  >
                                    Approve
                                  </button>
                                </form>
                                <form action={approveProgress}>
                                  <input type="hidden" name="id" value={entry.id} />
                                  <input
                                    type="hidden"
                                    name="decision"
                                    value="rejected"
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-danger btn-sm"
                                  >
                                    Reject
                                  </button>
                                </form>
                              </div>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={canApproveProgress ? 6 : 5}>
                        <EmptyState>Nothing certified yet.</EmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {canCertify ? (
              <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
                <p className="label">Certify a tranche</p>
                <ProgressForm action={certifyProgress} jobId={job.id} />
              </div>
            ) : null}
          </Card>
        </div>
      )}
    </>
  );
}
