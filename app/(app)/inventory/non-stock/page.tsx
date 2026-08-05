import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createNonStockItem, updateNonStockAccount } from "../actions";
import {
  AccountPicker,
  NonStockItemForm,
  type AccountOption,
} from "./non-stock-forms";

export const metadata: Metadata = { title: "Non-stock items" };

type NonStockRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit_of_measure: string;
  default_cost: string;
  expense_account_id: string;
  chart_of_accounts: { code: string; name: string } | null;
};

/**
 * Things bought that never sit on a shelf, each set up once with the account
 * it is charged to. Separate from the stock item list because nothing that
 * makes a stock item a stock item applies here.
 */
export default async function NonStockItemsPage() {
  const context = await requirePermission(MODULE.inventoryItems, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.inventoryItems, "edit");

  const supabase = await createClient();
  const [{ data: items }, { data: accounts }] = await Promise.all([
    supabase
      .from("non_stock_items")
      .select(
        `id, code, name, description, unit_of_measure, default_cost,
         expense_account_id, chart_of_accounts(code, name)`,
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name")
      .returns<NonStockRow[]>(),
    supabase
      .from("chart_of_accounts")
      .select("id, code, name, account_type")
      .eq("company_id", companyId)
      .in("account_type", ["expense", "asset"])
      .order("code")
      .returns<(AccountOption & { account_type: string })[]>(),
  ]);

  const rows = items ?? [];
  const accountOptions: AccountOption[] = (accounts ?? []).map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
  }));

  return (
    <>
      <PageHeader
        title="Non-stock items"
        description="Services and charges that are bought but never stocked — set up once with the account they are charged to."
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/inventory" className="btn btn-secondary btn-sm">
              Stock items
            </Link>
            <Link href="/inventory/accounts" className="btn btn-secondary btn-sm">
              Stock item accounts
            </Link>
          </div>
        }
      />

      {accountOptions.length === 0 ? (
        <Card title="Chart of accounts not set up">
          <EmptyState>
            A non-stock item needs an account to be charged to. Set up the chart
            of accounts first.
          </EmptyState>
        </Card>
      ) : canEdit ? (
        <div className="mb-6">
          <Card
            title="Add a non-stock item"
            description="The name and its account are set together, so a purchase never has to guess where it belongs."
          >
            <NonStockItemForm action={createNonStockItem} accounts={accountOptions} />
          </Card>
        </div>
      ) : null}

      <Card
        title={`${rows.length} non-stock item${rows.length === 1 ? "" : "s"}`}
        bodyClassName=""
      >
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th style={{ minWidth: "16rem" }}>Item</th>
                  <th>Unit</th>
                  <th className="text-right">Usual cost</th>
                  <th style={{ minWidth: "20rem" }}>Charged to</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs tabular-nums muted">{row.code}</td>
                    <td className="text-sm">
                      {row.name}
                      {row.description ? (
                        <p className="text-xs muted">{row.description}</p>
                      ) : null}
                    </td>
                    <td className="text-xs">{row.unit_of_measure}</td>
                    <td className="text-right tabular-nums text-sm">
                      {money(row.default_cost)}
                    </td>
                    <td>
                      {canEdit ? (
                        <AccountPicker
                          action={updateNonStockAccount}
                          idField="item_id"
                          idValue={row.id}
                          fieldName="expense_account_id"
                          accounts={accountOptions}
                          current={row.expense_account_id}
                        />
                      ) : (
                        <span className="text-sm">
                          {row.chart_of_accounts
                            ? `${row.chart_of_accounts.code} — ${row.chart_of_accounts.name}`
                            : "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No non-stock items yet. Add one above — security services, hauling,
            professional fees.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
