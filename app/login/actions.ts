"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string };

const loginSchema = z.object({
  user_code: z.string().trim().min(1, "Enter your user code."),
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
    user_code: formData.get("user_code"),
    password: formData.get("password"),
    next: formData.get("next"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const admin = createAdminClient();

  // The code is what the user types; the email behind it is what Supabase Auth
  // needs. An unknown code falls through to the same failure path as a wrong
  // password, so it cannot be used to discover which codes exist.
  const { data: email } = await admin.rpc("email_for_user_code", {
    p_code: parsed.data.user_code,
  });

  // The lock is checked before the password, so a locked account cannot be
  // signed in even with correct credentials.
  if (email) {
    const { data: locked } = await admin.rpc("is_account_locked", {
      p_email: email,
    });
    if (locked) {
      return {
        error:
          "This account is locked after too many failed sign-in attempts. Ask an administrator to unlock it.",
      };
    }
  }

  const supabase = await createClient();
  const { error } = email
    ? await supabase.auth.signInWithPassword({
        email,
        password: parsed.data.password,
      })
    : { error: new Error("unknown user code") };

  if (error) {
    // Counting against an unknown code returns the full allowance, so the
    // wording is identical either way.
    const { data: remaining } = await admin.rpc("record_failed_login", {
      p_email: email ?? `${parsed.data.user_code}@unknown.invalid`,
    });

    if (remaining === 0) {
      return {
        error:
          "Incorrect user code or password. This account is now locked — ask an administrator to unlock it.",
      };
    }
    return {
      error: `Incorrect user code or password. ${remaining} attempt${remaining === 1 ? "" : "s"} left before the account locks.`,
    };
  }

  await admin.rpc("clear_failed_logins", { p_email: email });

  await logAudit({
    action: "login",
    moduleKey: "admin.users",
    entityTable: "auth.users",
    summary: `${parsed.data.user_code} signed in.`,
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
