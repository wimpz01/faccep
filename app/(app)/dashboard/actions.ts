"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { PANEL_KEYS, TILE_KEYS } from "./layout-order";

export type ActionState = { error?: string; success?: string };

/**
 * Remembers where this person dragged their dashboard panels.
 *
 * Only keys the app actually has are stored, so a stale or hand-made request
 * cannot fill the row with rubbish that has to be filtered on every read. The
 * layout decides nothing and is safe to lose, so a failure here is reported
 * quietly rather than thrown -- the dashboard the reader is looking at is
 * already in the order they just dragged.
 */
export async function saveDashboardLayout(
  panels: string[],
  tiles: string[],
): Promise<ActionState> {
  const context = await requireSession();
  const companyId = context.activeCompany?.companyId;
  if (!companyId) return { error: "No company is active." };

  const clean = (given: string[], known: readonly string[]) =>
    given.filter(
      (key, index, all) => known.includes(key) && all.indexOf(key) === index,
    );

  const supabase = await createClient();
  const { error } = await supabase.from("dashboard_layouts").upsert(
    {
      user_id: context.userId,
      company_id: companyId,
      panels: clean(panels, PANEL_KEYS),
      tiles: clean(tiles, TILE_KEYS),
    },
    { onConflict: "user_id,company_id" },
  );

  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  return { success: "Layout saved." };
}

/** Puts the dashboard back the way it arrives out of the box. */
export async function resetDashboardLayout(): Promise<ActionState> {
  const context = await requireSession();
  const companyId = context.activeCompany?.companyId;
  if (!companyId) return { error: "No company is active." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("dashboard_layouts")
    .delete()
    .eq("user_id", context.userId)
    .eq("company_id", companyId);

  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  return { success: "Dashboard back to its usual order." };
}
