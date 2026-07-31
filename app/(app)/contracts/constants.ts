/** Shared with client components; kept out of the "use server" action file. */

export const BILLING_TYPES = [
  { value: "consumption", label: "Pure consumption" },
  { value: "minimum_overage", label: "Minimum + overage" },
  { value: "fixed", label: "Fixed amount" },
] as const;

export const ESCALATION_RATES = [0, 3, 5] as const;

export const INCLUSIONS = [
  { value: "rent", label: "Monthly rent" },
  { value: "parking", label: "Parking" },
  { value: "security_guard", label: "Security guard" },
  { value: "water", label: "Water" },
  { value: "electricity", label: "Electricity" },
] as const;

export const CONTRACT_STATUS_BADGE: Record<string, string> = {
  active: "badge badge-brand",
  draft: "badge",
  expired: "badge",
  terminated: "badge",
};

export const BILLING_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  BILLING_TYPES.map((type) => [type.value, type.label]),
);
