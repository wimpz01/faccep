import Link from "next/link";
import type { ReactNode } from "react";

import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";
import { getSessionContext } from "@/lib/auth";
import { formatDate } from "@/lib/format";

/**
 * Common chrome for every report: heading, an optional date-range filter, and
 * the print control. The filter posts back with GET so the range lives in the
 * URL and can be bookmarked or shared.
 *
 * On paper the screen chrome is dropped and replaced by a masthead, because a
 * printed report that names neither the company, the report nor the date it
 * was taken is not evidence of anything.
 */
/**
 * The heading a report grows when it reaches paper.
 *
 * A printout that names neither the company, the report, nor the date it was
 * taken is not evidence of anything -- it is a page of numbers. Kept separate
 * from ReportShell so a report that builds its own chrome can still print a
 * proper head.
 */
export function ReportMasthead({
  companyName,
  title,
  scopeNote,
  from,
  to,
  showRange = true,
}: {
  companyName?: string;
  title: string;
  scopeNote?: string;
  from?: string;
  to?: string;
  showRange?: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="print-only" style={{ marginBottom: "1rem" }}>
      {companyName ? (
        <p style={{ fontWeight: 700, marginBottom: "0.15rem" }}>{companyName}</p>
      ) : null}
      <h1
        style={{
          fontSize: "1.15rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {title}
      </h1>
      {scopeNote ? (
        <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>{scopeNote}</p>
      ) : null}
      <p style={{ fontSize: "0.8rem" }}>
        {showRange && from && to
          ? `For ${formatDate(from)} to ${formatDate(to)}`
          : `As at ${formatDate(today)}`}
        {` · printed ${formatDate(today)}`}
      </p>
    </div>
  );
}

export async function ReportShell({
  title,
  description,
  from,
  to,
  showRange = true,
  extraFilters,
  filterNote,
  scopeNote,
  children,
}: {
  title: string;
  description?: string;
  from?: string;
  to?: string;
  showRange?: boolean;
  extraFilters?: ReactNode;
  /**
   * A word about the filters, shown under the whole row rather than beneath
   * one field. Kept out of the grid so every control sits on the same line:
   * a hint inside one cell makes that cell taller and drops its input below
   * its neighbours'.
   */
  filterNote?: ReactNode;
  /** What the report was narrowed to, named on the printed copy. */
  scopeNote?: string;
  children: ReactNode;
}) {
  const context = await getSessionContext();
  const companyName = context?.activeCompany?.companyName ?? "";

  return (
    <>
      <ReportMasthead
        companyName={companyName}
        title={title}
        scopeNote={scopeNote}
        from={from}
        to={to}
        showRange={showRange}
      />

      <div className="no-print">
        <PageHeader
          title={title}
          description={description}
          action={
            <div className="flex gap-2 flex-wrap">
              <Link href="/reports" className="btn btn-secondary btn-sm">
                All reports
              </Link>
              <PrintButton />
            </div>
          }
        />

        {showRange || extraFilters ? (
          <div className="card mb-5">
            <div className="card-body">
              <form method="get" className="grid gap-3 sm:grid-cols-5 items-end">
                {showRange ? (
                  <>
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
                      <input
                        id="to"
                        name="to"
                        type="date"
                        className="input"
                        defaultValue={to}
                      />
                    </div>
                  </>
                ) : null}
                {extraFilters}
                <div>
                  <button type="submit" className="btn btn-primary">
                    Apply
                  </button>
                </div>
              </form>
              {filterNote ? (
                <p className="text-xs muted mt-2">{filterNote}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {children}
    </>
  );
}

/** Default range: start of the current year to the end of the current month. */
export function defaultRange() {
  const now = new Date();
  return {
    from: `${now.getFullYear()}-01-01`,
    to: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10),
  };
}

/** Aging bucket for a due date, relative to today. */
export function agingBucket(dueDate: string) {
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00`);
  const days = Math.floor((Date.now() - due.getTime()) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  if (days <= 120) return "91-120";
  return "120+";
}

export const AGING_BUCKETS = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "91-120",
  "120+",
] as const;
