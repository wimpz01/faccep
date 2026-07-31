import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createAccount, seedChart } from "../actions";
import { AccountForm, SeedChartForm } from "../accounting-forms";

export const metadata: Metadata = { title: "Chart of accounts" };

type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  description: string | null;
};

const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];
const TYPE_LABELS: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

export default async function ChartOfAccountsPage() {
  const context = await requirePermission(MODULE.accountingCoa, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.accountingCoa, "edit");

  const supabase = await createClient();
  const { data: accounts } = await supabase
    .from("chart_of_accounts")
    .select("id, code, name, account_type, description")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("code")
    .returns<AccountRow[]>();

  const rows = accounts ?? [];
  const grouped = TYPE_ORDER.map((type) => ({
    type,
    items: rows.filter((account) => account.account_type === type),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="Each company keeps its own chart. Assets and expenses are debit-normal; the rest are credit-normal."
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/accounting/journal" className="btn btn-secondary btn-sm">
              Journal
            </Link>
            <Link href="/accounting/reports" className="btn btn-secondary btn-sm">
              Financial statements
            </Link>
          </div>
        }
      />

      {rows.length === 0 && canEdit ? (
        <div className="mb-6">
          <Card
            title="Start from the standard chart"
            description="Installs a Philippine SME chart — cash, receivables, payables, VAT and withholding tax, rental and utility income, and the usual expenses. Everything stays editable."
          >
            <SeedChartForm action={seedChart} />
          </Card>
        </div>
      ) : null}

      {canEdit ? (
        <div className="mb-6">
          <Card title="Add an account">
            <AccountForm action={createAccount} />
          </Card>
        </div>
      ) : null}

      {grouped.length > 0 ? (
        <div className="flex flex-col gap-5">
          {grouped.map((group) => (
            <Card key={group.type} title={TYPE_LABELS[group.type]} bodyClassName="">
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: "8rem" }}>Code</th>
                      <th>Account</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((account) => (
                      <tr key={account.id}>
                        <td className="tabular-nums text-sm">{account.code}</td>
                        <td>
                          <span className="text-sm">{account.name}</span>
                          {account.description ? (
                            <p className="text-xs muted">{account.description}</p>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState>
            No accounts yet
            {canEdit ? " — install the standard chart above." : "."}
          </EmptyState>
        </Card>
      )}
    </>
  );
}
