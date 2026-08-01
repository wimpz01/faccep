"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, PERMISSION_ACTIONS, can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const newUserSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  full_name: z.string().trim().min(2, "Full name is required."),
  password: z
    .string()
    .min(6, "Use at least 6 characters for the initial password."),
  role_id: z.string().uuid().optional().or(z.literal("")),
  is_company_admin: z.boolean(),
  status: z.enum(["active", "inactive"]),
});

/**
 * Creates the account (or reuses an existing one) and grants it access to the
 * active company.
 *
 * There is no email delivery in this system, so the admin sets an initial
 * password and hands it over directly.
 */
export async function createUser(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.adminUsers, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = newUserSchema.safeParse({
    email: formData.get("email"),
    full_name: formData.get("full_name"),
    password: formData.get("password"),
    role_id: formData.get("role_id"),
    is_company_admin: formData.get("is_company_admin") === "on",
    status: formData.get("status") || "active",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { email, full_name, password, role_id, is_company_admin, status } =
    parsed.data;

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    return { error: (error as Error).message };
  }

  // Reuse the account if this person already works for another company.
  const { data: existing } = await admin
    .from("profiles")
    .select("id, full_name")
    .ilike("email", email)
    .maybeSingle();

  let userId = existing?.id;
  let createdAccount = false;

  if (!userId) {
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      });

    if (createError || !created.user) {
      return { error: createError?.message ?? "Could not create the account." };
    }

    userId = created.user.id;
    createdAccount = true;

    // The signup trigger inserts the profile; make sure the name is set.
    await admin.from("profiles").update({ full_name }).eq("id", userId);
  }

  // Membership is inserted as the signed-in admin, so RLS re-checks the
  // admin.users permission rather than trusting this code path.
  const supabase = await createClient();
  const { data: membership, error: membershipError } = await supabase
    .from("company_users")
    .insert({
      company_id: companyId,
      user_id: userId,
      role_id: role_id || null,
      is_company_admin,
      is_active: status === "active",
    })
    .select("id")
    .single();

  if (membershipError) {
    return {
      error:
        membershipError.code === "23505"
          ? "That user already has access to this company."
          : membershipError.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.adminUsers,
    entityTable: "company_users",
    entityId: membership.id,
    summary: createdAccount
      ? `Created user ${email} (${status}) and granted access.`
      : `Granted existing user ${email} access to this company (${status}).`,
    after: {
      email,
      full_name,
      role_id: role_id || null,
      is_company_admin,
      status,
    },
  });

  revalidatePath("/admin/users");
  return {
    success: createdAccount
      ? `Account created for ${email}. Give them the initial password you set.`
      : `${email} now has access to this company.`,
  };
}

