/**
 * Where an account with no email of its own is parked.
 *
 * Supabase Auth insists on an address, but plenty of staff have no work email
 * and sign in with their user code anyway. The code is unique, so it makes a
 * unique address; .invalid is reserved by RFC 2606 precisely so it can never
 * be a real one, and nothing is ever delivered to it.
 *
 * Kept out of actions.ts because a "use server" file may only export async
 * functions.
 */
const NO_EMAIL_DOMAIN = "no-email.faccep.invalid";

export function placeholderEmailFor(userCode: string) {
  return `${userCode.trim().toLowerCase()}@${NO_EMAIL_DOMAIN}`;
}

/** Whether an address is one of ours rather than the person's own. */
export function isPlaceholderEmail(email: string | null | undefined) {
  return Boolean(email?.endsWith(`@${NO_EMAIL_DOMAIN}`));
}
