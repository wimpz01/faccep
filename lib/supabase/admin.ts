import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses row level security entirely, so it is only
 * used where the operation genuinely cannot run as the signed-in user --
 * creating and disabling auth.users accounts from the Users module.
 *
 * Every caller must gate itself with requirePermission() first.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "User administration needs the service role key.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
