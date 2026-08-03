import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { MovementHistory, type MovementRow } from "../movement-history";

export const metadata: Metadata = { title: "Movement history" };

export default async function MovementHistoryPage() {
  const context = await requirePermission(MODULE.inventoryMovements, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const { data: movements } = await supabase
    .from("inventory_movements")
    .select(
      `id, movement_kind, quantity, unit_cost, note, created_at, reference_table,
       inventory_items(name, unit_of_measure),
       profiles!inventory_movements_created_by_fkey(full_name, email)`,
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    // The search filters what is loaded, so it needs the ledger rather than a
    // glimpse of it.
    .limit(500)
    .returns<
      {
        id: string;
        movement_kind: string;
        quantity: string;
        unit_cost: string;
        note: string | null;
        created_at: string;
        reference_table: string | null;
        inventory_items: { name: string; unit_of_measure: string } | null;
        profiles: { full_name: string | null; email: string } | null;
      }[]
    >();

  const rows: MovementRow[] = (movements ?? []).map((movement) => ({
    id: movement.id,
    movement_kind: movement.movement_kind,
    quantity: Number(movement.quantity),
    unit_cost: Number(movement.unit_cost),
    note: movement.note,
    created_at: movement.created_at,
    item: movement.inventory_items?.name ?? "Unknown item",
    unit: movement.inventory_items?.unit_of_measure ?? "",
    who: movement.profiles?.full_name || movement.profiles?.email || "—",
  }));

  return (
    <>
      <PageHeader
        title="Movement history"
        description="Every receipt, issue, return and count correction, newest first."
        action={
          <Link href="/inventory" className="btn btn-secondary btn-sm">
            Back to item list
          </Link>
        }
      />

      <MovementHistory rows={rows} />
    </>
  );
}
