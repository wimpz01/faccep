"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string };

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  // nullish, not optional: the hidden field is absent when the user came to
  // /login directly, and FormData.get returns null rather than undefined.
  next: z.string().nullish(),
});

export async function signIn(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  // The lock is checked before the password, so a locked account cannot be
  // signed in even with correct credentials.
  const admin = createAdminClient();
  const { data: locked } = await admin.rpc("is_account_locked", {
    p_email: parsed.data.email,
  });

  if (locked) {
    return {
      error:
        "This account is locked after too many failed sign-in attempts. Ask an administrator to unlock it.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    const { data: remaining } = await admin.rpc("record_failed_login", {
      p_email: parsed.data.email,
    });

    // Deliberately vague about the credentials themselves: never reveal
    // whether the address exists, only how many tries are left.
    if (remaining === 0) {
      return {
        error:
          "Incorrect email or password. This account is now locked — ask an administrator to unlock it.",
      };
    }
    return {
      error: `Incorrect email or password. ${remaining} attempt${remaining === 1 ? "" : "s"} left before the account locks.`,
    };
  }

  await admin.rpc("clear_failed_logins", { p_email: parsed.data.email });

  await logAudit({
    action: "login",
    moduleKey: "admin.users",
    entityTable: "auth.users",
    summary: `${parsed.data.email} signed in.`,
  });

  // Only accept same-site relative paths, so ?next= cannot be used as an
  // open redirect.
  const next = parsed.data.next;
  const target =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  redirect(target);
}

export async function signOut() {
  await logAudit({
    action: "logout",
    moduleKey: "admin.users",
    entityTable: "auth.users",
    summary: "Signed out.",
  });

  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
