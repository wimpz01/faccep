/**
 * Expanded withholding tax on income payments to suppliers (BIR).
 *
 * Kept beside the withholding_rate() function in the database; if a rate ever
 * changes both have to move together.
 */
export const WITHHOLDING_KINDS = [
  { value: "none", label: "Not withheld", rate: 0 },
  { value: "goods", label: "Goods — 1%", rate: 1 },
  { value: "services", label: "Services — 2%", rate: 2 },
] as const;

export type WithholdingKind = (typeof WITHHOLDING_KINDS)[number]["value"];

export function withholdingRate(kind: string) {
  return WITHHOLDING_KINDS.find((entry) => entry.value === kind)?.rate ?? 0;
}

export function withholdingLabel(kind: string) {
  return (
    WITHHOLDING_KINDS.find((entry) => entry.value === kind)?.label ??
    "Not withheld"
  );
}
