import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, PERMISSION_ACTIONS, can, type ModuleRow } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  resetUserPassword,
  saveUserOverrides,
  unlockUser,
  updateCompanyUser,
} from "../actions";
import {
  CompanyAccessForm,
  ResetPasswordForm,
  UnlockForm,
} from "../user-forms";
import {
  OverrideMatrix,
  type OverrideState,
  type RoleBaseline,
} from "./override-matrix";

export const metadata: Metadata = { title: "User access" };

type MemberRow = {
  id: string;
  company_id: string;
  role_id: string | null;
  is_company_admin: boolean;
  is_active: boolean;
  user_id: string;
  profiles: {
    full_name: string;
    email: string;
    locked_at: string | null;
    failed_login_attempts: number;
  } | null;
  roles: { name: string } | null;
};

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ companyUserId: string }>;
}) {
  const { companyUserId } = await params;
  const context = await requirePermission(MODULE.adminUsers, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.adminUsers, "edit");

  const supabase = await createClient();

  const { data: member } = await supabase
    .from("company_users")
    .select(
      "id, company_id, user_id, role_id, is_company_admin, is_active, profiles(full_name, email, locked_at, failed_login_attempts), roles(name)",
    )
    .eq("id", companyUserId)
    .maybeSingle<MemberRow>();

  if (!member || member.company_id !== companyId) notFound();

  const [{ data: modules }, { data: roles }, { data: rolePermissions }, { data: overrides }] =
    await Promise.all([
      supabase
        .from("modules")
        .select(
          "key, label, module_group, description, sort_order, supports_approve, supports_void",
        )
        .order("sort_order")
        .returns<ModuleRow[]>(),
      supabase
        .from("roles")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name"),
      member.role_id
        ? supabase
            .from("role_permissions")
            .select(
              "module_key, can_view, can_edit, can_delete, can_approve, can_void",
            )
            .eq("role_id", member.role_id)
        : Promise.resolve({ data: [] as never[] }),
      supabase
        .from("user_permissions")
        .select("module_key, can_view, can_edit, can_delete, can_approve, can_void")
        .eq("company_user_id", companyUserId),
    ]);

  const roleByModule = new Map(
    (rolePermissions ?? []).map((row) => [row.module_key, row]),
  );
  const overrideByModule = new Map(
    (overrides ?? []).map((row) => [row.module_key, row]),
  );

  const roleBaseline: RoleBaseline = {};
  const initial: OverrideState = {};

  for (const mod of modules ?? []) {
    const roleRow = roleByModule.get(mod.key);
    const overrideRow = overrideByModule.get(mod.key);

    roleBaseline[mod.key] = Object.fromEntries(
      PERMISSION_ACTIONS.map((action) => [
        action,
        Boolean(roleRow?.[`can_${action}` as keyof typeof roleRow]),
      ]),
    ) as RoleBaseline[string];

    initial[mod.key] = Object.fromEntries(
      PERMISSION_ACTIONS.map((action) => [
        action,
        overrideRow
          ? ((overrideRow[`can_${action}` as keyof typeof overrideRow] ??
              null) as boolean | null)
          : null,
      ]),
    ) as OverrideState[string];
  }

  const roleName = member.is_company_admin
    ? "Company admin (everything allowed)"
    : (member.roles?.name ?? "no role");

  return (
    <>
      <PageHeader
        title={member.profiles?.full_name || "Unnamed user"}
        description={member.profiles?.email}
        action={
          <Link href="/admin/users" className="btn btn-secondary btn-sm">
            Back to users
          </Link>
        }
      />

      {member.profiles?.locked_at ? (
        <div className="mb-6">
          <Card
            title="Account locked"
            description="Three wrong passwords locks an account. Only an administrator can release it."
          >
            {canEdit ? (
              <UnlockForm
                action={unlockUser}
                userId={member.user_id}
                companyUserId={member.id}
                attempts={member.profiles.failed_login_attempts}
                lockedAt={member.profiles.locked_at}
              />
            ) : (
              <p className="text-sm muted">
                Locked after {member.profiles.failed_login_attempts} failed
                attempt(s). Unlocking needs edit rights on Users.
              </p>
            )}
          </Card>
        </div>
      ) : null}

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Reset password"
            description="There is no email delivery — set a new password and hand it over. A locked account is released at the same time."
          >
            <ResetPasswordForm
              action={resetUserPassword}
              userId={member.user_id}
              companyUserId={member.id}
            />
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card
          title="Company access"
          description="Role, admin status and whether this person can sign in to this company."
        >
          {canEdit ? (
            <CompanyAccessForm
              action={updateCompanyUser}
              companyUserId={member.id}
              roles={roles ?? []}
              roleId={member.role_id}
              isCompanyAdmin={member.is_company_admin}
              isActive={member.is_active}
            />
          ) : (
            <dl className="grid gap-3 sm:grid-cols-3 text-sm">
              <div>
                <dt className="label">Role</dt>
                <dd>{member.roles?.name ?? "No role"}</dd>
              </div>
              <div>
                <dt className="label">Company admin</dt>
                <dd>{member.is_company_admin ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt className="label">Access</dt>
                <dd>{member.is_active ? "Active" : "Disabled"}</dd>
              </div>
            </dl>
          )}
        </Card>
      </div>

      {member.is_company_admin ? (
        <Card title="Per-user overrides">
          <p className="text-sm muted">
            Company admins bypass the matrix entirely, so overrides have no
            effect. Remove the company admin flag first if you need to restrict
            this user.
          </p>
        </Card>
      ) : (
        <OverrideMatrix
          companyUserId={member.id}
          modules={modules ?? []}
          initial={initial}
          roleBaseline={roleBaseline}
          roleName={roleName}
          canEdit={canEdit}
          action={saveUserOverrides}
        />
      )}
    </>
  );
}
