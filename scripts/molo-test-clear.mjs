/**
 * CLEAR MOLO ELECTRIC TEST DATA.
 *
 *   node scripts/molo-test-clear.mjs
 *
 * Removes only what molo-test-seed.mjs created: everything hanging off the MOLO
 * location whose records carry the MOLO-ELECTRIC-TEST-202605 tag.
 *
 * It refuses rather than guesses. If anything real has attached itself to the
 * test data since it was seeded -- an invoice raised against one of these
 * contracts, a payment, a journal entry -- the run stops and says so, leaving
 * everything in place for you to look at.
 */

import { openConnection, lit } from "./db-transport.mjs";

const TAG = "MOLO-ELECTRIC-TEST-202605";

const db = await openConnection();
const run = db.query ?? db;

const [location] = await run(`
  select id, code, name from public.locations
   where lower(code) = 'molo' and address = ${lit(TAG)}
`);

if (!location) {
  console.log("Nothing to clear: no MOLO location carrying the test tag.");
  if (db.end) await db.end();
  process.exit(0);
}

const units = await run(
  `select id, code from public.units where location_id = ${lit(location.id)}`,
);
const unitIds = units.map((u) => `'${u.id}'`).join(",") || "null";

const contracts = await run(`
  select distinct c.id, c.contract_no
    from public.contracts c
    join public.contract_units cu on cu.contract_id = c.id
   where cu.unit_id in (${unitIds})
`);
const contractIds = contracts.map((c) => `'${c.id}'`).join(",") || "null";

const tenants = await run(`
  select distinct t.id, t.company_name
    from public.tenants t
    join public.contracts c on c.tenant_id = t.id
   where c.id in (${contractIds}) and t.notes = ${lit(TAG)}
`);

// Anything real that has attached itself since seeding.
const [{ invoices, payments, entries }] = await run(`
  select
    (select count(*) from public.invoices
      where contract_id in (${contractIds})) as invoices,
    (select count(*) from public.payments
      where contract_id in (${contractIds})) as payments,
    (select count(*) from public.journal_entries
      where source_table = 'utility_periods'
        and source_id in (select id from public.utility_periods
                           where location_id = ${lit(location.id)})) as entries
`);

if (Number(invoices) > 0 || Number(payments) > 0 || Number(entries) > 0) {
  console.error(
    `Stopping. Real records now depend on this test data: ${invoices} invoice(s), ` +
      `${payments} payment(s), ${entries} journal entr(ies). Nothing was deleted.`,
  );
  process.exit(1);
}

console.log(`Clearing ${TAG}:`);
console.log(`  ${units.length} spaces, ${contracts.length} contracts, ${tenants.length} tenants`);

// Unwound in dependency order; several foreign keys are ON DELETE RESTRICT.
await run(`
  delete from public.meter_readings
   where period_id in (select id from public.utility_periods
                        where location_id = ${lit(location.id)});
`);
await run(
  `delete from public.utility_periods where location_id = ${lit(location.id)};`,
);
await run(`delete from public.contract_units where contract_id in (${contractIds});`);
await run(`delete from public.contract_escalations where contract_id in (${contractIds});`);
await run(`delete from public.contracts where id in (${contractIds});`);
for (const tenant of tenants) {
  await run(`delete from public.tenants where id = ${lit(tenant.id)};`);
}
await run(`delete from public.units where location_id = ${lit(location.id)};`);
await run(`delete from public.locations where id = ${lit(location.id)};`);

const [{ left }] = await run(`
  select count(*) as left from public.locations where lower(code) = 'molo'
`);
console.log(`Done. MOLO locations remaining: ${left}`);

if (db.end) await db.end();
