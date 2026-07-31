import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createRole, setRoleActive } from "./actions";
import { RoleForm } from "./role-form";

export const metadata: Metadata = { title: "Roles & Permissions" };

type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  company_users: { count: number }[];
  role_permissions: { count: number }[];
};

export default async function RolesPage() {
  const context = await requirePermission(MODULE.adminRoles, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.adminRoles, "edit");

  const supabase = await createClient();
  const { data: roles } = await supabase
    .from("roles")
    .select(
      "id, name, description, is_active, company_users(count), role_permissions(count)",
    )
    .eq("company_id", companyId)
    .order("name")
    .returns<RoleRow[]>();

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        description="Roles are entirely yours to define. Create one, then tick exactly which modules it can view, edit, delete, approve or void."
      />

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Create a role"
            description="You will land on its permission matrix straight after saving."
          >
            <RoleForm action={createRole} submitLabel="Create role" />
          </Card>
        </div>
      ) : null}

      <Card title="Roles in this company" bodyClassName="">
        {roles && roles.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Users</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td>
                      <Link
                        href={`/admin/roles/${role.id}`}
                        className="font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {role.name}
                      </Link>
                      {role.description ? (
                        <p className="text-xs muted">{role.description}</p>
                      ) : null}
                    </td>
                    <td className="tabular-nums">
                      {role.company_users?.[0]?.count ?? 0}
                    </td>
                    <td>
                      {role.is_active ? (
                        <span className="badge badge-brand">Active</span>
                      ) : (
                        <span className="badge">Inactive</span>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="inline-flex gap-2">
                        <Link
                          href={`/admin/roles/${role.id}`}
                          className="btn btn-secondary btn-sm"
                        >
                          {canEdit ? "Edit permissions" : "View permissions"}
                        </Link>
                        {canEdit ? (
                          <form action={setRoleActive}>
                            <input type="hidden" name="id" value={role.id} />
                            <input
                              type="hidden"
                              name="is_active"
                              value={String(!role.is_active)}
                            />
                            <button type="submit" className="btn btn-danger btn-sm">
                              {role.is_active ? "Deactivate" : "Reactivate"}
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
          <EmptyState>
            No roles yet
            {canEdit ? " — create the first one above." : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
