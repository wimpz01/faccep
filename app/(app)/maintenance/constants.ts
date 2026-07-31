/** Kept out of actions.ts: a "use server" file may only export async functions. */

/** Spec 8.2: Reported → Approved → Assigned → In progress → Completed → Inspected → Closed. */
export const JOB_FLOW = [
  "reported",
  "approved",
  "assigned",
  "in_progress",
  "completed",
  "inspected",
  "closed",
] as const;

export type JobStatus = (typeof JOB_FLOW)[number];
