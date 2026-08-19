import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createCategory, renameCategory } from "../actions";
import { CategoryForm, CategoryRename } from "../inventory-forms";

export const metadata: Metadata = { title: "Categories" };

type CategoryRow = {
  id: string;
  name: string;
  inventory_items: { id: string }[];
};

export default async function CategoriesPage() {
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.inventoryItems, "edit");

  const supabase = await createClient();
  const { data: categories } = await supabase
    .from("inventory_categories")
    .select("id, name, inventory_items(id)")
    .eq("company_id", companyId)
    .order("name")
    .returns<CategoryRow[]>();

  const rows = categories ?? [];

  return (
    <>
      <PageHeader
        title="Categories"
        description="Groups items on the list and in reports."
        action={
          <Link href="/inventory" className="btn btn-secondary btn-sm">
            Back to item list
          </Link>
        }
      />

      {canEdit ? (
        <div className="mb-6">
          <Card title="Add a category">
            <CategoryForm action={createCategory} />
          </Card>
        </div>
      ) : null}

      <Card title={`${rows.length} categor${rows.length === 1 ? "y" : "ies"}`} bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="text-right">Items</th>
                  {canEdit ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((category) => (
                  <tr key={category.id}>
                    <td className="text-sm">{category.name}</td>
                    <td className="text-right tabular-nums">
                      {(category.inventory_items ?? []).length}
                    </td>
                    {canEdit ? (
                      <td className="text-right">
                        <CategoryRename action={renameCategory} category={category} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No categories yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
