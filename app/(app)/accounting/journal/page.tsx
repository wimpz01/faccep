import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createJournalEntry } from "../actions";
import { JournalEntryForm } from "../accounting-forms";
import { JOURNAL_STATUS_BADGE as STATUS_BADGE } from "../constants";

export const metadata: Metadata = { title: "Journal" };

type EntryRow = {
  id: string;
  entry_no: string;
  entry_date: string;
  memo: string | null;
  status: string;
  source_table: string | null;
  journal_lines: { debit: string; credit: string }[];
};

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const context = await requirePermission(MODULE.accountingJournal, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.accountingJournal, "edit");

  const supabase = await createClient();
  const [{ data: entries }, { data: accounts }] = await Promise.all([
    supabase
      .from("journal_entries")
      .select(
        "id, entry_no, entry_date, memo, status, source_table, journal_lines(debit, credit)",
      )
      .eq("company_id", companyId)
      .order("entry_date", { ascending: false })
      .order("entry_no", { ascending: false })
      .limit(150)
      .returns<EntryRow[]>(),
    supabase
      .from("chart_of_accounts")
      .select("id, code, name, account_type")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
  ]);

  const rows = entries ?? [];
  const drafts = rows.filter((row) => row.status === "draft");
  const posted = rows.filter((row) => row.status === "posted");

  // Clicking a figure narrows the list below it to exactly what it counted.
  const shown =
    view === "drafts" ? drafts : view === "posted" ? posted : rows;
  const filterLabel =
    view === "drafts"
      ? "entries not yet in the ledger"
      : view === "posted"
        ? "entries posted to the ledger"
        : null;

  return (
    <>
      <PageHeader
        title="Journal"
        description="Posted entries are immutable. Corrections are made by reversal, which writes a new balancing entry."
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/accounting/accounts" className="btn btn-secondary btn-sm">
              Chart of accounts
            </Link>
            <Link href="/accounting/periods" className="btn btn-secondary btn-sm">
              Periods
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile
          label="Drafts"
          value={drafts.length}
          hint="Not yet in the ledger"
          href="/accounting/journal?view=drafts"
        />
        <StatTile
          label="Posted"
          value={posted.length}
          hint="In the ledger"
          href="/accounting/journal?view=posted"
        />
        <StatTile
          label="Posted value"
          value={money(
            posted.reduce(
              (sum, row) =>
                sum +
                (row.journal_lines ?? []).reduce(
                  (lineSum, line) => lineSum + Number(line.debit),
                  0,
                ),
              0,
            ),
          )}
          hint="Total debits"
          tone="money"
        />
      </div>

      {canEdit && (accounts ?? []).length > 0 ? (
        <div className="mb-6">
          <Card
            title="New journal entry"
            description="Must balance before it can be saved, and again before it can be posted."
          >
            <JournalEntryForm action={createJournalEntry} accounts={accounts ?? []} />
          </Card>
        </div>
      ) : null}

      {(accounts ?? []).length === 0 ? (
        <div className="mb-6">
          <Card>
            <p className="text-sm">
              Set up the{" "}
              <Link
                href="/accounting/accounts"
                style={{ color: "var(--color-brand-600)" }}
              >
                chart of accounts
              </Link>{" "}
              before raising entries.
            </p>
          </Card>
        </div>
      ) : null}

      {filterLabel ? (
        <FilterNote
          label={filterLabel}
          count={shown.length}
          clearHref="/accounting/journal"
        />
      ) : null}

      <Card title="Entries" bodyClassName="">
        {shown.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Date</th>
                  <th>Memo</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((entry) => {
                  const amount = (entry.journal_lines ?? []).reduce(
                    (sum, line) => sum + Number(line.debit),
                    0,
                  );
                  return (
                    <tr key={entry.id}>
                      <td>
                        <Link
                          href={`/accounting/journal/${entry.id}`}
                          className="font-semibold"
                          style={{ color: "var(--color-brand-600)" }}
                        >
                          {entry.entry_no}
                        </Link>
                        {entry.source_table ? (
                          <p className="text-xs muted">from {entry.source_table}</p>
                        ) : null}
                      </td>
                      <td className="text-xs">{formatDate(entry.entry_date)}</td>
                      <td className="text-sm">{entry.memo ?? "—"}</td>
                      <td className="text-right tabular-nums">{money(amount)}</td>
                      <td>
                        <span className={STATUS_BADGE[entry.status] ?? "badge"}>
                          {entry.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No journal entries yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
