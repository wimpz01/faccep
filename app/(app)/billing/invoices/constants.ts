/**
 * What the location box submits when the whole portfolio is being billed.
 *
 * A sentinel rather than an empty value, so "bill everywhere" and "nothing was
 * chosen" stay two different requests: the second is still refused. Shared
 * with the server action so both sides agree on the spelling.
 */
export const ALL_LOCATIONS = "all";

export const STATUS_BADGE: Record<string, string> = {
  draft: "badge",
  released: "badge badge-brand",
  partially_paid: "badge badge-brand",
  paid: "badge",
  cancelled: "badge",
};

export const LINE_KIND_LABELS: Record<string, string> = {
  rent: "Rent",
  parking: "Parking",
  security_guard: "Security guard",
  water: "Water",
  electricity: "Electricity",
  genset: "Generator",
  water_expense: "Water expense",
  penalty: "Penalty",
  other: "Other",
};
