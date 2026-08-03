/**
 * Applies supabase/migrations/*.sql in filename order.
 *
 *   node scripts/db-push.mjs            apply pending migrations
 *   node scripts/db-push.mjs --seed     also run supabase/seed/*.sql
 *   node scripts/db-push.mjs --force    re-run migrations already applied
 *
 * Two transports, picked automatically:
 *
 *   1. Direct Postgres, when SUPABASE_DB_URL is set and reachable.
 *   2. The Supabase Management API, using SUPABASE_ACCESS_TOKEN. Useful when
 *      the database password is not to hand -- the API executes SQL as the
 *      postgres role without it.
 *
 * Applied files are recorded in public._migrations so re-runs are safe, and
 * each file runs inside its own transaction.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openConnection } from "./db-transport.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

function sqlFiles(dir) {
  try {
    return readdirSync(join(root, dir))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, path: join(root, dir, name) }));
  } catch {
    return [];
  }
}

async function run() {
  const db = await openConnection();
  console.log(`Using the ${db.label}.\n`);

  /**
   * The ledger is created here rather than by a migration, so it never passed
   * through the discipline every other table gets. Supabase grants anon and
   * authenticated full access to any new table in the public schema, and
   * PostgREST publishes it -- which left strangers able to write to it, and a
   * poisoned ledger makes db-push skip migrations it thinks are applied.
   * Locking it down here means a fresh environment is safe from the first run,
   * not from whenever 0054 happens to apply. Every statement is idempotent.
   */
  await db.query(`
    create table if not exists public._migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    );

    alter table public._migrations enable row level security;

    revoke all on public._migrations from anon, authenticated;
    grant select on public._migrations to authenticated;

    drop policy if exists migrations_read on public._migrations;
    create policy migrations_read on public._migrations
      for select to authenticated using (true);
  `);

  const applied = await db.query("select name from public._migrations");
  const alreadyApplied = new Set(applied.map((row) => row.name));

  let count = 0;

  for (const file of sqlFiles("supabase/migrations")) {
    if (alreadyApplied.has(file.name) && !args.has("--force")) {
      console.log(`  skip  ${file.name} (already applied)`);
      continue;
    }

    const sql = readFileSync(file.path, "utf8");
    process.stdout.write(`  apply ${file.name} ... `);

    try {
      await db.query(`begin;\n${sql}\ncommit;`);
      await db.query(
        `insert into public._migrations (name) values ('${file.name}')
         on conflict (name) do update set applied_at = now()`,
      );
      console.log("ok");
      count += 1;
    } catch (error) {
      console.log("FAILED");
      console.error(`\n${file.name}: ${error.message}\n`);
      process.exitCode = 1;
      await db.close();
      return;
    }
  }

  if (args.has("--seed")) {
    for (const file of sqlFiles("supabase/seed")) {
      const sql = readFileSync(file.path, "utf8");
      if (sql.includes("CHANGE ME")) {
        console.log(`  skip  seed/${file.name} (set the company name first)`);
        continue;
      }
      process.stdout.write(`  seed  ${file.name} ... `);
      await db.query(sql);
      console.log("ok");
    }
  }

  console.log(
    count === 0 ? "\nNothing to apply." : `\nApplied ${count} migration(s).`,
  );
  await db.close();
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
