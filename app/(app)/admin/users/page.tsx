import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createUser, removeCompanyUser } from "./actions";
import { NewUserForm } from "./user-forms";

export const metadata: Metadata = { title: "Users" };

type CompanyUserRow = {
  id: string;
  is_company_admin: boolean;
  is_active: boolean;
  profiles: {
    full_name: string;
    email: string;
    user_code: string;
    is_active: boolean;
    locked_at: string | null;
  } | null;
  roles: { name: string } | null;
  user_permissions: { count: number }[];
};

export default async function UsersPage() {
  const context = await requirePermission(MODULE.adminUsers, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.adminUsers, "edit");
  const canDelete = can(context.permissions, MODULE.adminUsers, "delete");

  const supabase = await createClient();

  const [{ data: members }, { data: roles }] = await Promise.all([
    supabase
      .from("company_users")
      .select(
        "id, is_company_admin, is_active, profiles(full_name, email, user_code, is_active, locked_at), roles(name), user_permissions(count)",
      )
      .eq("company_id", companyId)
      .returns<CompanyUserRow[]>(),
    supabase
      .from("roles")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
  ]);

  const sorted = [...(members ?? [])].sort((a, b) =>
    (a.profiles?.full_name ?? "").localeCompare(b.profiles?.full_name ?? ""),
  );

  return (
    <>
      <PageHeader
        title="Users"
        description={`People with access to ${context.activeCompany!.companyName}.`}
      />

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Add a user"
            description="If the email already has an account in another company, it is reused."
          >
            <NewUserForm action={createUser} roles={roles ?? []} />
          </Card>
        </div>
      ) : null}

      <Card title="Company members" bodyClassName="">
        {sorted.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>User code</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Overrides</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <Link
                        href={`/admin/users/${member.id}`}
                        className="font-semibold tabular-nums"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {member.profiles?.user_code}
                      </Link>
                    </td>
                    <td>
                      <span className="text-sm">
                        {member.profiles?.full_name || "Unnamed user"}
                      </span>
                      <p className="text-xs muted break-all">
                        {member.profiles?.email}
                      </p>
                    </td>
                    <td>
                      {member.is_company_admin ? (
                        <span className="badge badge-brand">Company admin</span>
                      ) : (
                        (member.roles?.name ?? (
                          <span className="muted text-xs">No role</span>
                        ))
                      )}
                    </td>
                    <td className="tabular-nums">
                      {member.user_permissions?.[0]?.count ?? 0}
                    </td>
                    <td>
                      {member.profiles?.locked_at ? (
                        <span className="badge" style={{ color: "var(--danger)" }}>
                          Locked
                        </span>
                      ) : member.is_active && member.profiles?.is_active ? (
                        <span className="badge badge-brand">Active</span>
                      ) : (
                        <span className="badge">Disabled</span>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="inline-flex gap-2">
                        <Link
                          href={`/admin/users/${member.id}`}
                          className="btn btn-secondary btn-sm"
                        >
                          {canEdit ? "Manage" : "View"}
                        </Link>
                        {canDelete ? (
                          <form action={removeCompanyUser}>
                            <input
                              type="hidden"
                              name="companyUserId"
                              value={member.id}
                            />
                            <button type="submit" className="btn btn-danger btn-sm">
                              Remove
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No users have access to this company yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
