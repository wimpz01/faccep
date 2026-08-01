import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import {
  NO_PERMISSIONS,
  type PermissionAction,
  type PermissionMatrix,
} from "@/lib/permissions";

export const ACTIVE_COMPANY_COOKIE = "faccep.company";

export type Membership = {
  companyUserId: string | null;
  companyId: string;
  companyName: string;
  roleId: string | null;
  roleName: string | null;
  isCompanyAdmin: boolean;
};

export type SessionContext = {
  userId: string;
  email: string;
  userCode: string;
  fullName: string;
  isSuperAdmin: boolean;
  memberships: Membership[];
  activeCompany: Membership | null;
  permissions: PermissionMatrix;
};

type MembershipRow = {
  id: string;
  company_id: string;
  role_id: string | null;
  is_company_admin: boolean;
  companies: { name: string } | null;
  roles: { name: string } | null;
};

type PermissionRow = {
  module_key: string;
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_approve: boolean;
  can_void: boolean;
};

/**
 * Loads the signed-in user, their company memberships, and the resolved
 * permission matrix for the active company.
 *
 * Cached for the lifetime of one request, so a page and its nested components
 * share a single round trip.
 */
export const getSessionContext = cache(
  async (): Promise<SessionContext | null> => {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, email, user_code, is_super_admin, is_active, locked_at")
      .eq("id", user.id)
      .maybeSingle();

    // A profile row is created by trigger on signup. A disabled account, or
    // one locked out by failed sign-ins, is treated as signed out -- so
    // locking someone also ends the session they already hold.
    if (!profile || !profile.is_active || profile.locked_at) return null;

    const { data: membershipRows } = await supabase
      .from("company_users")
      .select(
        "id, company_id, role_id, is_company_admin, companies(name), roles(name)",
      )
      .eq("user_id", user.id)
      .eq("is_active", true)
      .returns<MembershipRow[]>();

    const memberships: Membership[] = (membershipRows ?? []).map((row) => ({
      companyUserId: row.id,
      companyId: row.company_id,
      companyName: row.companies?.name ?? "Unnamed company",
      roleId: row.role_id,
      roleName: row.roles?.name ?? null,
      isCompanyAdmin: row.is_company_admin,
    }));

    // A super admin has access to every company whether or not a membership
    // row exists, otherwise the first install would have nowhere to start.
    if (profile.is_super_admin) {
      const { data: companies } = await supabase
        .from("companies")
        .select("id, name")
        .eq("is_active", true)
        .order("name");

      for (const company of companies ?? []) {
        if (!memberships.some((m) => m.companyId === company.id)) {
          memberships.push({
            companyUserId: null,
            companyId: company.id,
            companyName: company.name,
            roleId: null,
            roleName: "Super admin",
            isCompanyAdmin: true,
          });
        }
      }
      memberships.sort((a, b) => a.companyName.localeCompare(b.companyName));
    }

    const cookieStore = await cookies();
    const preferredCompanyId = cookieStore.get(ACTIVE_COMPANY_COOKIE)?.value;
    const activeCompany =
      memberships.find((m) => m.companyId === preferredCompanyId) ??
      memberships[0] ??
      null;

    const permissions: PermissionMatrix = {};
    if (activeCompany) {
      const { data } = await supabase.rpc("my_permissions", {
        p_company: activeCompany.companyId,
      });
      const permissionRows = (data ?? []) as PermissionRow[];

      for (const row of permissionRows) {
        permissions[row.module_key] = {
          view: row.can_view,
          edit: row.can_edit,
          delete: row.can_delete,
          approve: row.can_approve,
          void: row.can_void,
        };
      }
    }

    return {
      userId: user.id,
      email: profile.email ?? user.email ?? "",
      userCode: profile.user_code ?? "",
      fullName: profile.full_name || (profile.email ?? ""),
      isSuperAdmin: profile.is_super_admin,
      memberships,
      activeCompany,
      permissions,
    };
  },
);

/** Page guard: redirects to /login when there is no session. */
export async function requireSession(): Promise<SessionContext> {
  const context = await getSessionContext();
  if (!context) redirect("/login");
  return context;
}

/**
 * Page guard: redirects to /login, /no-company or /forbidden as appropriate.
 * Use at the top of every page that renders module data.
 */
export async function requirePermission(
  moduleKey: string,
  action: PermissionAction = "view",
): Promise<SessionContext> {
  const context = await requireSession();
  if (!context.activeCompany) redirect("/no-company");

  const permissions = context.permissions[moduleKey] ?? NO_PERMISSIONS;
  if (!permissions[action]) {
    redirect(`/forbidden?module=${encodeURIComponent(moduleKey)}`);
  }
  return context;
}

export class PermissionError extends Error {
  constructor(moduleKey: string, action: PermissionAction) {
    super(`You do not have permission to ${action} ${moduleKey}.`);
    this.name = "PermissionError";
  }
}

/**
 * Server-action guard. Throws instead of redirecting so the calling action can
 * return a form error.
 *
 * This is a convenience check, not the security boundary -- row level security
 * enforces the same matrix in the database.
 */
export async function assertPermission(
  moduleKey: string,
  action: PermissionAction,
): Promise<SessionContext> {
  const context = await getSessionContext();
  if (!context) throw new Error("Not signed in.");
  if (!context.activeCompany) throw new Error("No active company selected.");

  const permissions = context.permissions[moduleKey] ?? NO_PERMISSIONS;
  if (!permissions[action]) throw new PermissionError(moduleKey, action);
  return context;
}
