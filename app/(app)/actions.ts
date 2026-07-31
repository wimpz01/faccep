"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { ACTIVE_COMPANY_COOKIE, requireSession } from "@/lib/auth";

/** Switches which company the rest of the app is scoped to. */
export async function setActiveCompany(formData: FormData) {
  const companyId = String(formData.get("companyId") ?? "");
  const context = await requireSession();

  // Only accept a company the user actually belongs to.
  if (!context.memberships.some((m) => m.companyId === companyId)) {
    return;
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_COMPANY_COOKIE, companyId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/", "layout");
}
