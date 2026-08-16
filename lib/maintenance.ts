/**
 * When a maintenance schedule next falls due.
 *
 * A schedule stores the month and day it recurs on, not a date -- "every
 * April, on the 15th" rather than "2026-04-15". Anchoring that to the current
 * year is what made an annual January job read as overdue every year from
 * February onwards, which is noise rather than news: nothing was late, the
 * year had simply moved past it.
 *
 * So the date is rolled forward instead. The answer is always the next time it
 * comes round, on or after the day asked about.
 *
 * A schedule with no month has no derivable date -- it recurs on an interval
 * from a completion nobody records -- so it returns null and is left out
 * rather than pinned to a month it never named.
 */
export function nextScheduledDate(
  schedule: { month_of_year: number | null; day_of_month?: number | null },
  asOf: string,
): string | null {
  if (!schedule.month_of_year) return null;

  const day = Math.min(Math.max(schedule.day_of_month ?? 1, 1), 28);
  const pad = (value: number) => String(value).padStart(2, "0");
  const month = pad(schedule.month_of_year);
  const today = asOf.slice(0, 10);
  const year = Number(today.slice(0, 4));

  const thisYear = `${year}-${month}-${pad(day)}`;
  return thisYear >= today ? thisYear : `${year + 1}-${month}-${pad(day)}`;
}
