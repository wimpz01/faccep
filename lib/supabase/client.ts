import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client. Used only where the work genuinely has to happen client-side
 * -- file uploads to Storage, which would otherwise round-trip the whole
 * binary through a server action.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
