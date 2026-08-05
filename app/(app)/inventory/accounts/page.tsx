import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { updateItemAdjustmentAccount, updateItemStockAccount } from "../actions";
import { AccountPicker, type AccountOption } from "../non-stock/non-stock-forms";

export const metadata: Metadata = { title: "Stock item accounts" };

type ItemRow = {
  id: string;
  sku: string | null;
  name: string;
  adjustment_account_id: string | null;
  inventory_account_id: string | null;
  inventory_categories: { name: string } | null;
};

/**
 * Where corrections to each stock item are charged.
 *
 * Stock itself always goes to the inventory account -- that is what makes it
 * stock. What differs by item is where a shortage lands, which is why this
 * asks about adjustments and nothing else.
 */
export default async function StockItemAccountsPage() {
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.inventoryItems, "edit");

  const supabase = await createClient();
  const [{ data: items }, { data: accounts }, { data: settings }] =
    await Promise.all([
      supabase
        .from("inventory_items")
        .select("id, sku, name, adjustment_account_id, inventory_account_id, inventory_categories(name)")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name")
        .returns<ItemRow[]>(),
      supabase
        .from("chart_of_accounts")
        .select("id, code, name")
        .eq("company_id", companyId)
        .in("account_type", ["expense", "asset"])
        .order("code")
        .returns<AccountOption[]>(),
      supabase
        .from("accounting_settings")
        .select("inventory_adjustment_id, inventory_account_id")
        .eq("company_id", companyId)
        .maybeSingle<{
          inventory_adjustment_id: string | null;
          inventory_account_id: string | null;
        }>(),
    ]);

  const rows = items ?? [];
  const accountOptions = accounts ?? [];
  const companyDefault = accountOptions.find(
    (account) => account.id === settings?.inventory_adjustment_id,
  );
  // Where stock sits unless an item says otherwise: 1200 Inventory - Supplies.
  const stockDefault =
    accountOptions.find((account) => account.id === settings?.inventory_account_id) ??
    accountOptions.find((account) => account.code === "1200");

  return (
    <>
      <PageHeader
        title="Stock item accounts"
        description="Where a correction to each item is charged when an adjustment is posted."
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/inventory" className="btn btn-secondary btn-sm">
              Stock items
            </Link>
            <Link href="/inventory/non-stock" className="btn btn-secondary btn-sm">
              Non-stock items
            </Link>
          </div>
        }
      />

      <div className="mb-6">
        <Card title="Defaults">
          <p className="text-sm">
            Stock is held in{" "}
            <strong>
              {stockDefault
                ? `${stockDefault.code} — ${stockDefault.name}`
                : "1200 — Inventory - Supplies"}
            </strong>{" "}
            unless an item says otherwise.
          </p>
          <p className="text-sm mt-2">
            Corrections are charged to{" "}
            <strong>
              {companyDefault
                ? `${companyDefault.code} — ${companyDefault.name}`
                : "5700 — Inventory Adjustments"}
            </strong>
            . Shortages debit it and overages credit it, so the two net against
            each other over a year.
          </p>
        </Card>
      </div>

      <Card title={`${rows.length} stock item${rows.length === 1 ? "" : "s"}`} bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU #</th>
                  <th style={{ minWidth: "16rem" }}>Item</th>
                  <th>Category</th>
                  <th style={{ minWidth: "20rem" }}>Held in</th>
                  <th style={{ minWidth: "20rem" }}>Adjustments charged to</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs tabular-nums muted">{row.sku ?? "—"}</td>
                    <td className="text-sm">{row.name}</td>
                    <td className="text-xs">
                      {row.inventory_categories?.name ?? "—"}
                    </td>
                    <td>
                      {canEdit ? (
                        <AccountPicker
                          action={updateItemStockAccount}
                          idField="item_id"
                          idValue={row.id}
                          fieldName="inventory_account_id"
                          accounts={accountOptions}
                          current={row.inventory_account_id ?? stockDefault?.id ?? null}
                        />
                      ) : (
                        <span className="text-sm">
                          {row.inventory_account_id ? "Set" : "Company default"}
                        </span>
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <AccountPicker
                          action={updateItemAdjustmentAccount}
                          idField="item_id"
                          idValue={row.id}
                          fieldName="adjustment_account_id"
                          accounts={accountOptions}
                          current={row.adjustment_account_id}
                          allowNone
                        />
                      ) : (
                        <span className="text-sm">
                          {row.adjustment_account_id ? "Set" : "Company default"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No stock items yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
