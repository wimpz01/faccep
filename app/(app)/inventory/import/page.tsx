import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";

import { importItems } from "../actions";
import { ImportItemsForm } from "../inventory-forms";

export const metadata: Metadata = { title: "Import items" };

export default async function ImportItemsPage() {
  await requirePermission(MODULE.inventoryItems, "edit");

  return (
    <>
      <PageHeader
        title="Import a list"
        description="Many at once from a spreadsheet, instead of typing them in one by one."
        action={
          <Link href="/inventory" className="btn btn-secondary btn-sm">
            Back to item list
          </Link>
        }
      />

      <Card title="Spreadsheet">
        <ImportItemsForm action={importItems} />
      </Card>
    </>
  );
}
