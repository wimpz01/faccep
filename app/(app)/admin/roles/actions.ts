"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { changedFields, logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import { MODULE, PERMISSION_ACTIONS, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const roleSchema = z.object({
  name: z.string().trim().min(2, "Role name is required."),
  description: z.string().trim().nullish().or(z.literal("")),
});

export async function createRole(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.adminRoles, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const parsed = roleSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("roles")
    .insert({
      company_id: companyId,
      name: parsed.data.name,
      description: parsed.data.description || null,
    })
    .select("id, name")
    .single();

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A role with that name already exists in this company."
          : error.message,
    };
  }

  await logAudit({
    action: "create",
    moduleKey: MODULE.adminRoles,
    entityTable: "roles",
    entityId: data.id,
    summary: `Created role "${data.name}".`,
    after: parsed.data,
  });

  // A new role has no permissions yet, so send the admin straight to the matrix.
  redirect(`/admin/roles/${data.id}`);
}

export async function updateRole(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.adminRoles, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const parsed = roleSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("roles")
    .select("name, description")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("roles")
    .update({
      name: parsed.data.name,
      description: parsed.data.description || null,
    })
    .eq("id", id);

  if (error) {
    return {
      error:
        error.code === "23505"
          ? "A role with that name already exists in this company."
          : error.message,
    };
  }

  const diff = before
    ? changedFields(before, parsed.data)
    : { before: {}, after: parsed.data };

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminRoles,
    entityTable: "roles",
    entityId: id,
    summary: `Updated role "${parsed.data.name}".`,
    before: diff.before,
    after: diff.after,
  });

  revalidatePath(`/admin/roles/${id}`);
  revalidatePath("/admin/roles");
  return { success: "Role updated." };
}

/**
 * Replaces the whole permission matrix for one role.
 *
 * Checkboxes are submitted as `<module key>|<action>`; anything absent from the
 * form is stored as false, so unticking a box genuinely revokes it.
 */
export async function saveRolePermissions(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.adminRoles, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const roleId = String(formData.get("roleId") ?? "");
  if (!roleId) return { error: "Missing role." };

  const supabase = await createClient();

  const { data: modules, error: modulesError } = await supabase
    .from("modules")
    .select("key");
  if (modulesError || !modules) {
    return { error: modulesError?.message ?? "Could not load the module list." };
  }

  const granted = new Set(
    [...formData.keys()].filter((key) => key.includes("|")),
  );

  const rows = modules.map((mod) => ({
    role_id: roleId,
    module_key: mod.key,
    can_view: granted.has(`${mod.key}|view`),
    can_edit: granted.has(`${mod.key}|edit`),
    can_delete: granted.has(`${mod.key}|delete`),
    can_approve: granted.has(`${mod.key}|approve`),
    can_void: granted.has(`${mod.key}|void`),
  }));

  const { data: before } = await supabase
    .from("role_permissions")
    .select("module_key, can_view, can_edit, can_delete, can_approve, can_void")
    .eq("role_id", roleId);

  const { error } = await supabase
    .from("role_permissions")
    .upsert(rows, { onConflict: "role_id,module_key" });

  if (error) return { error: error.message };

  // Record only the modules whose flags actually moved.
  const beforeByModule = new Map(
    (before ?? []).map((row) => [row.module_key, row]),
  );
  const changed: Record<string, { from: string[]; to: string[] }> = {};
  for (const row of rows) {
    const previous = beforeByModule.get(row.module_key);
    const from = PERMISSION_ACTIONS.filter(
      (action) =>
        previous?.[`can_${action}` as keyof typeof previous] === true,
    );
    const to = PERMISSION_ACTIONS.filter(
      (action) => row[`can_${action}` as keyof typeof row] === true,
    );
    if (from.join(",") !== to.join(",")) {
      changed[row.module_key] = { from, to };
    }
  }

  const { data: role } = await supabase
    .from("roles")
    .select("name")
    .eq("id", roleId)
    .single();

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminRoles,
    entityTable: "role_permissions",
    entityId: roleId,
    summary: `Updated permissions for role "${role?.name ?? roleId}" (${
      Object.keys(changed).length
    } module${Object.keys(changed).length === 1 ? "" : "s"} changed).`,
    after: changed,
  });

  revalidatePath(`/admin/roles/${roleId}`);
  return {
    success:
      Object.keys(changed).length === 0
        ? "No changes to save."
        : `Saved. ${Object.keys(changed).length} module${
            Object.keys(changed).length === 1 ? "" : "s"
          } updated.`,
  };
}

export async function setRoleActive(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.adminRoles, "edit")) return;

  const id = String(formData.get("id") ?? "");
  const isActive = formData.get("is_active") === "true";

  const supabase = await createClient();
  const { error } = await supabase
    .from("roles")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) return;

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminRoles,
    entityTable: "roles",
    entityId: id,
    summary: isActive ? "Reactivated role." : "Deactivated role.",
    before: { is_active: !isActive },
    after: { is_active: isActive },
  });

  revalidatePath("/admin/roles");
}

export async function deleteRole(formData: FormData) {
  const context = await getSessionContext();
  if (!context || !can(context.permissions, MODULE.adminRoles, "delete")) return;

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: role } = await supabase
    .from("roles")
    .select("name")
    .eq("id", id)
    .single();

  // Users keep their company access; role_id is set to null by the FK rule, so
  // they simply fall back to no permissions until reassigned.
  const { error } = await supabase.from("roles").delete().eq("id", id);
  if (error) return;

  await logAudit({
    action: "delete",
    moduleKey: MODULE.adminRoles,
    entityTable: "roles",
    entityId: id,
    summary: `Deleted role "${role?.name ?? id}".`,
    before: role ?? undefined,
  });

  revalidatePath("/admin/roles");
  redirect("/admin/roles");
}
