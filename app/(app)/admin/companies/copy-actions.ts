"use server";

import { revalidatePath } from "next/cache";

import { logAudit } from "@/lib/audit";
import { getSessionContext } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string; success?: string };

/**
 * Copies one company's settings onto others.
 *
 * The screens, reports and modules are code and belong to every company
 * already; a change to a report reaches all of them the moment it ships. What
 * does not travel is configuration held against a company_id -- the print
 * layout, the tax rates, the roles and the reference lists -- and where one
 * house runs several companies the same way, keeping those in step by hand is
 * where they quietly drift apart.
 *
 * Deliberately an act rather than automatic inheritance. A company that has to
 * differ still can; this only saves the retyping when they should match.
 *
 * Adds and updates, never deletes. A role or a payment term the target has and
 * the source does not is left alone: it may be the very thing that company
 * needs, and removing it could strip access from whoever holds it. The one
 * exception is a role's own grants, which are replaced outright -- a
 * permission the source has withdrawn must not survive the copy.
 */
export async function copyCompanySettings(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getSessionContext();
  if (!context?.activeCompany) return { error: "No active company." };
  const source = context.activeCompany.companyId;

  const targets = formData.getAll("target").map(String).filter(Boolean);
  if (targets.length === 0) {
    return { error: "Choose at least one company to copy to." };
  }

  const groups = new Set(formData.getAll("group").map(String));
  if (groups.size === 0) {
    return { error: "Choose at least one thing to copy." };
  }

  const supabase = await createClient();

  /*
   * Writing settings into a company is administering it, so the caller has to
   * be entitled to. A super admin may reach any; anyone else only those they
   * administer. Checked per target rather than once.
   */
  const { data: seats } = await supabase
    .from("company_users")
    .select("company_id, is_company_admin, is_active")
    .eq("user_id", context.userId);

  const administers = new Set(
    (seats ?? [])
      .filter((seat) => seat.is_company_admin && seat.is_active)
      .map((seat) => seat.company_id as string),
  );

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .in("id", [...targets, source]);
  const nameOf = new Map((companies ?? []).map((row) => [row.id, row.name]));

  for (const target of targets) {
    if (target === source) {
      return { error: "That is the company being copied from." };
    }
    if (!context.isSuperAdmin && !administers.has(target)) {
      return {
        error: `You do not administer ${nameOf.get(target) ?? "that company"}, so its settings cannot be changed from here.`,
      };
    }
  }

  const done = new Set<string>();

  for (const target of targets) {
    // Accounts are matched by code, so a link can be carried across without
    // pointing at the source company's own row.
    const [{ data: fromAccounts }, { data: toAccounts }] = await Promise.all([
      supabase.from("chart_of_accounts").select("id, code").eq("company_id", source),
      supabase.from("chart_of_accounts").select("id, code").eq("company_id", target),
    ]);
    const codeOf = new Map((fromAccounts ?? []).map((row) => [row.id, row.code]));
    const idOfCode = new Map((toAccounts ?? []).map((row) => [row.code, row.id]));
    const remap = (id: string | null) =>
      id ? (idOfCode.get(codeOf.get(id) ?? "") ?? null) : null;

    if (groups.has("print")) {
      const { data: layout } = await supabase
        .from("invoice_print_settings")
        .select("*")
        .eq("company_id", source)
        .maybeSingle();

      if (layout) {
        const patch: Record<string, unknown> = { company_id: target };
        for (const [key, value] of Object.entries(layout)) {
          if (key === "company_id" || key === "updated_at") continue;
          patch[key] = value;
        }
        const { error } = await supabase
          .from("invoice_print_settings")
          .upsert(patch, { onConflict: "company_id" });
        if (error) return { error: `Print layout: ${error.message}` };
      }

      /*
       * The mark is a file, not a setting, so it is copied rather than
       * pointed at. A path into the source company's folder would be refused
       * by storage when the target came to read it.
       */
      const { data: from } = await supabase
        .from("companies")
        .select("logo_path")
        .eq("id", source)
        .maybeSingle<{ logo_path: string | null }>();

      if (from?.logo_path) {
        const { data: file } = await supabase.storage
          .from("documents")
          .download(from.logo_path);

        if (file) {
          const leaf = from.logo_path.split("/").pop() ?? "logo";
          const path = `${target}/branding/${Date.now()}-${leaf}`;
          const { error: failed } = await supabase.storage
            .from("documents")
            .upload(path, file, { upsert: false });

          if (!failed) {
            const { data: had } = await supabase
              .from("companies")
              .select("logo_path")
              .eq("id", target)
              .maybeSingle<{ logo_path: string | null }>();
            await supabase
              .from("companies")
              .update({ logo_path: path })
              .eq("id", target);
            if (had?.logo_path) {
              await supabase.storage.from("documents").remove([had.logo_path]);
            }
          }
        }
      }
      done.add("print layout");
    }

    if (groups.has("tax")) {
      const { data: rates } = await supabase
        .from("tax_rates")
        .select("kind, code, label, rate, atc, note, is_active, sort")
        .eq("company_id", source);

      if (rates?.length) {
        const { error } = await supabase
          .from("tax_rates")
          .upsert(
            rates.map((row) => ({ ...row, company_id: target })),
            { onConflict: "company_id,kind,code" },
          );
        if (error) return { error: `Tax rates: ${error.message}` };
      }

      const { data: settings } = await supabase
        .from("accounting_settings")
        .select("vat_rate")
        .eq("company_id", source)
        .maybeSingle<{ vat_rate: string }>();

      if (settings) {
        await supabase
          .from("accounting_settings")
          .update({ vat_rate: settings.vat_rate })
          .eq("company_id", target);
      }
      done.add("tax rates and VAT");
    }

    if (groups.has("roles")) {
      const { data: sourceRoles } = await supabase
        .from("roles")
        .select("id, name, description, is_active")
        .eq("company_id", source);
      const { data: targetRoles } = await supabase
        .from("roles")
        .select("id, name")
        .eq("company_id", target);

      const existing = new Map(
        (targetRoles ?? []).map((row) => [row.name.toLowerCase(), row.id]),
      );

      for (const role of sourceRoles ?? []) {
        let roleId: string | undefined = existing.get(role.name.toLowerCase());

        if (roleId) {
          await supabase
            .from("roles")
            .update({
              description: role.description,
              is_active: role.is_active,
            })
            .eq("id", roleId);
        } else {
          const { data: made, error } = await supabase
            .from("roles")
            .insert({
              company_id: target,
              name: role.name,
              description: role.description,
              is_active: role.is_active,
            })
            .select("id")
            .single();
          if (error) return { error: `Role ${role.name}: ${error.message}` };
          roleId = made?.id;
        }
        if (!roleId) continue;

        const { data: grants } = await supabase
          .from("role_permissions")
          .select("*")
          .eq("role_id", role.id);

        // Replaced outright: a permission the source has withdrawn must not
        // survive in the copy.
        await supabase.from("role_permissions").delete().eq("role_id", roleId);
        if (grants?.length) {
          const { error } = await supabase
            .from("role_permissions")
            .insert(grants.map((grant) => ({ ...grant, role_id: roleId })));
          if (error) return { error: `Permissions for ${role.name}: ${error.message}` };
        }
      }
      done.add("roles and permissions");
    }

    if (groups.has("lists")) {
      // Added where missing, matched by name. Nothing the target already has
      // is touched, so a list edited locally keeps its edits.
      const missing = async <T extends { name: string }>(
        table: string,
        columns: string,
      ) => {
        const [{ data: from }, { data: to }] = await Promise.all([
          supabase.from(table).select(columns).eq("company_id", source),
          supabase.from(table).select("name").eq("company_id", target),
        ]);
        const have = new Set(
          ((to ?? []) as { name: string }[]).map((row) => row.name.toLowerCase()),
        );
        return ((from ?? []) as unknown as T[]).filter(
          (row) => !have.has(row.name.toLowerCase()),
        );
      };

      const terms = await missing<{ name: string }>(
        "payment_terms",
        "name, days, is_active, sort_order",
      );
      if (terms.length) {
        await supabase
          .from("payment_terms")
          .insert(terms.map((row) => ({ ...row, company_id: target })));
      }

      const categories = await missing<{ name: string }>(
        "inventory_categories",
        "name",
      );
      if (categories.length) {
        await supabase
          .from("inventory_categories")
          .insert(categories.map((row) => ({ ...row, company_id: target })));
      }

      const items = await missing<{
        name: string;
        description: string | null;
        unit_of_measure: string | null;
        default_cost: string | null;
        expense_account_id: string | null;
        is_active: boolean;
      }>(
        "non_stock_items",
        "name, description, unit_of_measure, default_cost, expense_account_id, is_active",
      );
      for (const item of items) {
        // No code: the target issues one from its own counter, so its
        // numbering starts where it should rather than inheriting the source's.
        await supabase.from("non_stock_items").insert({
          company_id: target,
          name: item.name,
          description: item.description,
          unit_of_measure: item.unit_of_measure,
          default_cost: item.default_cost,
          expense_account_id: remap(item.expense_account_id),
          is_active: item.is_active,
        });
      }
      done.add("reference lists");
    }
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.adminCompanies,
    entityTable: "companies",
    entityId: source,
    summary: `Copied ${[...done].join(", ")} from ${nameOf.get(source) ?? "this company"} to ${targets.length} other company/companies.`,
    after: { targets, groups: [...groups] },
  });

  revalidatePath("/admin/companies");
  return {
    success: `Copied ${[...done].join(", ")} to ${targets.length} company/companies.`,
  };
}
