/**
 * Shared database transport for the maintenance scripts.
 *
 * Prefers a direct Postgres connection when SUPABASE_DB_URL is set, and falls
 * back to the Supabase Management API using SUPABASE_ACCESS_TOKEN -- which
 * executes SQL as the postgres role without needing the database password.
 *
 * Both transports return the rows of the LAST statement in the string, so a
 * multi-statement block ending in a SELECT behaves the same either way.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: join(root, ".env.local"), quiet: true });
dotenv.config({ path: join(root, ".env"), quiet: true });

/** Escapes a JS value into a SQL literal. The API transport has no bind params. */
export function lit(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function projectRef() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;
}

async function connectDirect(connectionString) {
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();

  return {
    label: "direct Postgres connection",
    async query(sql) {
      const result = await client.query(sql);
      // Multi-statement strings come back as an array of results.
      const last = Array.isArray(result) ? result[result.length - 1] : result;
      return last?.rows ?? [];
    },
    async close() {
      await client.end();
    },
  };
}

function connectApi(token, ref) {
  return {
    label: `Management API (project ${ref})`,
    async query(sql) {
      const response = await fetch(
        `https://api.supabase.com/v1/projects/${ref}/database/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: sql }),
        },
      );
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try {
          message = JSON.parse(text).message ?? text;
        } catch {
          /* keep the raw body */
        }
        throw new Error(message);
      }
      return text ? JSON.parse(text) : [];
    },
    async close() {},
  };
}

export async function openConnection() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (connectionString) {
    try {
      return await connectDirect(connectionString);
    } catch (error) {
      console.log(`  direct connection failed (${error.message})`);
      console.log("  falling back to the Management API");
    }
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = projectRef();
  if (token && ref) return connectApi(token, ref);

  throw new Error(
    "No usable connection. Set SUPABASE_DB_URL, or SUPABASE_ACCESS_TOKEN plus " +
      "NEXT_PUBLIC_SUPABASE_URL, in .env.local.",
  );
}
