import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import {
  MODULE,
  NO_PERMISSIONS,
  can,
  type ModuleRow,
} from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { deleteRole, saveRolePermissions, updateRole } from "../actions";
import { RoleForm } from "../role-form";
import { PermissionMatrix, type MatrixState } from "./permission-matrix";

export const metadata: Metadata = { title: "Role permissions" };

type RolePermissionRow = {
  module_key: string;
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_approve: boolean;
  can_void: boolean;
};

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.adminRoles, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.adminRoles, "edit");
  const canDelete = can(context.permissions, MODULE.adminRoles, "delete");

  const supabase = await createClient();

  const { data: role } = await supabase
    .from("roles")
    .select("id, name, description, is_active, company_id")
    .eq("id", id)
    .maybeSingle();

  if (!role || role.company_id !== companyId) notFound();

  const [{ data: modules }, { data: rolePermissions }] = await Promise.all([
    supabase
      .from("modules")
      .select(
        "key, label, module_group, description, sort_order, supports_approve, supports_void",
      )
      .order("sort_order")
      .returns<ModuleRow[]>(),
    supabase
      .from("role_permissions")
      .select("module_key, can_view, can_edit, can_delete, can_approve, can_void")
      .eq("role_id", id)
      .returns<RolePermissionRow[]>(),
  ]);

  const stored = new Map((rolePermissions ?? []).map((row) => [row.module_key, row]));
  const initial: MatrixState = {};
  for (const mod of modules ?? []) {
    const row = stored.get(mod.key);
    initial[mod.key] = row
      ? {
          view: row.can_view,
          edit: row.can_edit,
          delete: row.can_delete,
          approve: row.can_approve,
          void: row.can_void,
        }
      : { ...NO_PERMISSIONS };
  }

  return (
    <>
      <PageHeader
        title={role.name}
        description={role.description ?? "No description."}
        action={
          <Link href="/admin/roles" className="btn btn-secondary btn-sm">
            Back to roles
          </Link>
        }
      />

      {canEdit ? (
        <div className="mb-6">
          <Card title="Role details">
            <RoleForm action={updateRole} role={role} submitLabel="Save details" />
          </Card>
        </div>
      ) : null}

      <PermissionMatrix
        roleId={role.id}
        modules={modules ?? []}
        initial={initial}
        canEdit={canEdit}
        action={saveRolePermissions}
      />

      {canDelete ? (
        <div className="mt-6">
          <Card
            title="Delete this role"
            description="Users keep their company access but lose every permission until you assign them another role."
          >
            <form action={deleteRole}>
              <input type="hidden" name="id" value={role.id} />
              <button type="submit" className="btn btn-danger">
                Delete role
              </button>
            </form>
          </Card>
        </div>
      ) : null}
    </>
  );
}
