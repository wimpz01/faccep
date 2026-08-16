/**
 * MOLO-ELECTRIC-TEST-202605 — previous electric readings only.
 *
 *   node scripts/molo-test-seed.mjs
 *
 * Creates a MOLO location, its spaces, their tenants and a May 2026 electric
 * period holding the readings taken on 31 May 2026. Nothing else: no water, no
 * provider bill, no rate, no invoice, no ledger entry.
 *
 * How the reading carries forward, which is the thing being tested: a reading
 * belongs to a period, and when a later period is opened each unit's PREVIOUS
 * is filled from the highest PRESENT already recorded. So the May figures are
 * stored as May's present reading. Open the June period and they appear as the
 * previous reading with current blank, waiting to be typed.
 *
 * May's own previous is set equal to its present, giving that month a
 * consumption of nought. There is no April reading to work from, and inventing
 * one would put a fabricated consumption into the history. May exists here only
 * to carry the number forward.
 *
 * Everything is tagged MOLO-ELECTRIC-TEST-202605 and removed by
 * scripts/molo-test-clear.mjs.
 */

import { openConnection, lit } from "./db-transport.mjs";

const TAG = "MOLO-ELECTRIC-TEST-202605";
const READING_DATE = "2026-05-31";

/**
 * The source list, exactly as supplied.
 *
 * GF-B appears three times. A reading is unique per unit per period, so the
 * three are given their own spaces rather than being merged or dropped; the
 * meter serial stays 529452 on all three, as supplied.
 *
 * Meter 97217125 appears on both GF-G and GF-F. It is stored as given: the
 * schema puts no uniqueness on a meter serial, so nothing rejects or rewrites
 * it, which is the answer to that part of the test.
 */
const ROWS = [
  { code: "M43", tenant: "MEDICRUZ PHAR", unit: "MOLO GF-E", meter: "2309021528", reading: 7189.8 },
  { code: "M44", tenant: "PETNET, INC.", unit: "MOLO GF-D", meter: "3868195", reading: 5885 },
  { code: "M45", tenant: "RD PAWNSHOP", unit: "MOLO GF-C", meter: "96945804", reading: 37275 },
  { code: null, tenant: "CM & SONS FOOD PI", unit: "MOLO GF-B", meter: "529452", reading: 100000 },
  { code: "M46", tenant: "SHA MOTOR", unit: "MOLO GF-A", meter: "1816417", reading: 74938.3 },
  { code: "M47", tenant: "KICK & STEPS SHOES", unit: "MOLO GF-G", meter: "97217125", reading: 88.6 },
  { code: "M48", tenant: "ANGEL BURGER", unit: "MOLO GF-F", meter: "97217125", reading: 1299 },
  { code: "M49", tenant: "KUSOG FITNESS GYM", unit: "MOLO KUSOG", meter: "30899054", reading: 1299 },
  // Vacant: a space with a meter and no tenant, so no contract either.
  { code: null, tenant: null, unit: "MOLO GF-K", meter: "F&C", reading: 0 },
  { code: null, tenant: "CM & SONS FOOD PI", unit: "MOLO GF-B-2", meter: "529452", reading: 2244 },
  { code: "M50", tenant: "CM & SONS FOOD PI", unit: "MOLO GF-B-3", meter: "529452", reading: 2244 },
];

const db = await openConnection();
const run = db.query ?? db;

const [company] = await run(
  `select id, name from public.companies where is_active order by created_at limit 1`,
);
if (!company) {
  console.error("No active company found.");
  process.exit(1);
}
console.log(`Company: ${company.name}`);

const clash = await run(
  `select code from public.locations where company_id = ${lit(company.id)} and lower(code) = 'molo'`,
);
if (clash.length > 0) {
  console.error(
    "A location called MOLO already exists. Stopping rather than touching it.",
  );
  process.exit(1);
}

const [location] = await run(`
  insert into public.locations (company_id, code, name, property_type, address)
  values (${lit(company.id)}, 'MOLO', ${lit(`MOLO (${TAG})`)}, 'commercial_building',
          ${lit(TAG)})
  returning id;
`);
console.log("Created location MOLO");

