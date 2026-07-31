import Link from "next/link";
import type { ReactNode } from "react";

import { PrintButton } from "@/components/print-button";
import { PageHeader } from "@/components/ui";

/**
 * Common chrome for every report: heading, an optional date-range filter, and
 * the print control. The filter posts back with GET so the range lives in the
 * URL and can be bookmarked or shared.
 */
export function ReportShell({
  title,
  description,
  from,
  to,
  showRange = true,
  extraFilters,
  children,
}: {
  title: string;
  description?: string;
  from?: string;
  to?: string;
  showRange?: boolean;
  extraFilters?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
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

        {showRange ? (
          <div className="card mb-5">
            <div className="card-body">
              <form method="get" className="grid gap-3 sm:grid-cols-5 items-end">
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
                {extraFilters}
                <div>
                  <button type="submit" className="btn btn-primary">
                    Apply
                  </button>
                </div>
              </form>
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
  return "90+";
}

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
