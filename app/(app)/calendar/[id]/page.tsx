import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { formatDate, formatDateLong, formatTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import {
  deleteCalendarEvent,
  toggleCalendarEvent,
  updateCalendarEvent,
} from "../../crm/actions";
import { CalendarEventEditForm } from "../../crm/crm-forms";

export const metadata: Metadata = { title: "Reminder" };

type EventDetail = {
  id: string;
  user_id: string;
  title: string;
  details: string | null;
  event_date: string;
  event_time: string | null;
  remind_days_before: number;
  is_done: boolean;
  created_at: string;
};

/** The day the reminder is meant to surface, counting back from the date. */
function remindOn(eventDate: string, daysBefore: number) {
  const [year, month, day] = eventDate.slice(0, 10).split("-").map(Number);
  const date = new Date(year, month - 1, day - daysBefore);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * One reminder, in full.
 *
 * The calendar can only show a line per entry, which is enough to spot it and
 * not enough to act on it: the details, the time of day and the notice you
 * asked for all get cut. They live here, where they can also be changed --
 * a reminder whose date has moved is worth editing rather than re-typing.
 */
export default async function CalendarEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requireSession();
  const supabase = await createClient();

  const { data: event } = await supabase
    .from("calendar_events")
    .select(
      "id, user_id, title, details, event_date, event_time, remind_days_before, is_done, created_at",
    )
    .eq("id", id)
    .maybeSingle<EventDetail>();

  // The policy already hides other people's entries; this keeps a stray id
  // from reading as an empty page rather than a missing one.
  if (!event || event.user_id !== context.userId) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const time = formatTime(event.event_time);
  const overdue = !event.is_done && event.event_date < today;
  const noticeDate = remindOn(event.event_date, event.remind_days_before);

  return (
    <>
      <PageHeader
        title={event.title}
        description={`Your own reminder · added ${formatDate(event.created_at)}`}
        action={
          <div className="flex gap-2">
            <Link href="/calendar" className="btn btn-secondary btn-sm">
              Back to calendar
            </Link>
            <form action={toggleCalendarEvent}>
              <input type="hidden" name="id" value={event.id} />
              <input
                type="hidden"
                name="is_done"
                value={String(!event.is_done)}
              />
              <button type="submit" className="btn btn-secondary btn-sm">
                {event.is_done ? "Reopen" : "Mark done"}
              </button>
            </form>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              When
            </p>
            <p className="text-lg font-bold mt-1">
              {formatDateLong(event.event_date)}
            </p>
            <p className="text-xs muted">
              {time ? `at ${time}` : "No time set — any time that day"}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Notice
            </p>
            <p className="text-lg font-bold mt-1">
              {event.remind_days_before > 0
                ? `${event.remind_days_before} day${event.remind_days_before === 1 ? "" : "s"} before`
                : "On the day"}
            </p>
            <p className="text-xs muted">
              {event.remind_days_before > 0
                ? `From ${formatDate(noticeDate)}`
                : "No advance notice"}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span
                className="badge"
                style={
                  overdue
                    ? { background: "var(--danger)", color: "#fff" }
                    : undefined
                }
              >
                {event.is_done ? "done" : overdue ? "overdue" : "upcoming"}
              </span>
            </p>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Card title="Details">
          {event.details ? (
            <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>
              {event.details}
            </p>
          ) : (
            <p className="text-sm muted">
              No details were written for this reminder.
            </p>
          )}
        </Card>
      </div>

      <div className="mb-6">
        <Card title="Edit" description="Personal to you — nobody else sees it.">
          <CalendarEventEditForm action={updateCalendarEvent} event={event} />
        </Card>
      </div>

      <Card
        title="Remove"
        description="Deleting a reminder cannot be undone. Marking it done keeps it on the record."
      >
        <form action={deleteCalendarEvent}>
          <input type="hidden" name="id" value={event.id} />
          <button type="submit" className="btn btn-secondary btn-sm">
            Delete this reminder
          </button>
        </form>
      </Card>
    </>
  );
}
