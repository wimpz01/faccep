/**
 * Creates (or promotes) the install-level super admin.
 *
 *   node scripts/bootstrap-admin.mjs you@example.com [password]
 *
 * A super admin bypasses every permission check and is the only role that can
 * create the first company -- there is no membership row to authorise against
 * before a company exists.
 *
 * If the account already exists it is promoted in place and the password is
 * left alone.
 */

import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { lit, openConnection } from "./db-transport.mjs";

const [email, providedPassword] = process.argv.slice(2);

if (!email) {
  console.error("Usage: node scripts/bootstrap-admin.mjs <email> [password]");
  process.exit(1);
}

for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name} in .env.local.`);
    process.exit(1);
  }
}

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const password =
  providedPassword ??
  Array.from(randomBytes(20))
    .map((byte) => alphabet[byte % alphabet.length])
    .join("");

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const db = await openConnection();

const existing = await db.query(
  `select id from public.profiles where lower(email) = lower(${lit(email)});`,
);

let created = false;

if (existing.length === 0) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: email.split("@")[0] },
  });
  if (error) {
    console.error(`Could not create the account: ${error.message}`);
    process.exit(1);
  }
  created = true;
  console.log(`Created account for ${email} (${data.user.id}).`);
} else {
  console.log(`Account for ${email} already exists; promoting it in place.`);
}

await db.query(`
  update public.profiles
     set is_super_admin = true, is_active = true
   where lower(email) = lower(${lit(email)});
`);

const check = await db.query(`
  select email, is_super_admin, is_active
    from public.profiles
   where lower(email) = lower(${lit(email)});
`);

console.log("\nProfile:", check[0]);

if (created) {
  console.log(`\nInitial password: ${password}`);
  console.log("Change it after your first sign-in.");
} else {
  console.log("\nPassword unchanged.");
}

await db.close();
