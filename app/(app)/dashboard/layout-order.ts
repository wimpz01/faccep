/**
 * The dashboard's own order, and how a saved one is laid over it.
 *
 * Kept out of the server action file because a "use server" module may only
 * export async functions, and out of the page so the client component can read
 * the same keys the server writes.
 */

/** Panels, top to bottom, as they arrive out of the box. */
export const PANEL_KEYS = [
  // Your own reminders lead: they are the one panel every user has, and the
  // only one nobody else can act on for you.
  "my-calendar",
  "occupancy",
  "notifications",
  "occupancy-by-location",
  "postdated-cheques",
  "utility-usage",
  // Last, and only an administrator sees it: it is about how the work is
  // going rather than about the work itself.
  "billing-turnaround",
] as const;

/** The figures along the top, left to right. */
export const TILE_KEYS = [
  "collected",
  "receivables",
  "attention",
  "overdue",
  "approvals",
] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];
export type TileKey = (typeof TILE_KEYS)[number];

/**
 * A saved order laid over the built-in one.
 *
 * Anything saved that the app no longer has is dropped, and anything the app
 * has that was never saved falls in at the end in its built-in order. That way
 * a panel added after somebody saved a layout still reaches them, rather than
 * being hidden for ever behind a list written before it existed.
 */
export function applyOrder<T extends string>(
  defaults: readonly T[],
  saved: string[] | null | undefined,
): T[] {
  const known = new Set<string>(defaults);
  const chosen = (saved ?? []).filter(
    (key, index, all) => known.has(key) && all.indexOf(key) === index,
  ) as T[];
  const rest = defaults.filter((key) => !chosen.includes(key));
  return [...chosen, ...rest];
}
