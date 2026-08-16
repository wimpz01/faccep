import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { formatDate, formatTime, monthsUntil } from "@/lib/format";
import { nextScheduledDate } from "@/lib/maintenance";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createCalendarEvent, toggleCalendarEvent } from "../crm/actions";
import { CalendarEventForm } from "../crm/crm-forms";

export const metadata: Metadata = { title: "Calendar" };

type Entry = {
  key: string;
  date: string;
  /** Only personal reminders carry one; the rest are all-day. */
  time?: string | null;
  title: string;
  detail: string;
  href?: string;
  kind: string;
  eventId?: string;
  done?: boolean;
};

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const context = await requireSession();
  const companyId = context.activeCompany!.companyId;
  const permissions = context.permissions;
  const supabase = await createClient();

  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);

  const [{ data: events }, { data: schedules }, { data: contracts }, { data: cheques }, { data: docs }] =
    await Promise.all([
      supabase
        .from("calendar_events")
        .select("id, title, details, event_date, event_time, is_done")
        .eq("user_id", context.userId)
        .order("event_date")
        .returns<
          {
            id: string;
            title: string;
            details: string | null;
            event_date: string;
            event_time: string | null;
            is_done: boolean;
          }[]
        >(),
      can(permissions, MODULE.maintenanceScheduled, "view")
        ? supabase
            .from("maintenance_schedules")
            .select("id, title, month_of_year, day_of_month, locations(code)")
            .eq("company_id", companyId)
            .eq("is_active", true)
            .returns<
              {
                id: string;
                title: string;
                month_of_year: number | null;
                day_of_month: number | null;
                locations: { code: string } | null;
              }[]
            >()
        : Promise.resolve({ data: null }),
      can(permissions, MODULE.contracts, "view")
        ? supabase
            .from("contracts")
            .select("id, contract_no, end_date, tenants(company_name)")
            .eq("company_id", companyId)
            .eq("status", "active")
            .lte("end_date", horizon)
            .returns<
              {
                id: string;
                contract_no: string;
                end_date: string;
                tenants: { company_name: string } | null;
              }[]
            >()
        : Promise.resolve({ data: null }),
      can(permissions, MODULE.paymentsPdc, "view")
        ? supabase
            .from("postdated_checks")
            .select("id, check_no, bank, maturity_date, tenants(company_name)")
            .eq("company_id", companyId)
            .in("status", ["pending", "matured"])
            .lte("maturity_date", horizon)
            .returns<
              {
                id: string;
                check_no: string;
                bank: string;
                maturity_date: string;
                tenants: { company_name: string } | null;
              }[]
            >()
        : Promise.resolve({ data: null }),
      can(permissions, MODULE.documents, "view")
        ? supabase
            .from("documents")
            .select("id, title, expires_on")
            .eq("company_id", companyId)
            .not("expires_on", "is", null)
            .lte("expires_on", horizon)
            .returns<{ id: string; title: string; expires_on: string }[]>()
        : Promise.resolve({ data: null }),
    ]);

  const entries: Entry[] = [];

  for (const event of events ?? []) {
    entries.push({
      key: `event-${event.id}`,
      date: event.event_date,
      time: event.event_time,
      title: event.title,
      detail: event.details ?? "",
      href: `/calendar/${event.id}`,
      kind: "personal",
      eventId: event.id,
      done: event.is_done,
    });
  }

  for (const contract of contracts ?? []) {
    const months = monthsUntil(contract.end_date);
    entries.push({
      key: `contract-${contract.id}`,
      date: contract.end_date,
      title: `Contract ${contract.contract_no} ends`,
      detail: `${contract.tenants?.company_name ?? ""}${months !== null ? ` · ${months <= 0 ? "now" : `${months} month(s)`}` : ""}`,
      href: `/contracts/${contract.id}`,
      kind: "renewal",
    });
  }

  for (const cheque of cheques ?? []) {
    entries.push({
      key: `pdc-${cheque.id}`,
      date: cheque.maturity_date,
      title: `Cheque ${cheque.check_no} matures`,
      detail: `${cheque.bank} · ${cheque.tenants?.company_name ?? ""}`,
      href: "/payments/pdc",
      kind: "cheque",
    });
  }

  for (const doc of docs ?? []) {
    entries.push({
      key: `doc-${doc.id}`,
      date: doc.expires_on,
      title: `${doc.title} expires`,
      detail: "Renew before it lapses",
      href: "/documents",
      kind: "document",
    });
  }

  // A schedule recurs on a month and day rather than a date, so it is rolled
  // forward to the next time it comes round.
  for (const schedule of schedules ?? []) {
    const date = nextScheduledDate(schedule, today);
    if (!date) continue;
    entries.push({
      key: `sched-${schedule.id}`,
      date,
      title: schedule.title,
      detail: `Scheduled maintenance${schedule.locations?.code ? ` · ${schedule.locations.code}` : ""}`,
      href: "/maintenance/schedules",
      kind: "maintenance",
    });
  }

  const upcoming = entries
    .filter((entry) => !entry.done)
    // Within a day, a timed reminder falls in its place; an all-day entry has
    // no hour to sort on, so it leads.
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.time ?? "").localeCompare(b.time ?? ""),
    );
  const overdue = upcoming.filter((entry) => entry.date < today);
  const done = entries.filter((entry) => entry.done);

  // The tiles are the filter. Clicking the one already applied clears it, so
  // there is never a filtered list with no obvious way back.
  const showing =
    view === "overdue" || view === "mine" ? view : ("all" as const);
  const listed =
    showing === "overdue"
      ? overdue
      : showing === "mine"
        ? upcoming.filter((entry) => entry.kind === "personal")
        : upcoming;
  const listTitle =
    showing === "overdue"
      ? "Overdue"
      : showing === "mine"
        ? "Your reminders"
        : "Upcoming";
  const tileHref = (target: "overdue" | "mine") =>
    showing === target ? "/calendar" : `/calendar?view=${target}`;

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Your own reminders, plus renewals, cheque maturities, permit expiries and scheduled maintenance."
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile
          label="Upcoming"
          value={upcoming.length}
          hint="Next six months"
          href={showing === "all" ? undefined : "/calendar"}
        />
        <StatTile
          label="Overdue"
          value={overdue.length}
          hint="Past their date"
          href={tileHref("overdue")}
        />
        <StatTile
          label="Your reminders"
          value={(events ?? []).filter((event) => !event.is_done).length}
          hint="Personal entries"
          href={tileHref("mine")}
        />
      </div>

      <div className="mb-6">
        <Card
          title="Add a reminder"
          description="Personal to you — nobody else sees it."
        >
          <CalendarEventForm action={createCalendarEvent} />
        </Card>
      </div>

      <div className="mb-6">
        <Card
          title={listTitle}
          description={
            showing === "all"
              ? undefined
              : `Filtered — ${listed.length} of ${upcoming.length}. Click the tile again to show everything.`
          }
          bodyClassName=""
        >
          {listed.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>Date</th>
                    <th>What</th>
                    <th>Type</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map((entry) => (
                    <tr key={entry.key}>
                      <td className="text-xs">
                        {formatDate(entry.date)}
                        {formatTime(entry.time) ? (
                          <p className="muted">{formatTime(entry.time)}</p>
                        ) : null}
                        {entry.date < today ? (
                          <p style={{ color: "var(--danger)" }}>overdue</p>
                        ) : null}
                      </td>
                      <td>
                        {entry.href ? (
                          <Link
                            href={entry.href}
                            className="text-sm"
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {entry.title}
                          </Link>
                        ) : (
                          <span className="text-sm">{entry.title}</span>
                        )}
                        {entry.detail ? (
                          <p className="text-xs muted">{entry.detail}</p>
                        ) : null}
                      </td>
                      <td>
                        <span className="badge">{entry.kind}</span>
                      </td>
                      <td className="text-right">
                        {entry.eventId ? (
                          <form action={toggleCalendarEvent}>
                            <input type="hidden" name="id" value={entry.eventId} />
                            <input type="hidden" name="is_done" value="true" />
                            <button type="submit" className="btn btn-secondary btn-sm">
                              Done
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              {showing === "overdue"
                ? "Nothing is overdue."
                : showing === "mine"
                  ? "You have no reminders of your own."
                  : "Nothing coming up."}
            </EmptyState>
          )}
        </Card>
      </div>

      {done.length > 0 ? (
        <Card title="Completed reminders" bodyClassName="">
          <div className="table-scroll">
            <table className="table">
              <tbody>
                {done.map((entry) => (
                  <tr key={entry.key}>
                    <td className="text-xs muted" style={{ width: "9rem" }}>
                      {formatDate(entry.date)}
                      {formatTime(entry.time) ? (
                        <p>{formatTime(entry.time)}</p>
                      ) : null}
                    </td>
                    <td className="text-sm">
                      {entry.href ? (
                        <Link
                          href={entry.href}
                          className="muted"
                          style={{ textDecoration: "underline" }}
                        >
                          {entry.title}
                        </Link>
                      ) : (
                        <span className="muted">{entry.title}</span>
                      )}
                    </td>
                    <td className="text-right">
                      <form action={toggleCalendarEvent}>
                        <input type="hidden" name="id" value={entry.eventId} />
                        <input type="hidden" name="is_done" value="false" />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          Reopen
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
