/**
 * Closes the migration ledger to the outside world.
 *
 * public._migrations is created by scripts/db-push.mjs rather than by a
 * migration, so it never got the row-level security every other table has.
 * PostgREST publishes everything in the public schema, and Supabase grants
 * anon and authenticated full access to new tables there by default, so the
 * ledger was readable and WRITABLE by anyone holding the anon key -- which
 * ships inside the browser bundle and is public by design.
 *
 * Reading it only leaks migration filenames. Writing to it is the real
 * problem: a row claiming a migration was already applied makes db-push skip
 * it, which is a quiet way to stop a security migration from ever installing.
 *
 * Signed-in users keep the read, because lib/backup.ts stamps each archive
 * with the newest migration name and the manual backup runs as the user
 * rather than as the service role. postgres owns this table and holds
 * bypassrls, so db-push is unaffected; service_role bypasses too, so the
 * nightly cron backup is unaffected.
 *
 * db-push.mjs now applies the same lock when it creates the table, so a fresh
 * environment is protected from its very first run. This migration is for
 * environments that already exist.
 */

alter table public._migrations enable row level security;

revoke all on public._migrations from anon, authenticated;
grant select on public._migrations to authenticated;

drop policy if exists migrations_read on public._migrations;
create policy migrations_read on public._migrations
  for select to authenticated using (true);
