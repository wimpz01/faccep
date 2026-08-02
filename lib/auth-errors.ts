/**
 * Shared by the middleware and the server-side session loader, so it must not
 * import anything: the middleware runs in its own runtime, and pulling
 * next/headers or the Supabase server client in there breaks it.
 */

/**
 * A network failure reaching the auth service, as opposed to a straight answer
 * that there is no session. Supabase names these retryable itself.
 */
export function isAuthUnreachable(
  error: { name?: string; status?: number } | null | undefined,
) {
  if (!error) return false;
  return error.name === "AuthRetryableFetchError" || error.status === 0;
}
