import type { Metadata } from "next";
import Link from "next/link";

import { PrintButton } from "@/components/print-button";
import { ReportMasthead } from "@/components/report-shell";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Quarterly income comparison" };

type TrialRow = {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  balance: string;
};

const QUARTERS = [1, 2, 3, 4] as const;

/** The calendar quarter's first and last day. */
function quarterRange(year: number, quarter: number) {
  const iso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  return {
    from: iso(new Date(year, (quarter - 1) * 3, 1)),
    to: iso(new Date(year, quarter * 3, 0)),
  };
}

/**
 * The income statement, one quarter beside another.
 *
 * A single-period statement says what happened; it does not say whether that
 * is normal. Rent that dips in Q3 or a repair bill that trebles only shows up
 * against the quarters either side of it, which is the whole reason for
 * reading the year across rather than down.
 *
 * Every quarter is drawn from the same trial_balance the main statements use,
 * so a figure here and a figure there cannot disagree.
 */
export default async function QuarterlyIncomePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; location?: string }>;
}) {
  const filters = await searchParams;
  const context = await requirePermission(MODULE.reportsFinancials, "view");
  const companyId = context.activeCompany!.companyId;

  const thisYear = new Date().getFullYear();
  const parsed = Number(filters.year);
  const year =
    Number.isFinite(parsed) && parsed > 1990 && parsed < 2200 ? parsed : thisYear;

  const location =
    filters.location && filters.location !== "all" ? filters.location : null;

  const supabase = await createClient();

  /*
   * Drawn from income_statement rather than trial_balance so the year can
   * be read for one property. With none chosen it returns the same income
   * and expense figures the trial balance does, so this page and the
   * statements still agree.
   */
  const [quarters, { data: locations }] = await Promise.all([
    Promise.all(
      QUARTERS.map(async (quarter) => {
        const { from, to } = quarterRange(year, quarter);
        const { data } = await supabase.rpc("income_statement", {
          p_company: companyId,
          p_from: from,
          p_to: to,
          p_location: location,
        });
        return { quarter, rows: (data ?? []) as TrialRow[] };
      }),
    ),
    supabase
      .from("locations")
      .select("id, code, name")
      .eq("company_id", companyId)
      .order("code")
      .returns<{ id: string; code: string; name: string }[]>(),
  ]);

  /*
   * One row per account, with a cell per quarter. Built from every quarter's
   * accounts rather than the first one's, or an account that only traded later
   * in the year would be missing its own row.
   */
  function linesOf(type: string) {
    const names = new Map<string, { code: string; name: string }>();
    for (const { rows } of quarters) {
      for (const row of rows) {
        if (row.account_type === type) {
          names.set(row.account_id, { code: row.code, name: row.name });
        }
      }
    }

    const lines = [...names.entries()]
      .map(([accountId, account]) => {
        const byQuarter = quarters.map(({ rows }) =>
          round2(
            Number(
              rows.find((row) => row.account_id === accountId)?.balance ?? 0,
            ),
          ),
        );
        return {
          accountId,
          ...account,
          byQuarter,
          total: round2(byQuarter.reduce((sum, value) => sum + value, 0)),
        };
      })
      // An account that never moved all year is noise on a comparison.
      .filter((line) => line.total !== 0 || line.byQuarter.some((v) => v !== 0))
      .sort((a, b) => a.code.localeCompare(b.code));

    const totals = QUARTERS.map((_, index) =>
      round2(lines.reduce((sum, line) => sum + line.byQuarter[index], 0)),
    );
    return {
      lines,
      totals,
      grand: round2(totals.reduce((sum, value) => sum + value, 0)),
    };
  }

  const income = linesOf("income");
  const expense = linesOf("expense");
  const net = QUARTERS.map((_, index) =>
    round2(income.totals[index] - expense.totals[index]),
  );
  const netGrand = round2(income.grand - expense.grand);
  const hasData = income.lines.length > 0 || expense.lines.length > 0;

  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];

  const locationLabel = !location
    ? null
    : location === "unallocated"
      ? "Unallocated"
      : (() => {
          const place = (locations ?? []).find((row) => row.id === location);
          return place ? `${place.code} — ${place.name}` : "Unknown property";
        })();

  /** A row of figures across the four quarters, then the year. */
  function Figures({
    values,
    total,
    bold,
    tone,
  }: {
    values: number[];
    total: number;
    bold?: boolean;
    tone?: string;
  }) {
    const cell = bold
      ? "text-right tabular-nums font-bold"
      : "text-right tabular-nums";
    return (
      <>
        {values.map((value, index) => (
          <td key={index} className={cell} style={tone ? { color: tone } : undefined}>
            {value === 0 ? "—" : money(value)}
          </td>
        ))}
        <td className={cell} style={tone ? { color: tone } : undefined}>
          {money(total)}
        </td>
      </>
    );
  }

  return (
    <>
      <ReportMasthead
        companyName={context.activeCompany?.companyName}
        title="Income statement — quarterly comparison"
        scopeNote={`Year ${year}${locationLabel ? ` · ${locationLabel}` : ""}`}
        showRange={false}
      />

      <div className="no-print">
        <PageHeader
          title="Quarterly income comparison"
          description="The income statement read across the year, one quarter beside another."
          action={
            <div className="flex gap-2 flex-wrap">
              <Link
                href="/accounting/reports"
                className="btn btn-secondary btn-sm"
              >
                Financial statements
              </Link>
              <PrintButton />
            </div>
          }
        />

        <div className="mb-5">
          <Card>
            <form method="get" className="grid gap-3 sm:grid-cols-4 items-end">
              <div>
                <label className="label" htmlFor="year">
                  Year
                </label>
                <select id="year" name="year" className="select" defaultValue={year}>
                  {years.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="location">
                  Property
                </label>
                <select
                  id="location"
                  name="location"
                  className="select"
                  defaultValue={location ?? "all"}
                >
                  <option value="all">All properties</option>
                  {(locations ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.code} — {row.name}
                    </option>
                  ))}
                  <option value="unallocated">Unallocated</option>
                </select>
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
            Nothing was posted to the ledger in {year}
            {locationLabel ? ` for ${locationLabel}` : ""}.
          </EmptyState>
        </Card>
      ) : (
        <Card
          title={`Income statement — ${year}${locationLabel ? ` — ${locationLabel}` : ""}`}
          description="Each quarter as posted, and the year to date."
          bodyClassName=""
        >
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  {QUARTERS.map((quarter) => (
                    <th key={quarter} className="text-right">
                      Q{quarter}
                    </th>
                  ))}
                  <th className="text-right">Year</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={6} className="font-bold" style={{ paddingTop: "0.9rem" }}>
                    Income
                  </td>
                </tr>
                {income.lines.map((line) => (
                  <tr key={line.accountId}>
                    <td className="text-sm" style={{ paddingLeft: "1.5rem" }}>
                      <span className="muted mr-2">{line.code}</span>
                      {line.name}
                    </td>
                    <Figures values={line.byQuarter} total={line.total} />
                  </tr>
                ))}
                <tr>
                  <td className="font-semibold" style={{ paddingLeft: "0.75rem" }}>
                    Total income
                  </td>
                  <Figures values={income.totals} total={income.grand} bold />
                </tr>

                <tr>
                  <td colSpan={6} className="font-bold" style={{ paddingTop: "0.9rem" }}>
                    Expenses
                  </td>
                </tr>
                {expense.lines.map((line) => (
                  <tr key={line.accountId}>
                    <td className="text-sm" style={{ paddingLeft: "1.5rem" }}>
                      <span className="muted mr-2">{line.code}</span>
                      {line.name}
                    </td>
                    <Figures values={line.byQuarter} total={line.total} />
                  </tr>
                ))}
                <tr>
                  <td className="font-semibold" style={{ paddingLeft: "0.75rem" }}>
                    Total expenses
                  </td>
                  <Figures values={expense.totals} total={expense.grand} bold />
                </tr>

                <tr>
                  <td className="font-bold" style={{ paddingTop: "0.9rem" }}>
                    Net income
                  </td>
                  <Figures
                    values={net}
                    total={netGrand}
                    bold
                    tone={netGrand >= 0 ? "var(--success)" : "var(--danger)"}
                  />
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
