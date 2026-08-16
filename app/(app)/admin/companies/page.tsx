import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createCompany, setCompanyActive, updateCompany } from "./actions";
import { CompanyForm } from "./company-form";

export const metadata: Metadata = { title: "Companies" };

type CompanyRow = {
  id: string;
  name: string;
  legal_name: string | null;
  tin: string | null;
  address: string | null;
  zip_code: string | null;
  contact_person: string | null;
  contact_number: string | null;
  email: string | null;
  is_active: boolean;
};

export default async function CompaniesPage() {
  const context = await requireSession();

  // Gated by hand rather than requirePermission(), because a super admin on a
  // fresh install has no active company yet and still needs this page.
  if (
    !context.isSuperAdmin &&
    !can(context.permissions, MODULE.adminCompanies, "view")
  ) {
    redirect(`/forbidden?module=${MODULE.adminCompanies}`);
  }

  const canEdit =
    context.isSuperAdmin ||
    can(context.permissions, MODULE.adminCompanies, "edit");

  const supabase = await createClient();
  const { data: companies } = await supabase
    .from("companies")
    .select(
      "id, name, legal_name, tin, address, zip_code, contact_person, contact_number, email, is_active",
    )
    .order("name")
    .returns<CompanyRow[]>();

  return (
    <>
      <PageHeader
        title="Companies"
        description="Each company owns its own locations, roles, users, chart of accounts and reports."
      />

      {context.isSuperAdmin ? (
        <div className="mb-6">
          <Card
            title="Add a company"
            description="Only a super admin can create a company."
          >
            <CompanyForm action={createCompany} submitLabel="Create company" />
          </Card>
        </div>
      ) : null}

      <Card title="All companies" bodyClassName="">
        {companies && companies.length > 0 ? (
          <div className="flex flex-col">
            {companies.map((company) => (
              <details
                key={company.id}
                className="border-b last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <summary className="cursor-pointer px-5 py-3.5 flex items-center justify-between gap-3 flex-wrap">
                  <span>
                    <span className="font-semibold text-sm">{company.name}</span>
                    {company.tin ? (
                      <span className="text-xs muted ml-2">TIN {company.tin}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    {company.is_active ? (
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
                      <CompanyForm
                        action={updateCompany}
                        company={company}
                        submitLabel="Save changes"
                      />
                      <form action={setCompanyActive} className="mt-4">
                        <input type="hidden" name="id" value={company.id} />
                        <input
                          type="hidden"
                          name="is_active"
                          value={String(!company.is_active)}
                        />
                        <button type="submit" className="btn btn-danger btn-sm">
                          {company.is_active
                            ? "Deactivate company"
                            : "Reactivate company"}
                        </button>
                      </form>
                    </>
                  ) : (
                    <dl className="grid gap-3 sm:grid-cols-2 text-sm">
                      <div>
                        <dt className="label">Legal name</dt>
                        <dd>{company.legal_name ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="label">Contact person</dt>
                        <dd>{company.contact_person ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="label">Contact number</dt>
                        <dd>{company.contact_number ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="label">Email</dt>
                        <dd>{company.email ?? "—"}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="label">Address</dt>
                        <dd>{company.address ?? "—"}</dd>
                      </div>
                    </dl>
                  )}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <EmptyState>No companies yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
