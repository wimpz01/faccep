import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader, formatDateTime } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  cancelDraftEntry,
  postJournalEntry,
  reverseJournalEntry,
} from "../../actions";
import {
  CancelDraftEntryForm,
  PostForm,
  ReverseForm,
} from "../../accounting-forms";
import { JOURNAL_STATUS_BADGE } from "../../constants";

export const metadata: Metadata = { title: "Journal entry" };

type EntryDetail = {
  id: string;
  company_id: string;
  entry_no: string;
  entry_date: string;
  memo: string | null;
  status: string;
  source_table: string | null;
  reverses_id: string | null;
  posted_at: string | null;
  journal_lines: {
    id: string;
    description: string | null;
    debit: string;
    credit: string;
    sort_order: number;
    chart_of_accounts: { code: string; name: string } | null;
  }[];
};

export default async function JournalEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.accountingJournal, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.accountingJournal, "edit");
  const canPost = can(context.permissions, MODULE.accountingJournal, "approve");
  const canReverse = can(context.permissions, MODULE.accountingJournal, "void");

  const supabase = await createClient();
  const { data: entry } = await supabase
    .from("journal_entries")
    .select(
      "*, journal_lines(id, description, debit, credit, sort_order, chart_of_accounts(code, name))",
    )
    .eq("id", id)
    .maybeSingle<EntryDetail>();

  if (!entry || entry.company_id !== companyId) notFound();

  const lines = [...(entry.journal_lines ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  );
  const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
  const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit), 0);

  return (
    <>
      <PageHeader
        title={entry.entry_no}
        description={`${formatDate(entry.entry_date)}${entry.memo ? ` · ${entry.memo}` : ""}`}
        action={
          <Link href="/accounting/journal" className="btn btn-secondary btn-sm">
            Back
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span className={JOURNAL_STATUS_BADGE[entry.status] ?? "badge"}>
                {entry.status}
              </span>
            </p>
            {entry.posted_at ? (
              <p className="text-xs muted mt-1">
                posted {formatDateTime(entry.posted_at)}
              </p>
            ) : null}
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Amount
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(totalDebit)}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Source
            </p>
            <p className="text-sm font-medium mt-1">
              {entry.source_table ?? "Manual entry"}
            </p>
            {entry.reverses_id ? (
              <Link
                href={`/accounting/journal/${entry.reverses_id}`}
                className="text-xs"
                style={{ color: "var(--color-brand-600)" }}
              >
                Reverses an earlier entry
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Card title="Lines" bodyClassName="">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Description</th>
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td className="text-sm">
                      <span className="tabular-nums">
                        {line.chart_of_accounts?.code}
                      </span>{" "}
                      {line.chart_of_accounts?.name}
                    </td>
                    <td className="text-xs">{line.description ?? "—"}</td>
                    <td className="text-right tabular-nums">
                      {Number(line.debit) > 0 ? money(line.debit) : ""}
                    </td>
                    <td className="text-right tabular-nums">
                      {Number(line.credit) > 0 ? money(line.credit) : ""}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2} className="text-right font-bold">
                    Totals
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(totalDebit)}
                  </td>
                  <td className="text-right tabular-nums font-bold">
                    {money(totalCredit)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {entry.status === "draft" && canPost ? (
        <div className="mb-6">
          <Card
            title="Post"
            description="The database re-checks that it balances and that the period is open."
          >
            <PostForm action={postJournalEntry} entryId={entry.id} />
          </Card>
        </div>
      ) : null}

      {entry.status === "draft" && canEdit ? (
        <div className="mb-6">
          <Card
            title="Cancel this draft"
            description="For an entry that will not proceed. It is kept with the reason recorded, and no longer blocks a period close."
          >
            <CancelDraftEntryForm action={cancelDraftEntry} entryId={entry.id} />
          </Card>
        </div>
      ) : null}

      {entry.status === "posted" && canReverse ? (
        <Card
          title="Reverse this entry"
          description="Writes a new entry with debits and credits swapped. The original is preserved."
        >
          <ReverseForm action={reverseJournalEntry} entryId={entry.id} />
        </Card>
      ) : null}
    </>
  );
}
