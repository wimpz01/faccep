import type { Metadata } from "next";
import Link from "next/link";

import { PrintButton } from "@/components/print-button";
import { ReportMasthead } from "@/components/report-shell";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Financial statements" };

type TrialRow = {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  debit_total: string;
  credit_total: string;
  balance: string;
};

function defaultRange() {
  const now = new Date();
  return {
    from: `${now.getFullYear()}-01-01`,
    to: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10),
  };
}

export default async function FinancialStatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; statement?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsFinancials, "view");
  const companyId = context.activeCompany!.companyId;

  const range = defaultRange();
  const from = filters.from ?? range.from;
  const to = filters.to ?? range.to;

  /*
   * Which statement is wanted. All four are worked out either way -- the
   * filter only decides what reaches the page, so printing one gives a sheet
   * with that statement on it and nothing else stapled behind it.
   */
  const STATEMENTS = {
    all: "All statements",
    income: "Income statement",
    balance: "Balance sheet",
    trial: "Trial balance",
    cashflow: "Cash flow",
  } as const;
  type StatementKey = keyof typeof STATEMENTS;
  const statement: StatementKey =
    filters.statement && filters.statement in STATEMENTS
      ? (filters.statement as StatementKey)
      : "all";
  const shows = (key: Exclude<StatementKey, "all">) =>
    statement === "all" || statement === key;

  const supabase = await createClient();

  // Period figures drive the income statement; inception-to-date drives the
  // balance sheet, because balance-sheet accounts accumulate.
  const [{ data: period }, { data: cumulative }] = await Promise.all([
    supabase.rpc("trial_balance", { p_company: companyId, p_from: from, p_to: to }),
    supabase.rpc("trial_balance", {
      p_company: companyId,
      p_from: "1900-01-01",
      p_to: to,
    }),
  ]);

  // rpc() does not infer set-returning types, so the shape is asserted here.
  const periodRows = (period ?? []) as TrialRow[];
  const cumulativeRows = (cumulative ?? []) as TrialRow[];

  const byType = (rows: TrialRow[], type: string) =>
    rows.filter((row) => row.account_type === type && Number(row.balance) !== 0);

  const income = byType(periodRows, "income");
  const expenses = byType(periodRows, "expense");
  const totalIncome = round2(
    income.reduce((sum, row) => sum + Number(row.balance), 0),
  );
  const totalExpense = round2(
    expenses.reduce((sum, row) => sum + Number(row.balance), 0),
  );
  const netIncome = round2(totalIncome - totalExpense);

  const assets = byType(cumulativeRows, "asset");
  const liabilities = byType(cumulativeRows, "liability");
  const equity = byType(cumulativeRows, "equity");

  // Net income for the whole period to date rolls into equity on the balance
  // sheet, mirroring a close to retained earnings.
  const cumulativeIncome = round2(
    byType(cumulativeRows, "income").reduce(
      (sum, row) => sum + Number(row.balance),
      0,
    ),
  );
  const cumulativeExpense = round2(
    byType(cumulativeRows, "expense").reduce(
      (sum, row) => sum + Number(row.balance),
      0,
    ),
  );
  const retained = round2(cumulativeIncome - cumulativeExpense);

  const totalAssets = round2(assets.reduce((sum, row) => sum + Number(row.balance), 0));
  const totalLiabilities = round2(
    liabilities.reduce((sum, row) => sum + Number(row.balance), 0),
  );
  const totalEquity = round2(
    equity.reduce((sum, row) => sum + Number(row.balance), 0) + retained,
  );
  const outOfBalance = round2(totalAssets - (totalLiabilities + totalEquity));

  const trialDebits = round2(
    periodRows.reduce((sum, row) => sum + Number(row.debit_total), 0),
  );
  const trialCredits = round2(
    periodRows.reduce((sum, row) => sum + Number(row.credit_total), 0),
  );

  const hasData = periodRows.some(
    (row) => Number(row.debit_total) !== 0 || Number(row.credit_total) !== 0,
  );

  /** Every figure on a statement is a way into the entries behind it. */
  function AccountLink({ row }: { row: TrialRow }) {
    return (
      <Link
        href={`/accounting/accounts/${row.account_id}?from=${from}&to=${to}`}
        style={{ color: "inherit" }}
      >
        <span className="tabular-nums muted">{row.code}</span>{" "}
        <span style={{ color: "var(--color-brand-600)", fontWeight: 500 }}>
          {row.name}
        </span>
      </Link>
    );
  }

  function Section({
    title,
    rows,
    total,
  }: {
    title: string;
    rows: TrialRow[];
    total: number;
  }) {
    return (
      <>
        <tr>
          <td colSpan={2} className="font-bold" style={{ paddingTop: "0.9rem" }}>
            {title}
          </td>
        </tr>
        {rows.length > 0 ? (
          rows.map((row) => (
            <tr key={row.account_id}>
              <td className="text-sm" style={{ paddingLeft: "1.5rem" }}>
                <AccountLink row={row} />
              </td>
              <td className="text-right tabular-nums">{money(row.balance)}</td>
            </tr>
          ))
        ) : (
          <tr>
            <td className="text-xs muted" style={{ paddingLeft: "1.5rem" }}>
              Nothing posted
            </td>
            <td className="text-right tabular-nums">{money(0)}</td>
          </tr>
        )}
        <tr>
          <td className="font-semibold" style={{ paddingLeft: "0.75rem" }}>
            Total {title.toLowerCase()}
          </td>
          <td className="text-right tabular-nums font-semibold">{money(total)}</td>
        </tr>
      </>
    );
  }

  return (
    <>
      <ReportMasthead
        companyName={context.activeCompany?.companyName}
        title={statement === "all" ? "Financial statements" : STATEMENTS[statement]}
        from={from}
        to={to}
      />

      <div className="no-print">
        <PageHeader
          title="Financial statements"
          description="Built from posted journal entries only. Drafts are excluded."
          action={
            <div className="flex gap-2 flex-wrap">
              <Link
                href="/accounting/reports/quarterly"
                className="btn btn-secondary btn-sm"
              >
                Quarterly
              </Link>
              <Link href="/accounting/journal" className="btn btn-secondary btn-sm">
                Journal
              </Link>
              <PrintButton />
            </div>
          }
        />

        <div className="mb-5">
          <Card>
            <form method="get" className="grid gap-3 sm:grid-cols-4 items-end">
              <div>
                <label className="label" htmlFor="statement">
                  Statement
                </label>
                <select
                  id="statement"
                  name="statement"
                  className="select"
                  defaultValue={statement}
                >
                  {Object.entries(STATEMENTS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="from">
                  From
                </label>
                <input
                  id="from"
                  name="from"
                  type="date"
                  className="input"
                  defaultValue={from}
                />
              </div>
              <div>
                <label className="label" htmlFor="to">
                  To
                </label>
                <input id="to" name="to" type="date" className="input" defaultValue={to} />
              </div>
              <div>
                <button type="submit" className="btn btn-primary">
                  Apply
                </button>
              </div>
            </form>
          </Card>
        </div>
      </div>

      {!hasData ? (
        <Card>
          <EmptyState>
            Nothing has been posted to the ledger in this range.
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {shows("income") ? (
          <Card
            title="Income statement"
            description={`${formatDate(from)} to ${formatDate(to)}`}
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  <Section title="Income" rows={income} total={totalIncome} />
                  <Section title="Expenses" rows={expenses} total={totalExpense} />
                  <tr>
                    <td className="font-bold" style={{ paddingTop: "0.9rem" }}>
                      Net income
                    </td>
                    <td
                      className="text-right tabular-nums font-bold"
                      style={{
                        paddingTop: "0.9rem",
                        color:
                          netIncome >= 0 ? "var(--success)" : "var(--danger)",
                      }}
                    >
                      {money(netIncome)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          ) : null}

          {shows("balance") ? (
          <Card
            title="Balance sheet"
            description={`As at ${formatDate(to)}`}
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  <Section title="Assets" rows={assets} total={totalAssets} />
                  <Section title="Liabilities" rows={liabilities} total={totalLiabilities} />
                  <tr>
                    <td colSpan={2} className="font-bold" style={{ paddingTop: "0.9rem" }}>
                      Equity
                    </td>
                  </tr>
                  {equity.map((row) => (
                    <tr key={row.account_id}>
                      <td className="text-sm" style={{ paddingLeft: "1.5rem" }}>
                        <AccountLink row={row} />
                      </td>
                      <td className="text-right tabular-nums">{money(row.balance)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="text-sm" style={{ paddingLeft: "1.5rem" }}>
                      Retained earnings (net income to date)
                    </td>
                    <td className="text-right tabular-nums">{money(retained)}</td>
                  </tr>
                  <tr>
                    <td className="font-semibold" style={{ paddingLeft: "0.75rem" }}>
                      Total equity
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(totalEquity)}
                    </td>
                  </tr>
                  <tr>
                    <td className="font-bold" style={{ paddingTop: "0.9rem" }}>
                      Liabilities and equity
                    </td>
                    <td
                      className="text-right tabular-nums font-bold"
                      style={{ paddingTop: "0.9rem" }}
                    >
                      {money(totalLiabilities + totalEquity)}
                    </td>
                  </tr>
                  {outOfBalance !== 0 ? (
                    <tr>
                      <td style={{ color: "var(--danger)" }}>
                        Out of balance — investigate before relying on this
                      </td>
                      <td
                        className="text-right tabular-nums"
                        style={{ color: "var(--danger)" }}
                      >
                        {money(outOfBalance)}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
          ) : null}

          {shows("trial") ? (
          <Card
            title="Trial balance"
            description={`${formatDate(from)} to ${formatDate(to)} · debits and credits must agree`}
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="text-right">Debit</th>
                    <th className="text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {periodRows
                    .filter(
                      (row) =>
                        Number(row.debit_total) !== 0 ||
                        Number(row.credit_total) !== 0,
                    )
                    .map((row) => (
                      <tr key={row.account_id}>
                        <td className="text-sm">
                          <AccountLink row={row} />
                        </td>
                        <td className="text-right tabular-nums">
                          {Number(row.debit_total) ? money(row.debit_total) : ""}
                        </td>
                        <td className="text-right tabular-nums">
                          {Number(row.credit_total) ? money(row.credit_total) : ""}
                        </td>
                      </tr>
                    ))}
                  <tr>
                    <td className="font-bold">Totals</td>
                    <td className="text-right tabular-nums font-bold">
                      {money(trialDebits)}
                    </td>
                    <td
                      className="text-right tabular-nums font-bold"
                      style={{
                        color:
                          trialDebits === trialCredits
                            ? "var(--success)"
                            : "var(--danger)",
                      }}
                    >
                      {money(trialCredits)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          ) : null}

          {shows("cashflow") ? (
          <Card
            title="Cash flow"
            description="Indirect method: net income adjusted for the movement in working capital."
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  <tr>
                    <td className="text-sm">Net income for the period</td>
                    <td className="text-right tabular-nums">{money(netIncome)}</td>
                  </tr>
                  <tr>
                    <td className="text-sm">
                      Movement in receivables and payables
                    </td>
                    <td className="text-right tabular-nums">
                      {money(
                        round2(
                          -(
                            Number(
                              cumulativeRows.find((row) => row.code === "1100")
                                ?.balance ?? 0,
                            ) -
                            Number(
                              cumulativeRows.find((row) => row.code === "2000")
                                ?.balance ?? 0,
                            )
                          ),
                        ),
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="font-bold">Cash and bank balance at {formatDate(to)}</td>
                    <td className="text-right tabular-nums font-bold">
                      {money(
                        round2(
                          Number(
                            cumulativeRows.find((row) => row.code === "1000")?.balance ??
                              0,
                          ) +
                            Number(
                              cumulativeRows.find((row) => row.code === "1010")
                                ?.balance ?? 0,
                            ),
                        ),
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs muted px-5 pb-4">
              This is a simplified indirect statement keyed to the standard chart
              codes. If you rename or renumber cash, receivable or payable
              accounts, revisit this section.
            </p>
          </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