// Tenants: one record per name, however many spaces they hold.
const tenantNames = [...new Set(ROWS.map((r) => r.tenant).filter(Boolean))];
const tenantId = new Map();
for (const name of tenantNames) {
  const [row] = await run(`
    insert into public.tenants (company_id, company_name, notes, status)
    values (${lit(company.id)}, ${lit(name)}, ${lit(TAG)}, 'active')
    returning id;
  `);
  tenantId.set(name, row.id);
}
console.log(`Created ${tenantNames.length} tenants`);

const unitId = new Map();
for (const row of ROWS) {
  const [unit] = await run(`
    insert into public.units
      (company_id, location_id, code, electric_meter_serial, description, status)
    values (${lit(company.id)}, ${lit(location.id)}, ${lit(row.unit)},
            ${lit(row.meter)}, ${lit(TAG)},
            ${row.tenant ? "'occupied'" : "'vacant'"})
    returning id;
  `);
  unitId.set(row.unit, unit.id);
}
console.log(`Created ${ROWS.length} spaces`);

/*
 * A contract per occupied space, so the billing run has something to charge the
 * electricity to. Rent is nought and the term is the second half of 2026: both
 * are the test's own, not real terms, which is why they carry the tag.
 */
let contracts = 0;
for (const row of ROWS) {
  if (!row.tenant) continue;
  const [contract] = await run(`
    insert into public.contracts
      (company_id, tenant_id, contract_no, status, start_date, end_date,
       monthly_rent, security_deposit, advance_payment, escalation_rate,
       electric_billing_type, water_billing_type, notes)
    values (${lit(company.id)}, ${lit(tenantId.get(row.tenant))},
            ${lit(`MOLO-TEST-${row.unit.replace(/\s+/g, "-")}`)}, 'active',
            '2026-06-01', '2026-12-31', 0, 0, 0, 0,
            'consumption', 'consumption', ${lit(TAG)})
    returning id;
  `);
  await run(`
    insert into public.contract_units (contract_id, unit_id)
    values (${lit(contract.id)}, ${lit(unitId.get(row.unit))});
  `);
  contracts += 1;
}
console.log(`Created ${contracts} contracts (rent 0, 1 Jun – 31 Dec 2026)`);

/*
 * The May period carries the readings and nothing else. No provider bill, so no
 * derived rate and nothing billable -- left unlocked, since locking is what
 * makes a period billable and May is history.
 */
const [period] = await run(`
  insert into public.utility_periods
    (company_id, location_id, utility, period_start, period_end,
     provider_amount, provider_consumption, extra_expense, notes)
  values (${lit(company.id)}, ${lit(location.id)}, 'electric',
          '2026-05-01', '2026-05-31', 0, 0, 0,
          ${lit(`${TAG} — previous readings imported, no provider bill`)})
  returning id;
`);

for (const row of ROWS) {
  await run(`
    insert into public.meter_readings
      (company_id, period_id, unit_id, previous_reading, present_reading,
       reading_date, notes)
    values (${lit(company.id)}, ${lit(period.id)}, ${lit(unitId.get(row.unit))},
            ${row.reading}, ${row.reading}, ${lit(READING_DATE)}, ${lit(TAG)});
  `);
}
console.log(`Created the May 2026 electric period with ${ROWS.length} readings`);

const check = await run(`
  select u.code as space, u.electric_meter_serial as meter,
         coalesce(t.company_name, '(vacant)') as tenant,
         m.present_reading as reading_31_may
    from public.meter_readings m
    join public.units u on u.id = m.unit_id
    left join public.contract_units cu on cu.unit_id = u.id
    left join public.contracts c on c.id = cu.contract_id
    left join public.tenants t on t.id = c.tenant_id
   where m.period_id = ${lit(period.id)}
   order by u.code;
`);

console.log("\nImported — reading as at 31 May 2026:\n");
for (const row of check) {
  console.log(
    `  ${row.tenant.padEnd(20)} ${row.space.padEnd(12)} ${String(row.meter).padEnd(12)} ${String(
      Number(row.reading_31_may),
    ).padStart(10)}`,
  );
}
console.log(`\n${check.length} spaces. No current reading recorded anywhere.`);

if (db.end) await db.end();