export async function updateCompanyUser(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.adminUsers, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const companyUserId = String(formData.get("companyUserId") ?? "");
  const roleId = String(formData.get("role_id") ?? "");
  const isCompanyAdmin = formData.get("is_company_admin") === "on";
  const status = String(formData.get("status") ?? "active");
  if (status !== "active" && status !== "inactive") {
    return { error: "Status must be active or inactive." };
  }
  const isActive = status === "active";

  const supabase = await createClient();

  const { data: before } = await supabase
    .from("company_users")
    .select("role_id, is_company_admin, is_active, profiles(email)")
    .eq("id", companyUserId)
    .single<{
      role_id: string | null;
      is_company_admin: boolean;
      is_active: boolean;
      profiles: { email: string } | null;
    }>();

  const { error } = await supabase
    .from("company_users")
    .update({
      role_id: roleId || null,
      is_company_admin: isCompanyAdmin,
      is_active: isActive,
    })
    .eq("id", companyUserId);

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminUsers,
    entityTable: "company_users",
    entityId: companyUserId,
    summary: `Updated company access for ${before?.profiles?.email ?? companyUserId}.`,
    before: before
      ? {
          role_id: before.role_id,
          is_company_admin: before.is_company_admin,
          is_active: before.is_active,
        }
      : undefined,
    after: {
      role_id: roleId || null,
      is_company_admin: isCompanyAdmin,
      is_active: isActive,
    },
  });

  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${companyUserId}`);
  return { success: "Access updated." };
}

/**
 * Replaces the per-user overrides layered on top of the role matrix.
 *
 * Cells left on "inherit" are simply not submitted, so they fall through to the
 * role. Only explicit allow/deny values are stored.
 */
export async function saveUserOverrides(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.adminUsers, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const companyUserId = String(formData.get("companyUserId") ?? "");
  if (!companyUserId) return { error: "Missing user." };

  type OverrideRow = {
    company_user_id: string;
    module_key: string;
    can_view: boolean | null;
    can_edit: boolean | null;
    can_delete: boolean | null;
    can_approve: boolean | null;
    can_void: boolean | null;
  };

  const rows = new Map<string, OverrideRow>();

  for (const [key, value] of formData.entries()) {
    if (!key.includes("|")) continue;
    const [moduleKey, action] = key.split("|");
    if (!PERMISSION_ACTIONS.includes(action as never)) continue;

    const row =
      rows.get(moduleKey) ??
      ({
        company_user_id: companyUserId,
        module_key: moduleKey,
        can_view: null,
        can_edit: null,
        can_delete: null,
        can_approve: null,
        can_void: null,
      } satisfies OverrideRow);

    row[`can_${action}` as keyof OverrideRow] = (String(value) ===
      "true") as never;
    rows.set(moduleKey, row);
  }

  const supabase = await createClient();

  // Replace wholesale: a module absent from the form has no overrides left.
  const { error: deleteError } = await supabase
    .from("user_permissions")
    .delete()
    .eq("company_user_id", companyUserId);
  if (deleteError) return { error: deleteError.message };

  if (rows.size > 0) {
    const { error: insertError } = await supabase
      .from("user_permissions")
      .insert([...rows.values()]);
    if (insertError) return { error: insertError.message };
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminUsers,
    entityTable: "user_permissions",
    entityId: companyUserId,
    summary: `Set ${rows.size} per-user permission override${
      rows.size === 1 ? "" : "s"
    }.`,
    after: Object.fromEntries([...rows.entries()].map(([k, v]) => [k, v])),
  });

  revalidatePath(`/admin/users/${companyUserId}`);
  return {
    success:
      rows.size === 0
        ? "All overrides cleared — this user now follows their role exactly."
        : `Saved ${rows.size} override${rows.size === 1 ? "" : "s"}.`,
  };
}

/**
 * Releases an account locked by failed sign-ins.
 *
 * The permission check lives in unlock_account() in the database, so the rule
 * holds even if this is reached another way.
 */
export async function unlockUser(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.adminUsers, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing user." };

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, failed_login_attempts")
    .eq("id", userId)
    .maybeSingle();

  const { error } = await supabase.rpc("unlock_account", { p_user: userId });
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminUsers,
    entityTable: "profiles",
    entityId: userId,
    summary: `Unlocked ${profile?.email ?? userId} after ${profile?.failed_login_attempts ?? 0} failed sign-in attempt(s).`,
    before: { locked: true },
    after: { locked: false },
  });

  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${formData.get("companyUserId") ?? ""}`);
  return { success: "Account unlocked. They can sign in again." };
}

/**
 * Sets another user's password.
 *
 * There is no email delivery, so an administrator sets a new one and hands it
 * over, exactly as at account creation. Unlocks the account at the same time,
 * since a forgotten password is the usual reason it locked.
 */
export async function resetUserPassword(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.adminUsers, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const userId = String(formData.get("user_id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!userId) return { error: "Missing user." };
  if (password.length < 6) return { error: "Use at least 6 characters." };

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    return { error: (error as Error).message };
  }

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return { error: error.message };

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, locked_at")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.locked_at) {
    await supabase.rpc("unlock_account", { p_user: userId });
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminUsers,
    entityTable: "auth.users",
    entityId: userId,
    summary:
      `Reset the password for ${profile?.email ?? userId}` +
      (profile?.locked_at ? " and unlocked the account." : "."),
  });

  revalidatePath(`/admin/users/${formData.get("companyUserId") ?? ""}`);
  revalidatePath("/admin/users");
  return {
    success: "Password reset. Hand it to them directly and have them change it.",
  };
}

export async function removeCompanyUser(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.adminUsers, "delete")) return;

  const companyUserId = String(formData.get("companyUserId") ?? "");
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("company_users")
    .select("profiles(email)")
    .eq("id", companyUserId)
    .single<{ profiles: { email: string } | null }>();

  const { error } = await supabase
    .from("company_users")
    .delete()
    .eq("id", companyUserId);
  if (error) return;

  await logAudit({
    action: "delete",
    moduleKey: MODULE.adminUsers,
    entityTable: "company_users",
    entityId: companyUserId,
    summary: `Removed ${before?.profiles?.email ?? companyUserId} from this company.`,
  });

  revalidatePath("/admin/users");
}
