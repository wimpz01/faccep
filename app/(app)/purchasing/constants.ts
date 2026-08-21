/**
 * Expanded withholding tax on income payments to suppliers (BIR).
 *
 * The kinds are fixed -- they mirror the withholding_kind enum -- but the
 * rates are not. Those used to be written here as well as in the database,
 * with nothing keeping the two equal; they now live in the tax_rates table
 * and are edited under Accounting > Tax settings.
 *
 * So nothing in this file states a rate. A label that mentions one is
 * composed from rates read at the call site, which is why withholdingLabel
 * takes them as an argument.
 */

export const WITHHOLDING_KINDS = [
  { value: "none", label: "Not withheld" },
  { value: "goods", label: "Goods" },
  { value: "services", label: "Services" },
] as const;

export type WithholdingKind = (typeof WITHHOLDING_KINDS)[number]["value"];

/** Rates by kind, as read from tax_rates. */
export type WithholdingRates = Partial<Record<string, number>>;

export function withholdingRate(kind: string, rates: WithholdingRates) {
  return rates[kind] ?? 0;
}

/** "Goods — 1%", built from whatever the rate currently is. */
export function withholdingLabel(kind: string, rates: WithholdingRates) {
  const entry = WITHHOLDING_KINDS.find((row) => row.value === kind);
  if (!entry) return "Not withheld";
  if (entry.value === "none") return entry.label;
  const rate = rates[kind];
  return rate === undefined ? entry.label : `${entry.label} — ${rate}%`;
}
