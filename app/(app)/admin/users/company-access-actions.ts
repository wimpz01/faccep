"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { getSessionContext } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/**
 * Which companies a person may sign in to, and as what.
 *
 * Access has always been per company -- a row in company_users grants it --
 * but it could only be granted from inside the company being granted, which
 * meant switching company to add somebody and switching back. This says the
 * same thing in one place: tick the companies this person is allowed into.
 *
 * Unticking disables the seat rather than deleting it. A removed row would
 * take the person's per-user permission overrides with it, and an accidental
 * untick would then be unrecoverable; a disabled seat stops them signing in
 * and keeps everything else for when it is turned back on.
 *
 * A company may only be ticked by somebody entitled to administer it. Granting
 * access to a company you do not run would otherwise be a way of letting
 * yourself, or anyone, into it.
 */
export async function setUserCompanyAccess(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getSessionContext();
  if (!context?.activeCompany) return { error: "No active company." };

  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing user." };

  const supabase = await createClient();

  // What the caller may administer. A super admin may reach every company.
  const { data: mySeats } = await supabase
    .from("company_users")
    .select("company_id, is_company_admin, is_active")
    .eq("user_id", context.userId);

  const administers = new Set(
    (mySeats ?? [])
      .filter((seat) => seat.is_company_admin && seat.is_active)
      .map((seat) => seat.company_id as string),
  );

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .returns<{ id: string; name: string }[]>();

  const { data: theirSeats } = await supabase
    .from("company_users")
    .select("id, company_id, role_id, is_active, is_company_admin")
    .eq("user_id", userId);

  const seatIn = new Map(
    (theirSeats ?? []).map((seat) => [seat.company_id as string, seat]),
  );

  const changes: string[] = [];

  for (const company of companies ?? []) {
    const mayAdminister = context.isSuperAdmin || administers.has(company.id);
    // A company the caller cannot administer is not theirs to change. The
    // form disables it; this is what makes that more than a suggestion.
    if (!mayAdminister) continue;

    const allowed = formData.get(`allow:${company.id}`) !== null;
    const roleValue = String(formData.get(`role:${company.id}`) ?? "");
    const roleId = roleValue === "" ? null : roleValue;
    const seat = seatIn.get(company.id);

    if (allowed && !seat) {
      const { error } = await supabase.from("company_users").insert({
        company_id: company.id,
        user_id: userId,
        role_id: roleId,
        is_active: true,
        is_company_admin: false,
      });
      if (error) return { error: `${company.name}: ${error.message}` };
      changes.push(`allowed into ${company.name}`);
      continue;
    }

    if (!allowed && seat) {
      if (seat.is_active) {
        const { error } = await supabase
          .from("company_users")
          .update({ is_active: false })
          .eq("id", seat.id);
        if (error) return { error: `${company.name}: ${error.message}` };
        changes.push(`removed from ${company.name}`);
      }
      continue;
    }

    if (allowed && seat) {
      const patch: Record<string, unknown> = {};
      if (!seat.is_active) patch.is_active = true;
      if ((seat.role_id ?? null) !== roleId) patch.role_id = roleId;
      if (Object.keys(patch).length === 0) continue;

      const { error } = await supabase
        .from("company_users")
        .update(patch)
        .eq("id", seat.id);
      if (error) return { error: `${company.name}: ${error.message}` };
      changes.push(
        patch.is_active ? `restored to ${company.name}` : `role changed in ${company.name}`,
      );
    }
  }

  if (changes.length === 0) return { success: "Nothing changed." };

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminUsers,
    entityTable: "company_users",
    entityId: userId,
    summary: `Company access: ${changes.join("; ")}.`,
    after: { changes },
  });

  revalidatePath("/admin/users");
  return { success: `Saved. ${changes.join("; ")}.` };
}
