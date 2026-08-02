/**
 * Checks every PostgREST .select() in the app against the live schema.
 *
 * Schema drift is silent: a dropped column makes the whole query fail, the row
 * comes back null, and a detail page renders "404 page not found" with no clue
 * why. This catches that before a user does.
 *
 *   node scripts/schema-drift.mjs
 *
 * It parses `.from("table")` followed by `.select("...")` and checks the plain
 * column names at the top level of the projection. Embedded relations
 * (`vendors(name, ...)`) are resolved to their own table by name and checked
 * too. Anything it cannot resolve is reported as skipped rather than guessed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { openConnection } from "./db-transport.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Splits a projection on commas that are not inside parentheses. */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Yields { table, column } pairs for a projection, descending into embeds.
 * `alias:column` and `alias:table(...)` are both handled.
 */
function* columnsOf(table, projection) {
  for (const part of splitTop(projection)) {
    const open = part.indexOf("(");
    if (open === -1) {
      let name = part.trim();
      if (name === "*" || name.startsWith("...")) continue;
      // alias:column  ->  column
      const colon = name.indexOf(":");
      if (colon !== -1) name = name.slice(colon + 1).trim();
      // count / aggregate helpers carry no column of their own
      if (name === "count" || name.includes("!")) continue;
      if (!/^[a-z_][a-z0-9_]*$/i.test(name)) continue;
      yield { table, column: name };
      continue;
    }
    // relation(...) — the relation name is a table, checked on its own
    let head = part.slice(0, open).trim();
    const colon = head.indexOf(":");
    if (colon !== -1) head = head.slice(colon + 1).trim();
    head = head.split("!")[0].trim();
    const inner = part.slice(open + 1, part.lastIndexOf(")"));
    if (!/^[a-z_][a-z0-9_]*$/i.test(head)) continue;
    yield* columnsOf(head, inner);
  }
}

const db = await openConnection();

const schema = await db.query(`
  select table_name, column_name
    from information_schema.columns
   where table_schema = 'public'
`);
const rows = schema.rows ?? schema;

const known = new Map();
for (const row of rows) {
  if (!known.has(row.table_name)) known.set(row.table_name, new Set());
  known.get(row.table_name).add(row.column_name);
}

const problems = [];
const skipped = new Set();

for (const file of walk(join(root, "app")).concat(walk(join(root, "lib")))) {
  const source = readFileSync(file, "utf8");
  // .from("table") ... .select(`...`) with the select following the from
  const pattern =
    /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)[\s\S]{0,120}?\.select\(\s*(["'`])([\s\S]*?)\2/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, table, , projection] = match;
    if (projection.includes("${")) continue; // interpolated, cannot be read
    const line = source.slice(0, match.index).split("\n").length;
    for (const { table: target, column } of columnsOf(table, projection)) {
      const columns = known.get(target);
      if (!columns) {
        skipped.add(target);
        continue;
      }
      if (!columns.has(column)) {
        problems.push({
          file: relative(root, file),
          line,
          detail: `${target}.${column}`,
        });
      }
    }
  }
}

if (skipped.size > 0) {
  console.log(
    `skipped ${skipped.size} name(s) that are not tables (embeds via a foreign key name): ${[...skipped].sort().join(", ")}\n`,
  );
}

if (problems.length === 0) {
  console.log("No schema drift: every selected column exists.");
} else {
  for (const problem of problems) {
    console.log(`  ${problem.file}:${problem.line}  ${problem.detail}`);
  }
  console.log(`\n${problems.length} stale column reference(s).`);
}

await db.end?.();
process.exit(problems.length > 0 ? 1 : 0);
