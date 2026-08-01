"use server";

import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { getSessionContext } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

const schema = z
  .object({
    current_password: z.string().min(1, "Enter your current password."),
    new_password: z.string().min(6, "Use at least 6 characters."),
    confirm_password: z.string(),
  })
  .refine((data) => data.new_password === data.confirm_password, {
    message: "The two new passwords do not match.",
    path: ["confirm_password"],
  })
  .refine((data) => data.new_password !== data.current_password, {
    message: "The new password must be different from the current one.",
    path: ["new_password"],
  });

/**
 * Changes the signed-in user's own password.
 *
 * The current password is re-checked first: an unattended session should not
 * be enough to take an account over. That re-check deliberately does not count
 * toward the failed-login lockout -- the session is already authenticated, and
 * locking someone out of their own password change would be perverse.
 */
export async function changeOwnPassword(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getSessionContext();
  if (!context) return { error: "Not signed in." };

  const parsed = schema.safeParse({
    current_password: formData.get("current_password"),
    new_password: formData.get("new_password"),
    confirm_password: formData.get("confirm_password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();

  const { error: reauthError } = await supabase.auth.signInWithPassword({
    email: context.email,
    password: parsed.data.current_password,
  });
  if (reauthError) {
    return { error: "That is not your current password." };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.new_password,
  });
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminUsers,
    entityTable: "auth.users",
    entityId: context.userId,
    summary: `${context.email} changed their own password.`,
  });

  return { success: "Password changed. It applies from your next sign-in." };
}
