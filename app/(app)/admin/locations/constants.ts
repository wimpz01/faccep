/** Kept out of actions.ts: a "use server" file may only export async functions. */
export const PROPERTY_TYPES = [
  { value: "commercial_building", label: "Commercial building" },
  { value: "office", label: "Office" },
  { value: "warehouse", label: "Warehouse" },
  { value: "vacant_lot", label: "Vacant lot" },
  { value: "apartment", label: "Apartment" },
] as const;
