import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createItem } from "../actions";
import { ItemForm } from "../inventory-forms";

export const metadata: Metadata = { title: "Add an item" };

export default async function NewItemPage() {
  const context = await requirePermission(MODULE.inventoryItems, "edit");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const { data: categories } = await supabase
    .from("inventory_categories")
    .select("id, name")
    .eq("company_id", companyId)
    .order("name")
    .returns<{ id: string; name: string }[]>();

  return (
    <>
      <PageHeader
        title="Add an item"
        description="One at a time. The SKU is issued on save."
        action={
          <Link href="/inventory" className="btn btn-secondary btn-sm">
            Back to item list
          </Link>
        }
      />

      <Card title="Item details">
        <ItemForm action={createItem} categories={categories ?? []} />
      </Card>
    </>
  );
}
