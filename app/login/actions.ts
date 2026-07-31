"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
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

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    // Deliberately vague: do not reveal whether the address exists.
    return { error: "Incorrect email or password." };
  }

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
