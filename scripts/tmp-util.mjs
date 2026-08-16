import { openConnection } from "./db-transport.mjs";
const db = await openConnection();
const run = db.query ?? db;
const t = await run(`
  select t.tgname,
         (select string_agg(a.attname, ', ' order by a.attnum)
            from unnest(t.tgattr) col
            join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = col) as watches
    from pg_trigger t
   where t.tgrelid = 'public.utility_periods'::regclass and not t.tgisinternal
   order by t.tgname`);
console.log("triggers on utility_periods:", JSON.stringify(t, null, 2));
const c = await run(`
  select column_name from information_schema.columns
   where table_name = 'utility_periods' and column_name like '%expense%'`);
console.log("columns:", JSON.stringify(c));
const e = await run(`select enumlabel from pg_enum where enumtypid = 'public.invoice_line_kind'::regtype order by enumsortorder`);
console.log("line kinds:", JSON.stringify(e.map(r=>r.enumlabel)));
if (db.end) await db.end();
