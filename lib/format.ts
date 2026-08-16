const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
});

const pesoCompact = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

export function money(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  return peso.format(Number(value));
}

export function moneyCompact(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  return pesoCompact.format(Number(value));
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  // Date columns arrive as YYYY-MM-DD; parse as local to avoid a day slipping
  // backwards in UTC+8.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A time column, read back as people write it: "2:30 PM" rather than 14:30:00.
 *
 * Postgres hands back `HH:MM:SS`, and the seconds are never meaningful on a
 * reminder. Returns null rather than a dash so a caller can leave the time out
 * altogether when none was set.
 */
export function formatTime(value: string | null | undefined) {
  if (!value) return null;
  const [hour, minute] = value.slice(0, 5).split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDateLong(value: string | null | undefined) {
  if (!value) return "__________";
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Whole months between two ISO dates, used for contract-expiry alerts. */
export function monthsUntil(value: string | null | undefined) {
  if (!value) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const target = new Date(year, month - 1, day);
  const now = new Date();
  return (
    (target.getFullYear() - now.getFullYear()) * 12 +
    (target.getMonth() - now.getMonth())
  );
}

/**
 * Rent for a given contract year under the tenant's escalation rate.
 * Spec 4.1: the rate compounds annually and applies to the deposit too.
 */
export function escalatedAmount(
  base: number,
  ratePercent: number,
  yearIndex: number,
) {
  return base * Math.pow(1 + ratePercent / 100, yearIndex);
}

export function addYears(isoDate: string, years: number) {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  const result = new Date(year + years, month - 1, day);
  return result.toISOString().slice(0, 10);
}

/** Contract end date is the day before the anniversary of the start. */
export function defaultEndDate(startIso: string, termYears: number) {
  const [year, month, day] = startIso.slice(0, 10).split("-").map(Number);
  const end = new Date(year + termYears, month - 1, day);
  end.setDate(end.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
}
