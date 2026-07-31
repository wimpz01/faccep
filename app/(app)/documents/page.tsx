import type { Metadata } from "next";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { deleteDocument, recordDocument } from "../crm/actions";
import { DocumentUploader } from "../crm/crm-forms";

export const metadata: Metadata = { title: "Documents" };

type DocumentRow = {
  id: string;
  title: string;
  doc_kind: string;
  storage_path: string;
  issued_on: string | null;
  expires_on: string | null;
  notes: string | null;
  created_at: string;
  tenants: { company_name: string } | null;
};

const KIND_LABELS: Record<string, string> = {
  business_permit: "Business permit",
  dti_registration: "DTI registration",
  mayors_permit: "Mayor's permit",
  bir_registration: "BIR registration",
  contract: "Signed contract",
  letter: "Letter",
  memo: "Memo",
  other: "Other",
};

export default async function DocumentsPage() {
  const context = await requirePermission(MODULE.documents, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.documents, "edit");
  const canDelete = can(context.permissions, MODULE.documents, "delete");

  const supabase = await createClient();
  const [{ data: documents }, { data: tenants }] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, title, doc_kind, storage_path, issued_on, expires_on, notes, created_at, tenants(company_name)",
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .returns<DocumentRow[]>(),
    supabase
      .from("tenants")
      .select("id, company_name")
      .eq("company_id", companyId)
      .order("company_name"),
  ]);

  const rows = documents ?? [];

  const signed = new Map<string, string>();
  if (rows.length > 0) {
    const { data } = await supabase.storage
      .from("documents")
      .createSignedUrls(
        rows.map((row) => row.storage_path),
        3600,
      );
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const in60 = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const expiringSoon = rows.filter(
    (row) => row.expires_on && row.expires_on <= in60,
  );

  return (
    <>
      <PageHeader
        title="Documents"
        description="Permits, registrations, signed contracts and outbound letters, filed in one place."
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile label="Filed" value={rows.length} hint="All documents" />
        <StatTile
          label="Expiring soon"
          value={expiringSoon.length}
          hint="Within 60 days"
        />
        <StatTile
          label="Permits"
          value={
            rows.filter((row) => row.doc_kind.includes("permit")).length
          }
          hint="Business and mayor's"
        />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="File a document"
            description="Stored privately; links are short-lived and scoped to your company."
          >
            <DocumentUploader
              companyId={companyId}
              tenants={tenants ?? []}
              onRecord={recordDocument}
            />
          </Card>
        </div>
      ) : null}

      <Card title="Filed documents" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Tenant</th>
                  <th>Issued</th>
                  <th>Expires</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((document) => {
                  const expiring =
                    document.expires_on && document.expires_on <= in60;
                  const expired =
                    document.expires_on && document.expires_on < today;
                  return (
                    <tr key={document.id}>
                      <td>
                        <span className="text-sm font-medium">{document.title}</span>
                        {document.notes ? (
                          <p className="text-xs muted">{document.notes}</p>
                        ) : null}
                      </td>
                      <td className="text-xs">
                        {KIND_LABELS[document.doc_kind] ?? document.doc_kind}
                      </td>
                      <td className="text-xs">
                        {document.tenants?.company_name ?? "Company-wide"}
                      </td>
                      <td className="text-xs">{formatDate(document.issued_on)}</td>
                      <td className="text-xs">
                        {formatDate(document.expires_on)}
                        {expired ? (
                          <p style={{ color: "var(--danger)" }}>expired</p>
                        ) : expiring ? (
                          <p style={{ color: "var(--danger)" }}>expiring</p>
                        ) : null}
                      </td>
                      <td className="text-right">
                        <div className="inline-flex gap-2">
                          {signed.get(document.storage_path) ? (
                            <a
                              href={signed.get(document.storage_path)}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-secondary btn-sm"
                            >
                              Open
                            </a>
                          ) : null}
                          {canDelete ? (
                            <form action={deleteDocument}>
                              <input type="hidden" name="id" value={document.id} />
                              <button type="submit" className="btn btn-danger btn-sm">
                                Delete
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>Nothing filed yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
