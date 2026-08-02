import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ReportShell } from "@/components/report-shell";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Account ledger" };

type Account = {
  id: string;
  company_id: string;
  code: string;
  name: string;
  account_type: string;
  description: string | null;
};

type LedgerLine = {
  id: string;
  description: string | null;
  debit: string;
  credit: string;
  journal_entries: {
    id: string;
    entry_no: string;
    entry_date: string;
    memo: string | null;
    status: string;
    source_table: string | null;
  } | null;
};

/** Assets and expenses increase on the debit side; everything else on credit. */
function isDebitNormal(type: string) {
  return type === "asset" || type === "expense";
}

function defaultRange() {
  const now = new Date();
  return {
    from: `${now.getFullYear()}-01-01`,
    to: new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString()
      .slice(0, 10),
  };
}

export default async function AccountLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsFinancials, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;

  const supabase = await createClient();

  const { data: account, error: accountError } = await supabase
    .from("chart_of_accounts")
    .select("id, company_id, code, name, account_type, description")
    .eq("id", id)
    .maybeSingle<Account>();

  if (accountError) {
    throw new Error(`Account ${id}: ${accountError.message}`);
  }
  if (!account || account.company_id !== companyId) notFound();

  // Only posted entries are the ledger; a draft has not happened yet.
  const [{ data: lines }, { data: openingLines }] = await Promise.all([
    supabase
      .from("journal_lines")
      .select(
        `id, description, debit, credit,
         journal_entries!inner(id, entry_no, entry_date, memo, status, source_table)`,
      )
      .eq("account_id", id)
      .eq("journal_entries.status", "posted")
      .gte("journal_entries.entry_date", from)
      .lte("journal_entries.entry_date", to)
      .order("entry_date", { referencedTable: "journal_entries" })
      .returns<LedgerLine[]>(),
    supabase
      .from("journal_lines")
      .select("debit, credit, journal_entries!inner(entry_date, status)")
      .eq("account_id", id)
      .eq("journal_entries.status", "posted")
      .lt("journal_entries.entry_date", from)
      .returns<{ debit: string; credit: string }[]>(),
  ]);

  const rows = lines ?? [];
  const debitNormal = isDebitNormal(account.account_type);
  const signed = (debit: number, credit: number) =>
    debitNormal ? debit - credit : credit - debit;

  const opening = round2(
    (openingLines ?? []).reduce(
      (sum, row) => sum + signed(Number(row.debit), Number(row.credit)),
      0,
    ),
  );

  const debits = round2(rows.reduce((sum, row) => sum + Number(row.debit), 0));
  const credits = round2(rows.reduce((sum, row) => sum + Number(row.credit), 0));
  const movement = round2(
    rows.reduce(
      (sum, row) => sum + signed(Number(row.debit), Number(row.credit)),
      0,
    ),
  );
  const closing = round2(opening + movement);

  // A running balance is what makes a ledger readable: every line shows what
  // the account stood at immediately after it.
  let running = opening;
  const withRunning = rows.map((row) => {
    running = round2(running + signed(Number(row.debit), Number(row.credit)));
    return { ...row, running };
  });

  return (
    <ReportShell
      title={`${account.code} — ${account.name}`}
      description={`Every posted entry against this ${account.account_type} account. ${
        debitNormal ? "Debits increase it." : "Credits increase it."
      }`}
      from={from}
      to={to}
      scopeNote={`${account.code} ${account.name}`}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-5">
        <StatTile label="Opening balance" value={money(opening)} hint={`As at ${formatDate(from)}`} />
        <StatTile label="Debits" value={money(debits)} hint={`${rows.length} line(s)`} />
        <StatTile label="Credits" value={money(credits)} />
        <StatTile
          label="Closing balance"
          value={money(closing)}
          hint={`As at ${formatDate(to)}`}
          tone="money"
        />
      </div>

      <Card
        title="Ledger"
        description="Posted entries only. Open any entry to see the other side of it."
        bodyClassName=""
      >
        {withRunning.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Entry</th>
                  <th>Narrative</th>
                  <th>Source</th>
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={6} className="text-sm font-semibold">
                    Opening balance
                  </td>
                  <td className="text-right tabular-nums font-semibold">
                    {money(opening)}
                  </td>
                </tr>
                {withRunning.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs">
                      {row.journal_entries
                        ? formatDate(row.journal_entries.entry_date)
                        : "—"}
                    </td>
                    <td className="text-sm">
                      {row.journal_entries ? (
                        <Link
                          href={`/accounting/journal/${row.journal_entries.id}`}
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {row.journal_entries.entry_no}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-sm">
                      {row.description ?? row.journal_entries?.memo ?? "—"}
                    </td>
                    <td className="text-xs muted">
                      {row.journal_entries?.source_table?.replace(/_/g, " ") ??
                        "manual"}
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(row.debit) ? money(row.debit) : "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(row.credit) ? money(row.credit) : "—"}
                    </td>
                    <td className="text-right tabular-nums font-medium">
                      {money(row.running)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="text-right font-bold">
                    Movement in the period
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(debits)}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(credits)}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(closing)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            Nothing posted to this account between {formatDate(from)} and{" "}
            {formatDate(to)}.
          </EmptyState>
        )}
      </Card>

      <p className="no-print text-sm mt-4">
        <Link href={`/accounting/reports?from=${from}&to=${to}`}>
          ← Back to the financial statements
        </Link>
      </p>
    </ReportShell>
  );
}
