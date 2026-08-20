/**
 * End-to-end check of the permission model against the live database.
 *
 *   node scripts/db-verify.mjs
 *
 * Creates two throwaway companies and three throwaway users, exercises every
 * rung of the precedence ladder, the tenancy boundary, the append-only audit
 * log and the Phase 2 triggers, then deletes everything it made. Safe to run
 * repeatedly; it touches nothing else.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, plus either
 * SUPABASE_DB_URL or SUPABASE_ACCESS_TOKEN.
 */

import { createClient } from "@supabase/supabase-js";

import { lit, openConnection } from "./db-transport.mjs";

const TEST_TAG = `zz-verify-${Date.now()}`;

for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name} in .env.local.`);
    process.exit(1);
  }
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

let db;
let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}`);
    console.log(
      `        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * Runs a block with auth.uid() bound to userId under the `authenticated` role.
 * The whole block is one transaction that is always rolled back, so nothing an
 * impersonated statement writes survives.
 */
function asUser(userId, sql) {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" });
  return db.query(`
    begin;
    select set_config('request.jwt.claims', ${lit(claims)}, true);
    set local role authenticated;
    ${sql}
    rollback;
  `);
}

/**
 * Same impersonation, but committed. Use only where the write itself is what
 * is being verified; asUser is the default because it leaves nothing behind.
 */
function asUserCommitted(userId, sql) {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" });
  return db.query(`
    begin;
    select set_config('request.jwt.claims', ${lit(claims)}, true);
    set local role authenticated;
    ${sql}
    commit;
  `);
}

async function perm(userId, companyId, moduleKey, action) {
  const rows = await asUser(
    userId,
    `select public.has_permission(${lit(companyId)}, ${lit(moduleKey)}, ${lit(action)}) as allowed;`,
  );
  return rows[0].allowed;
}

async function expectFail(sql) {
  try {
    await db.query(sql);
    return "allowed";
  } catch {
    return "blocked";
  }
}

async function expectFailAsUser(userId, sql) {
  try {
    await asUser(userId, `${sql}\nselect 1 as ok;`);
    return "allowed";
  } catch {
    return "blocked";
  }
}

const createdUserIds = [];

async function makeUser(label) {
  const email = `${TEST_TAG}-${label}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `${TEST_TAG}-Password!1`,
    email_confirm: true,
    user_metadata: { full_name: `Verify ${label}` },
  });
  if (error) throw new Error(`could not create ${label}: ${error.message}`);
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function main() {
  db = await openConnection();
  console.log(`Using the ${db.label}.`);

  console.log("\nSchema");
  const moduleRows = await db.query(
    "select count(*)::int as n from public.modules;",
  );
  const moduleCount = moduleRows[0].n;
  check("module registry is seeded", moduleCount > 40, true);

  const rlsOff = await db.query(`
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relrowsecurity = false
       and c.relname in ('companies','locations','profiles','roles',
                         'role_permissions','company_users','user_permissions',
                         'audit_log','modules','units','unit_photos','tenants',
                         'contracts','contract_units','contract_inclusions')
     order by c.relname;
  `);
  check(
    "row level security on every core table",
    rlsOff.map((row) => row.relname),
    [],
  );

  console.log("\nFixtures");
  const regular = await makeUser("regular");
  const companyAdmin = await makeUser("companyadmin");
  const superAdmin = await makeUser("superadmin");
  console.log(`  made 3 users tagged ${TEST_TAG}`);

  const companies = await db.query(`
    insert into public.companies (name)
    values (${lit(`${TEST_TAG}-alpha`)}), (${lit(`${TEST_TAG}-beta`)})
    returning id, name;
  `);
  const alpha = companies.find((row) => row.name.endsWith("alpha")).id;
  const beta = companies.find((row) => row.name.endsWith("beta")).id;

  const roleRows = await db.query(`
    insert into public.roles (company_id, name, description)
    values (${lit(alpha)}, 'Verify Billing', 'temporary')
    returning id;
  `);
  const roleId = roleRows[0].id;

  // Role grants: view+edit on invoices, view only on payments, nothing else.
  await db.query(`
    insert into public.role_permissions
      (role_id, module_key, can_view, can_edit, can_delete, can_approve, can_void)
    values
      (${lit(roleId)}, 'billing.invoices', true, true, false, false, false),
      (${lit(roleId)}, 'payments',         true, false, false, false, false);
  `);

  const membership = await db.query(`
    insert into public.company_users (company_id, user_id, role_id)
    values (${lit(alpha)}, ${lit(regular)}, ${lit(roleId)})
    returning id;
  `);
  const companyUserId = membership[0].id;

  await db.query(`
    insert into public.company_users (company_id, user_id, is_company_admin)
    values (${lit(alpha)}, ${lit(companyAdmin)}, true);
  `);

  await db.query(
    `update public.profiles set is_super_admin = true where id = ${lit(superAdmin)};`,
  );

  await db.query(`
    insert into public.locations (company_id, code, name)
    values (${lit(alpha)}, 'A1', 'Alpha building'),
           (${lit(alpha)}, 'A2', 'Alpha annexe'),
           (${lit(beta)},  'B1', 'Beta building');
  `);

  // Letters are handed out by the database, lowest free first, per company.
  const letters = await db.query(`
    select code, invoice_prefix from public.locations
     where company_id in (${lit(alpha)}, ${lit(beta)})
     order by company_id, created_at, id;
  `);
  check(
    "a new location is given the next free letter without being told",
    letters.map((row) => `${row.code}=${row.invoice_prefix}`).sort().join(","),
    "A1=A,A2=B,B1=A",
  );

  console.log("\nPrecedence: role");
  check("role grant -> view", await perm(regular, alpha, "billing.invoices", "view"), true);
  check("role grant -> edit", await perm(regular, alpha, "billing.invoices", "edit"), true);
  check("role silent -> delete denied", await perm(regular, alpha, "billing.invoices", "delete"), false);
  check("module absent from role -> denied", await perm(regular, alpha, "tenants", "view"), false);
  check("segregation: view payments", await perm(regular, alpha, "payments", "view"), true);
  check("segregation: cannot edit payments", await perm(regular, alpha, "payments", "edit"), false);

  console.log("\nPrecedence: per-user override");
  await db.query(`
    insert into public.user_permissions (company_user_id, module_key, can_edit)
    values (${lit(companyUserId)}, 'billing.invoices', false);
  `);
  check("override denies what the role allows", await perm(regular, alpha, "billing.invoices", "edit"), false);
  check("untouched action still inherits", await perm(regular, alpha, "billing.invoices", "view"), true);

  await db.query(`
    insert into public.user_permissions (company_user_id, module_key, can_view)
    values (${lit(companyUserId)}, 'tenants', true);
  `);
  check("override grants what the role omits", await perm(regular, alpha, "tenants", "view"), true);

  console.log("\nPrecedence: admins");
  check("company admin -> arbitrary module", await perm(companyAdmin, alpha, "accounting.journal", "edit"), true);
  check("company admin -> not in other company", await perm(companyAdmin, beta, "accounting.journal", "view"), false);
  check("super admin -> company alpha", await perm(superAdmin, alpha, "accounting.journal", "approve"), true);
  check("super admin -> company beta too", await perm(superAdmin, beta, "accounting.journal", "approve"), true);

  console.log("\nTenancy boundary (RLS)");
  // DISTINCT so a stranded fixture from an interrupted run cannot skew these.
  const visible = await asUser(
    regular,
    "select coalesce(string_agg(distinct code, ',' order by code), '') as codes from public.locations;",
  );
  // Both of alpha's, and neither of beta's.
  check("sees only its own company's locations", visible[0].codes, "A1,A2");

  const superSees = await asUser(
    superAdmin,
    "select coalesce(string_agg(distinct code, ',' order by code), '') as codes from public.locations where code in ('A1','B1');",
  );
  check("super admin sees both companies", superSees[0].codes, "A1,B1");

  check(
    "cannot create a location without admin.locations edit",
    await expectFailAsUser(
      regular,
      // The letter fills itself in, so a refusal can only be the permission.
      `insert into public.locations (company_id, code, name) values (${lit(alpha)}, 'X9', 'nope');`,
    ),
    "blocked",
  );

  console.log("\nAudit trail is append-only");
  await db.query(`
    insert into public.audit_log
      (company_id, actor_id, actor_email, action, module_key, entity_table, summary)
    values (${lit(alpha)}, ${lit(regular)}, 'verify@example.invalid', 'create',
            'admin.locations', 'locations', 'verify fixture');
  `);
  check(
    "update refused",
    await expectFailAsUser(regular, "update public.audit_log set summary = 'tampered';"),
    "blocked",
  );
  check(
    "delete refused",
    await expectFailAsUser(regular, "delete from public.audit_log;"),
    "blocked",
  );

  console.log("\nPhase 2: units, tenants, contracts");
  const locationRows = await db.query(
    `select id from public.locations where company_id = ${lit(alpha)} and code = 'A1';`,
  );
  const locationId = locationRows[0].id;

  const unitRows = await db.query(`
    insert into public.units (company_id, location_id, code, monthly_rate)
    values (${lit(alpha)}, ${lit(locationId)}, 'U1', 15000)
    returning id, status;
  `);
  const unitId = unitRows[0].id;
  check("a new unit starts vacant", unitRows[0].status, "vacant");

  const tenantRows = await db.query(`
    insert into public.tenants (company_id, company_name, is_vatable)
    values (${lit(alpha)}, ${lit(`${TEST_TAG}-tenant`)}, true)
    returning id;
  `);
  const tenantId = tenantRows[0].id;

  const contractRows = await db.query(`
    insert into public.contracts
      (company_id, tenant_id, contract_no, start_date, end_date, term_years,
       monthly_rent, security_deposit, escalation_rate)
    values (${lit(alpha)}, ${lit(tenantId)}, ${lit(`${TEST_TAG}-C1`)},
            '2026-01-01', '2026-12-31', 1, 15000, 30000, 3)
    returning id;
  `);
  const contractId = contractRows[0].id;

  async function unitStatus() {
    const rows = await db.query(
      `select status from public.units where id = ${lit(unitId)};`,
    );
    return rows[0].status;
  }

  await db.query(
    `insert into public.contract_units (contract_id, unit_id) values (${lit(contractId)}, ${lit(unitId)});`,
  );
  check("a draft contract reserves the unit", await unitStatus(), "reserved");

  await db.query(
    `update public.contracts set status = 'active' where id = ${lit(contractId)};`,
  );
  check("activating occupies the unit", await unitStatus(), "occupied");

  await db.query(
    `update public.contracts set status = 'terminated' where id = ${lit(contractId)};`,
  );
  check("terminating releases the unit", await unitStatus(), "vacant");

  check(
    "escalation is restricted to 0/3/5",
    await expectFail(
      `update public.contracts set escalation_rate = 4 where id = ${lit(contractId)};`,
    ),
    "blocked",
  );
  check(
    "end date must follow start date",
    await expectFail(
      `update public.contracts set end_date = '2025-01-01' where id = ${lit(contractId)};`,
    ),
    "blocked",
  );
  check(
    "blacklisting needs a reason",
    await expectFail(
      `update public.tenants set status = 'blacklisted' where id = ${lit(tenantId)};`,
    ),
    "blocked",
  );

  await db.query(`
    update public.tenants
       set status = 'blacklisted', blacklist_reason = 'vacated without notice'
     where id = ${lit(tenantId)};
  `);
  check(
    "a blacklisted tenant is refused a new contract",
    await expectFail(`
      insert into public.contracts
        (company_id, tenant_id, contract_no, start_date, end_date)
      values (${lit(alpha)}, ${lit(tenantId)}, ${lit(`${TEST_TAG}-C2`)},
              '2027-01-01', '2027-12-31');
    `),
    "blocked",
  );

  check(
    "cannot create a tenant without tenants edit",
    await expectFailAsUser(
      regular,
      `insert into public.tenants (company_id, company_name) values (${lit(alpha)}, 'nope');`,
    ),
    "blocked",
  );

  const tenantRead = await asUser(
    regular,
    `select count(*)::int as n from public.tenants where company_id = ${lit(alpha)};`,
  );
  check("company members can still read tenants", tenantRead[0].n > 0, true);

  console.log("\nPhase 3: invoices, payments, approvals");

  // A fresh tenant and contract, since the earlier ones are now blacklisted.
  const billTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name, is_vatable)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-billed`)}, true)
      returning id;
    `)
  )[0].id;

  const invoiceId = (
    await db.query(`
      insert into public.invoices
        (company_id, tenant_id, invoice_no, invoice_date, due_date, is_vatable)
      values (${lit(alpha)}, ${lit(billTenant)}, ${lit(`${TEST_TAG}-INV1`)},
              '2026-03-01', '2026-03-05', true)
      returning id;
    `)
  )[0].id;

  // tax_treatment is the input now; is_vatable is derived from what was charged.
  await db.query(`
    insert into public.invoice_lines
      (invoice_id, line_kind, description, quantity, unit_price, amount,
       tax_treatment, vat_mode)
    values (${lit(invoiceId)}, 'rent', 'Rent', 1, 10000, 10000, 'vatable', 'exclusive'),
           (${lit(invoiceId)}, 'water', 'Water', 1, 500, 500, 'non_vat', null);
  `);

  const totals = await db.query(
    `select subtotal, vat_amount, total from public.invoices where id = ${lit(invoiceId)};`,
  );
  // VAT is charged only on the vatable line: 10000 * 12% = 1200.
  check(
    "invoice totals recompute from the lines",
    [Number(totals[0].subtotal), Number(totals[0].vat_amount), Number(totals[0].total)],
    [10500, 1200, 11700],
  );

  await db.query(
    `update public.invoices set status = 'released', released_at = now() where id = ${lit(invoiceId)};`,
  );

  check(
    "a released invoice cannot be edited",
    await expectFail(
      `update public.invoices set total = 1 where id = ${lit(invoiceId)};`,
    ),
    "blocked",
  );
  check(
    "a released invoice's lines cannot be edited",
    await expectFail(
      `update public.invoice_lines set amount = 1 where invoice_id = ${lit(invoiceId)};`,
    ),
    "blocked",
  );

  const paymentId = (
    await db.query(`
      insert into public.payments
        (company_id, tenant_id, payment_no, payment_date, amount)
      values (${lit(alpha)}, ${lit(billTenant)}, ${lit(`${TEST_TAG}-OR1`)},
              '2026-03-04', 5000)
      returning id;
    `)
  )[0].id;

  await db.query(`
    insert into public.payment_applications (payment_id, invoice_id, amount)
    values (${lit(paymentId)}, ${lit(invoiceId)}, 5000);
  `);

  const afterPayment = await db.query(
    `select status, amount_paid from public.invoices where id = ${lit(invoiceId)};`,
  );
  check(
    "applying a payment moves the invoice to partially paid",
    [afterPayment[0].status, Number(afterPayment[0].amount_paid)],
    ["partially_paid", 5000],
  );

  check(
    "a posted payment cannot be edited",
    await expectFail(
      `update public.payments set amount = 99 where id = ${lit(paymentId)};`,
    ),
    "blocked",
  );

  await db.query(`
    insert into public.credit_memos (company_id, invoice_id, memo_no, amount, reason)
    values (${lit(alpha)}, ${lit(invoiceId)}, ${lit(`${TEST_TAG}-CM1`)}, 6700, 'overbilled');
  `);
  const afterCredit = await db.query(
    `select status, credited_amount from public.invoices where id = ${lit(invoiceId)};`,
  );
  check(
    "a credit memo settles the remaining balance",
    [afterCredit[0].status, Number(afterCredit[0].credited_amount)],
    ["paid", 6700],
  );

  await db.query(
    `update public.payments set status = 'voided', voided_at = now(), void_reason = 'bounced' where id = ${lit(paymentId)};`,
  );
  const afterVoid = await db.query(
    `select status, amount_paid from public.invoices where id = ${lit(invoiceId)};`,
  );
  check(
    "voiding a payment reopens the invoice balance",
    [afterVoid[0].status, Number(afterVoid[0].amount_paid)],
    ["partially_paid", 0],
  );

  await db.query(`
    insert into public.approval_requests
      (company_id, module_key, entity_table, entity_id, action, reason, requested_by)
    values (${lit(alpha)}, 'billing.invoices', 'invoices', ${lit(invoiceId)},
            'cancel', 'duplicate', ${lit(regular)});
  `);
  check(
    "only one open approval per record and action",
    await expectFail(`
      insert into public.approval_requests
        (company_id, module_key, entity_table, entity_id, action, reason, requested_by)
      values (${lit(alpha)}, 'billing.invoices', 'invoices', ${lit(invoiceId)},
              'cancel', 'again', ${lit(regular)});
    `),
    "blocked",
  );

  // Meter readings and the derived rate.
  const periodId = (
    await db.query(`
      insert into public.utility_periods
        (company_id, location_id, utility, period_start, period_end,
         provider_amount, provider_consumption, extra_expense)
      values (${lit(alpha)}, ${lit(locationId)}, 'electric', '2026-03-01', '2026-03-31',
              50000, 5000, 10000)
      returning id;
    `)
  )[0].id;

  const rate = await db.query(
    `select public.utility_period_rate(${lit(periodId)}) as rate;`,
  );
  check("derived rate is provider amount over consumption", Number(rate[0].rate), 10);

  await db.query(`
    insert into public.meter_readings
      (company_id, period_id, unit_id, previous_reading, present_reading)
    values (${lit(alpha)}, ${lit(periodId)}, ${lit(unitId)}, 100, 350);
  `);
  const consumption = await db.query(
    `select consumption from public.meter_readings where period_id = ${lit(periodId)};`,
  );
  check("consumption is generated from the readings", Number(consumption[0].consumption), 250);

  check(
    "a present reading below the previous one is refused",
    await expectFail(
      `update public.meter_readings set present_reading = 50 where period_id = ${lit(periodId)};`,
    ),
    "blocked",
  );

  // A rate set by hand is what tenants are charged, so the unmetered use --
  // corridors, pumps, line loss -- is recovered rather than absorbed.
  await db.query(
    `update public.utility_periods set manual_rate = 11.2 where id = ${lit(periodId)};`,
  );
  const overridden = await db.query(
    `select public.utility_period_rate(${lit(periodId)}) as rate;`,
  );
  check("a rate set by hand overrides the derived one", Number(overridden[0].rate), 11.2);

  // Nought is a real rate, not an absent one: it must not fall back to 10.
  await db.query(
    `update public.utility_periods set manual_rate = 0 where id = ${lit(periodId)};`,
  );
  const zeroed = await db.query(
    `select public.utility_period_rate(${lit(periodId)}) as rate;`,
  );
  check("a rate of nought is charged, not treated as unset", Number(zeroed[0].rate), 0);

  await db.query(
    `update public.utility_periods set manual_rate = null where id = ${lit(periodId)};`,
  );
  const cleared = await db.query(
    `select public.utility_period_rate(${lit(periodId)}) as rate;`,
  );
  check("clearing the rate returns to the derived one", Number(cleared[0].rate), 10);

  // Once invoices are out, the rate they were billed at cannot move under them.
  await db.query(
    `update public.utility_periods set is_locked = true where id = ${lit(periodId)};`,
  );
  check(
    "a locked period refuses a change of rate",
    await expectFail(
      `update public.utility_periods set manual_rate = 12 where id = ${lit(periodId)};`,
    ),
    "blocked",
  );
  await db.query(
    `update public.utility_periods set is_locked = false where id = ${lit(periodId)};`,
  );

  console.log("\nPhase 5: inventory, tools, maintenance");

  const itemId = (
    await db.query(`
      insert into public.inventory_items (company_id, name, unit_of_measure, unit_cost)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-cable`)}, 'm', 25)
      returning id, quantity_on_hand;
    `)
  )[0].id;

  await db.query(`
    insert into public.inventory_movements
      (company_id, item_id, movement_kind, quantity)
    values (${lit(alpha)}, ${lit(itemId)}, 'receipt', 100);
  `);
  await db.query(`
    insert into public.inventory_movements
      (company_id, item_id, movement_kind, quantity)
    values (${lit(alpha)}, ${lit(itemId)}, 'issue', -30);
  `);
  await db.query(`
    insert into public.inventory_movements
      (company_id, item_id, movement_kind, quantity)
    values (${lit(alpha)}, ${lit(itemId)}, 'return', 5);
  `);

  const onHand = await db.query(
    `select quantity_on_hand from public.inventory_items where id = ${lit(itemId)};`,
  );
  check(
    "stock on hand is the sum of the movement ledger",
    Number(onHand[0].quantity_on_hand),
    75,
  );

  const toolId = (
    await db.query(`
      insert into public.tools (company_id, name) values (${lit(alpha)}, ${lit(`${TEST_TAG}-drill`)})
      returning id;
    `)
  )[0].id;

  const loanId = (
    await db.query(`
      insert into public.tool_loans (company_id, tool_id, borrower_name)
      values (${lit(alpha)}, ${lit(toolId)}, 'Verify Borrower')
      returning id;
    `)
  )[0].id;

  const borrowed = await db.query(
    `select status from public.tools where id = ${lit(toolId)};`,
  );
  check("borrowing a tool marks it out", borrowed[0].status, "borrowed");

  check(
    "a tool cannot be lent twice at once",
    await expectFail(`
      insert into public.tool_loans (company_id, tool_id, borrower_name)
      values (${lit(alpha)}, ${lit(toolId)}, 'Someone Else');
    `),
    "blocked",
  );

  await db.query(
    `update public.tool_loans set returned_at = current_date where id = ${lit(loanId)};`,
  );
  const returned = await db.query(
    `select status from public.tools where id = ${lit(toolId)};`,
  );
  check("returning a tool puts it back on the shelf", returned[0].status, "available");

  const jobId = (
    await db.query(`
      insert into public.maintenance_jobs (company_id, job_no, title)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-JOB1`)}, 'Fix roof')
      returning id;
    `)
  )[0].id;

  check(
    "a job cannot be completed without before and after photos",
    await expectFail(
      `update public.maintenance_jobs set status = 'completed' where id = ${lit(jobId)};`,
    ),
    "blocked",
  );

  await db.query(`
    insert into public.maintenance_job_photos (job_id, stage, storage_path)
    values (${lit(jobId)}, 'before', 'x/before.jpg'),
           (${lit(jobId)}, 'after',  'x/after.jpg');
  `);
  await db.query(
    `update public.maintenance_jobs set status = 'completed' where id = ${lit(jobId)};`,
  );
  const completed = await db.query(
    `select status from public.maintenance_jobs where id = ${lit(jobId)};`,
  );
  check("with both photos the job completes", completed[0].status, "completed");

  check(
    "material lines cannot record more used than issued",
    await expectFail(`
      insert into public.material_requests (company_id, request_no)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-MR1`)});
      insert into public.material_request_lines
        (request_id, item_id, quantity_requested, quantity_issued, quantity_used)
      values ((select id from public.material_requests where request_no = ${lit(`${TEST_TAG}-MR1`)}),
              ${lit(itemId)}, 10, 10, 20);
    `),
    "blocked",
  );

  console.log("\nPhase 6: accounting");

  // Seeding the chart is what switches automatic posting on for a company.
  await db.query(`select public.seed_chart_of_accounts(${lit(alpha)});`);
  const chart = await db.query(
    `select count(*)::int as n from public.chart_of_accounts where company_id = ${lit(alpha)};`,
  );
  check("standard chart seeds accounts", chart[0].n > 20, true);

  const cashId = (
    await db.query(
      `select id from public.chart_of_accounts where company_id = ${lit(alpha)} and code = '1010';`,
    )
  )[0].id;
  const rentIncomeId = (
    await db.query(
      `select id from public.chart_of_accounts where company_id = ${lit(alpha)} and code = '4000';`,
    )
  )[0].id;

  const entryId = (
    await db.query(`
      insert into public.journal_entries (company_id, entry_no, entry_date, memo)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-JV1`)}, '2026-05-15', 'rent received')
      returning id;
    `)
  )[0].id;

  await db.query(`
    insert into public.journal_lines (entry_id, account_id, debit, credit)
    values (${lit(entryId)}, ${lit(cashId)}, 10000, 0);
  `);

  check(
    "an unbalanced entry cannot be posted",
    await expectFail(
      `update public.journal_entries set status = 'posted' where id = ${lit(entryId)};`,
    ),
    "blocked",
  );

  check(
    "a line cannot carry both a debit and a credit",
    await expectFail(`
      insert into public.journal_lines (entry_id, account_id, debit, credit)
      values (${lit(entryId)}, ${lit(rentIncomeId)}, 500, 500);
    `),
    "blocked",
  );

  await db.query(`
    insert into public.journal_lines (entry_id, account_id, debit, credit)
    values (${lit(entryId)}, ${lit(rentIncomeId)}, 0, 10000);
  `);
  await db.query(
    `update public.journal_entries set status = 'posted', posted_at = now() where id = ${lit(entryId)};`,
  );
  const posted = await db.query(
    `select status from public.journal_entries where id = ${lit(entryId)};`,
  );
  check("a balanced entry posts", posted[0].status, "posted");

  check(
    "a posted entry cannot be edited",
    await expectFail(
      `update public.journal_entries set memo = 'tampered' where id = ${lit(entryId)};`,
    ),
    "blocked",
  );
  check(
    "a posted entry's lines cannot be edited",
    await expectFail(
      `update public.journal_lines set debit = 1 where entry_id = ${lit(entryId)};`,
    ),
    "blocked",
  );

  const trial = await db.query(`
    select code, balance from public.trial_balance(${lit(alpha)}, '2026-01-01', '2026-12-31')
     where code in ('1010', '4000') order by code;
  `);
  check(
    "trial balance signs to each account's normal side",
    trial.map((row) => [row.code, Number(row.balance)]),
    [
      ["1010", 10000],
      ["4000", 10000],
    ],
  );

  await db.query(`
    insert into public.accounting_periods (company_id, name, start_date, end_date, status)
    values (${lit(alpha)}, '2026-06', '2026-06-01', '2026-06-30', 'closed');
  `);

  const closedEntry = (
    await db.query(`
      insert into public.journal_entries (company_id, entry_no, entry_date)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-JV2`)}, '2026-06-15')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.journal_lines (entry_id, account_id, debit, credit)
    values (${lit(closedEntry)}, ${lit(cashId)}, 100, 0),
           (${lit(closedEntry)}, ${lit(rentIncomeId)}, 0, 100);
  `);
  check(
    "posting into a closed period is refused",
    await expectFail(
      `update public.journal_entries set status = 'posted' where id = ${lit(closedEntry)};`,
    ),
    "blocked",
  );
  const stillDraft = await db.query(
    `select status from public.journal_entries where id = ${lit(closedEntry)};`,
  );
  check("and the entry really stays a draft", stillDraft[0].status, "draft");

  console.log("\nAutomatic posting to the ledger");

  // A second tenant and a full billing cycle, so the postings can be traced.
  const autoTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name, is_vatable)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-auto`)}, true)
      returning id;
    `)
  )[0].id;

  const autoInvoice = (
    await db.query(`
      insert into public.invoices
        (company_id, tenant_id, invoice_no, invoice_date, due_date, is_vatable)
      values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-AINV`)},
              '2026-05-01', '2026-05-05', true)
      returning id;
    `)
  )[0].id;

  await db.query(`
    insert into public.invoice_lines
      (invoice_id, line_kind, description, quantity, unit_price, amount,
       tax_treatment, vat_mode)
    values (${lit(autoInvoice)}, 'rent', 'Rent', 1, 20000, 20000, 'vatable', 'exclusive'),
           (${lit(autoInvoice)}, 'electricity', 'Power', 1, 5000, 5000, 'non_vat', null);
  `);

  async function balanceOf(code) {
    const rows = await db.query(`
      select balance from public.trial_balance(${lit(alpha)}, '2026-01-01', '2026-12-31')
       where code = ${lit(code)};
    `);
    return Number(rows[0]?.balance ?? 0);
  }

  // Measured as deltas: earlier fixtures in this company have already moved
  // some of these accounts, and the test should not depend on that.
  const before = {
    ar: await balanceOf("1100"),
    rent: await balanceOf("4000"),
    utility: await balanceOf("4100"),
    vat: await balanceOf("2100"),
    cash: await balanceOf("1010"),
    advances: await balanceOf("2300"),
    maintenance: await balanceOf("5100"),
  };

  await db.query(
    `update public.invoices set status = 'released', released_at = now() where id = ${lit(autoInvoice)};`,
  );

  // 25000 net + 2400 VAT on the vatable line = 27400 receivable.
  check(
    "releasing an invoice debits receivables",
    (await balanceOf("1100")) - before.ar,
    27400,
  );
  check("rental income is credited", (await balanceOf("4000")) - before.rent, 20000);
  check(
    "utility income is credited",
    (await balanceOf("4100")) - before.utility,
    5000,
  );
  check("output VAT is credited", (await balanceOf("2100")) - before.vat, 2400);

  const autoPayment = (
    await db.query(`
      insert into public.payments
        (company_id, tenant_id, payment_no, payment_date, amount)
      values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-AOR`)},
              '2026-05-04', 27400)
      returning id;
    `)
  )[0].id;

  check("a receipt debits cash", (await balanceOf("1010")) - before.cash, 27400);
  check(
    "and parks it in customer advances",
    (await balanceOf("2300")) - before.advances,
    27400,
  );

  await db.query(`
    insert into public.payment_applications (payment_id, invoice_id, amount)
    values (${lit(autoPayment)}, ${lit(autoInvoice)}, 27400);
  `);

  check(
    "applying it clears the advance",
    (await balanceOf("2300")) - before.advances,
    0,
  );
  check("and clears the receivable", (await balanceOf("1100")) - before.ar, 0);

  await db.query(
    `update public.payments set status = 'voided', voided_at = now(), void_reason = 'bounced'
      where id = ${lit(autoPayment)};`,
  );
  check(
    "voiding the receipt reverses the cash",
    (await balanceOf("1010")) - before.cash,
    0,
  );

  // Payables: 10000 net + 1200 VAT - 500 withheld = 10700 payable.
  const autoVendor = (
    await db.query(`
      insert into public.vendors (company_id, name)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-supplier`)}) returning id;
    `)
  )[0].id;

  await db.query(`
    insert into public.supplier_invoices
      (company_id, vendor_id, invoice_no, invoice_date, due_date,
       amount, vat_amount, withholding_tax, total)
    values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(`${TEST_TAG}-SI`)},
            '2026-05-10', '2026-06-10', 10000, 1200, 500, 10700);
  `);

  check("a supplier invoice credits payables", await balanceOf("2000"), 10700);
  check("input VAT is debited", await balanceOf("1400"), 1200);
  check("withholding tax payable is credited", await balanceOf("2110"), 500);

  /**
   * A direct bill listing two services charges each to its own account.
   *
   * The accrual used to fire before the lines existed, so every direct bill
   * landed wholly in the fallback expense account. A bill that says it is
   * awaiting lines now waits for them; one that does not still posts on
   * insert, which is what the three checks above rely on.
   */
  const [security, hauling] = await db.query(`
    insert into public.non_stock_items
      (company_id, name, unit_of_measure, expense_account_id)
    values (${lit(alpha)}, ${lit(`${TEST_TAG}-guarding`)}, 'lot',
            public.account_by_code(${lit(alpha)}, '5300')),
           (${lit(alpha)}, ${lit(`${TEST_TAG}-hauling`)},  'trip',
            public.account_by_code(${lit(alpha)}, '5900'))
    returning id;
  `);

  const splitBefore = {
    security: await balanceOf("5300"),
    misc: await balanceOf("5900"),
  };

  const splitBill = (
    await db.query(`
      insert into public.supplier_invoices
        (company_id, vendor_id, invoice_no, invoice_date, due_date,
         amount, vat_amount, withholding_tax, total, awaiting_lines)
      values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(`${TEST_TAG}-SPLIT`)},
              '2026-05-11', '2026-06-11', 25000, 0, 0, 25000, true)
      returning id;
    `)
  )[0].id;

  await db.query(`
    insert into public.supplier_invoice_lines
      (invoice_id, line_no, description, unit_of_measure, quantity, unit_price,
       non_stock_item_id)
    values (${lit(splitBill)}, 1, 'Guard duty', 'lot',  1, 18000, ${lit(security.id)}),
           (${lit(splitBill)}, 2, 'Hauling',    'trip', 1,  7000, ${lit(hauling.id)});
  `);

  check(
    "a service line charges the account its item names",
    (await balanceOf("5300")) - splitBefore.security,
    18000,
  );
  check(
    "a second service on the same bill charges its own account",
    (await balanceOf("5900")) - splitBefore.misc,
    7000,
  );

  const splitEntry = await db.query(`
    select round(sum(jl.debit), 2) as debits, round(sum(jl.credit), 2) as credits
      from public.journal_entries je
      join public.journal_lines jl on jl.entry_id = je.id
     where je.source_table = 'supplier_invoices' and je.source_id = ${lit(splitBill)};
  `);
  check(
    "the split bill's entry balances",
    [Number(splitEntry[0].debits), Number(splitEntry[0].credits)],
    [25000, 25000],
  );

  // Materials issued hit maintenance expense at cost.
  await db.query(`
    insert into public.inventory_movements
      (company_id, item_id, movement_kind, quantity, unit_cost, note)
    values (${lit(alpha)}, ${lit(itemId)}, 'issue', -10, 25, 'verify issue');
  `);
  check(
    "issuing materials charges maintenance",
    (await balanceOf("5100")) - before.maintenance,
    250,
  );

  await db.query(`
    insert into public.inventory_movements
      (company_id, item_id, movement_kind, quantity, unit_cost, note)
    values (${lit(alpha)}, ${lit(itemId)}, 'return', 4, 25, 'verify return');
  `);
  check(
    "returning unused material credits it back",
    (await balanceOf("5100")) - before.maintenance,
    150,
  );

  // The whole point: after all that, the ledger still balances.
  const overall = await db.query(`
    select round(sum(debit_total), 2) as d, round(sum(credit_total), 2) as c
      from public.trial_balance(${lit(alpha)}, '1900-01-01', '2999-12-31');
  `);
  check(
    "the ledger balances after every automatic posting",
    Number(overall[0].d) === Number(overall[0].c),
    true,
  );

  const duplicate = await db.query(`
    select count(*)::int as n from public.journal_entries
     where company_id = ${lit(alpha)}
       and source_table = 'invoices' and source_id = ${lit(autoInvoice)}
       and source_event = 'release';
  `);
  check("each source event posts exactly once", duplicate[0].n, 1);

  console.log("\nPeriod close readiness");

  const closePeriod = (
    await db.query(`
      insert into public.accounting_periods (company_id, name, start_date, end_date)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-07`)}, '2026-07-01', '2026-07-31')
      returning id;
    `)
  )[0].id;

  // A draft invoice dated inside the period must block the close.
  const draftInvoice = (
    await db.query(`
      insert into public.invoices
        (company_id, tenant_id, invoice_no, invoice_date, due_date)
      values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-DRAFT`)},
              '2026-07-10', '2026-07-15')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.invoice_lines
      (invoice_id, line_kind, description, quantity, unit_price, amount)
    values (${lit(draftInvoice)}, 'rent', 'Rent', 1, 1000, 1000);
  `);

  const blockers = await db.query(`
    select kind, item_count from public.period_close_readiness(${lit(closePeriod)})
     where severity = 'blocker' order by kind;
  `);
  check(
    "a draft invoice is reported as a blocker",
    blockers.map((row) => row.kind),
    ["Draft invoices"],
  );

  check(
    "and the close is refused",
    await expectFail(
      `update public.accounting_periods set status = 'closed' where id = ${lit(closePeriod)};`,
    ),
    "blocked",
  );
  const stillOpen = await db.query(
    `select status from public.accounting_periods where id = ${lit(closePeriod)};`,
  );
  check("the period really stays open", stillOpen[0].status, "open");

  // Release it, leaving it unpaid: an outstanding receivable is a warning only.
  await db.query(
    `update public.invoices set status = 'released', released_at = now() where id = ${lit(draftInvoice)};`,
  );

  const afterRelease = await db.query(`
    select severity, kind from public.period_close_readiness(${lit(closePeriod)})
     order by severity, kind;
  `);
  check(
    "once released there are no blockers left",
    afterRelease.filter((row) => row.severity === "blocker").length,
    0,
  );
  check(
    "and an unpaid balance is not listed at all",
    afterRelease.some((row) => row.kind.toLowerCase().includes("unpaid")),
    false,
  );

  // A voucher prepared inside the period is on hold, so it blocks.
  const heldVoucher = (
    await db.query(`
      insert into public.check_vouchers
        (company_id, vendor_id, voucher_no, voucher_date, amount)
      values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(`${TEST_TAG}-CV`)},
              '2026-07-12', 500)
      returning id;
    `)
  )[0].id;

  const voucherBlockers = await db.query(`
    select kind from public.period_close_readiness(${lit(closePeriod)})
     where severity = 'blocker';
  `);
  check(
    "an unreleased cheque voucher blocks the close",
    voucherBlockers.map((row) => row.kind),
    ["Cheque vouchers not released"],
  );

  await db.query(
    `update public.check_vouchers set status = 'cancelled' where id = ${lit(heldVoucher)};`,
  );
  const afterVoucherCancel = await db.query(`
    select count(*)::int as n from public.period_close_readiness(${lit(closePeriod)})
     where severity = 'blocker';
  `);
  check("cancelling the voucher clears it", afterVoucherCancel[0].n, 0);

  console.log("\nCancel rather than delete");

  // A draft that will not proceed is cancelled; the document survives.
  const abandoned = (
    await db.query(`
      insert into public.invoices
        (company_id, tenant_id, invoice_no, invoice_date, due_date)
      values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-ABAND`)},
              '2026-07-05', '2026-07-10')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.invoice_lines
      (invoice_id, line_kind, description, quantity, unit_price, amount)
    values (${lit(abandoned)}, 'rent', 'Rent', 1, 900, 900);
  `);

  check(
    "an abandoned draft blocks the close while it sits there",
    (
      await db.query(`
        select count(*)::int as n from public.period_close_readiness(${lit(closePeriod)})
         where severity = 'blocker' and kind = 'Draft invoices';
      `)
    )[0].n,
    1,
  );

  await db.query(`
    update public.invoices
       set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'tenant withdrew'
     where id = ${lit(abandoned)};
  `);

  const afterCancel = await db.query(`
    select i.status, i.cancellation_reason, count(l.id)::int as lines
      from public.invoices i
      left join public.invoice_lines l on l.invoice_id = i.id
     where i.id = ${lit(abandoned)}
     group by i.status, i.cancellation_reason;
  `);
  check(
    "cancelling keeps the document, its reason and its lines",
    [afterCancel[0].status, afterCancel[0].cancellation_reason, afterCancel[0].lines],
    ["cancelled", "tenant withdrew", 1],
  );

  check(
    "and a cancelled draft no longer blocks the close",
    (
      await db.query(`
        select count(*)::int as n from public.period_close_readiness(${lit(closePeriod)})
         where severity = 'blocker' and kind = 'Draft invoices';
      `)
    )[0].n,
    0,
  );

  check(
    "a cancelled invoice cannot be resurrected",
    await expectFail(
      `update public.invoices set status = 'released' where id = ${lit(abandoned)};`,
    ),
    "blocked",
  );

  // The same for a journal entry.
  const abandonedJv = (
    await db.query(`
      insert into public.journal_entries (company_id, entry_no, entry_date)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-JVX`)}, '2026-07-22')
      returning id;
    `)
  )[0].id;
  await db.query(
    `update public.journal_entries set status = 'cancelled' where id = ${lit(abandonedJv)};`,
  );
  const jvCancelled = await db.query(
    `select status from public.journal_entries where id = ${lit(abandonedJv)};`,
  );
  check("a draft journal entry can be cancelled", jvCancelled[0].status, "cancelled");

  check(
    "a posted entry cannot be cancelled, only reversed",
    await expectFail(
      `update public.journal_entries set status = 'cancelled' where id = ${lit(entryId)};`,
    ),
    "blocked",
  );

  check(
    "a cancelled entry is frozen",
    await expectFail(
      `update public.journal_entries set memo = 'edit' where id = ${lit(abandonedJv)};`,
    ),
    "blocked",
  );

  await db.query(
    `update public.accounting_periods set status = 'closed', closed_at = now() where id = ${lit(closePeriod)};`,
  );
  const closed = await db.query(
    `select status from public.accounting_periods where id = ${lit(closePeriod)};`,
  );
  check("an unpaid invoice does not prevent the close", closed[0].status, "closed");

  // A draft journal entry blocks too.
  await db.query(
    `update public.accounting_periods set status = 'open', closed_at = null where id = ${lit(closePeriod)};`,
  );
  await db.query(`
    insert into public.journal_entries (company_id, entry_no, entry_date)
    values (${lit(alpha)}, ${lit(`${TEST_TAG}-JVD`)}, '2026-07-20');
  `);
  const jvBlockers = await db.query(`
    select kind from public.period_close_readiness(${lit(closePeriod)})
     where severity = 'blocker';
  `);
  check(
    "a draft journal entry blocks the close",
    jvBlockers.map((row) => row.kind),
    ["Draft journal entries"],
  );

  console.log("\nThree-way match: order, receipt, bill");

  const matchPo = (
    await db.query(`
      insert into public.purchase_orders
        (company_id, vendor_id, po_no, status, order_date)
      values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(`${TEST_TAG}-PO`)},
              'issued', '2026-05-02')
      returning id;
    `)
  )[0].id;

  const matchLine = (
    await db.query(`
      insert into public.purchase_order_lines
        (po_id, item_id, description, quantity, unit_price, amount)
      values (${lit(matchPo)}, ${lit(itemId)}, 'Cable', 100, 25, 2500)
      returning id;
    `)
  )[0].id;

  check(
    "an order with nothing received cannot be billed",
    await expectFail(`
      insert into public.supplier_invoices
        (company_id, vendor_id, po_id, invoice_no, amount, total)
      values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(matchPo)},
              ${lit(`${TEST_TAG}-EARLY`)}, 2500, 2500);
    `),
    "blocked",
  );

  // Receive 40 of the 100 ordered: 40 x 25 = 1000 billable.
  const receipt = (
    await db.query(`
      insert into public.goods_receipts (company_id, po_id, receipt_no, received_date)
      values (${lit(alpha)}, ${lit(matchPo)}, ${lit(`${TEST_TAG}-GR`)}, '2026-05-06')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.goods_receipt_lines (receipt_id, po_line_id, quantity)
    values (${lit(receipt)}, ${lit(matchLine)}, 40);
  `);

  check(
    "receiving records the value available to bill",
    Number(
      (await db.query(`select public.po_received_value(${lit(matchPo)}) as v;`))[0].v,
    ),
    1000,
  );

  check(
    "billing more than was received is refused",
    await expectFail(`
      insert into public.supplier_invoices
        (company_id, vendor_id, po_id, invoice_no, amount, total)
      values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(matchPo)},
              ${lit(`${TEST_TAG}-OVER`)}, 1500, 1500);
    `),
    "blocked",
  );

  await db.query(`
    insert into public.supplier_invoices
      (company_id, vendor_id, po_id, invoice_no, invoice_date, amount, total)
    values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(matchPo)},
            ${lit(`${TEST_TAG}-BILL1`)}, '2026-05-07', 600, 600);
  `);
  check(
    "a bill within the received value is accepted",
    Number(
      (await db.query(`select public.po_billed_value(${lit(matchPo)}) as v;`))[0].v,
    ),
    600,
  );

  check(
    "a second bill cannot take the total past what was received",
    await expectFail(`
      insert into public.supplier_invoices
        (company_id, vendor_id, po_id, invoice_no, amount, total)
      values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(matchPo)},
              ${lit(`${TEST_TAG}-BILL2`)}, 500, 500);
    `),
    "blocked",
  );

  await db.query(`
    insert into public.supplier_invoices
      (company_id, vendor_id, po_id, invoice_no, invoice_date, amount, total)
    values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(matchPo)},
            ${lit(`${TEST_TAG}-BILL3`)}, '2026-05-08', 400, 400);
  `);
  check(
    "but the exact remaining balance is billable",
    Number(
      (await db.query(`select public.po_billed_value(${lit(matchPo)}) as v;`))[0].v,
    ),
    1000,
  );

  console.log("\nNon-stock purchases");

  const securityExpense = (
    await db.query(
      `select id from public.chart_of_accounts where company_id = ${lit(alpha)} and code = '5300';`,
    )
  )[0].id;

  const svcBefore = await balanceOf("5300");
  const invBefore = await balanceOf("1200");
  const stockBefore = Number(
    (
      await db.query(
        `select quantity_on_hand from public.inventory_items where id = ${lit(itemId)};`,
      )
    )[0].quantity_on_hand,
  );

  const svcPo = (
    await db.query(`
      insert into public.purchase_orders
        (company_id, vendor_id, po_no, status, order_date)
      values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(`${TEST_TAG}-SVCPO`)},
              'issued', '2026-05-02')
      returning id;
    `)
  )[0].id;

  // One stocked line and one service line, so the split can be seen.
  const stockLine = (
    await db.query(`
      insert into public.purchase_order_lines
        (po_id, item_id, description, quantity, unit_price, amount)
      values (${lit(svcPo)}, ${lit(itemId)}, 'Cable', 40, 25, 1000)
      returning id;
    `)
  )[0].id;
  const serviceLine = (
    await db.query(`
      insert into public.purchase_order_lines
        (po_id, item_id, expense_account_id, description, quantity, unit_price, amount)
      values (${lit(svcPo)}, null, ${lit(securityExpense)},
              'Security services for May', 1, 3000, 3000)
      returning id;
    `)
  )[0].id;

  const svcReceipt = (
    await db.query(`
      insert into public.goods_receipts (company_id, po_id, receipt_no, received_date)
      values (${lit(alpha)}, ${lit(svcPo)}, ${lit(`${TEST_TAG}-SVCGR`)}, '2026-05-31')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.goods_receipt_lines (receipt_id, po_line_id, quantity)
    values (${lit(svcReceipt)}, ${lit(stockLine)}, 40),
           (${lit(svcReceipt)}, ${lit(serviceLine)}, 1);
  `);

  const stockAfterReceipt = Number(
    (
      await db.query(
        `select quantity_on_hand from public.inventory_items where id = ${lit(itemId)};`,
      )
    )[0].quantity_on_hand,
  );
  // Only the 40 cable lands in stock; the service line adds nothing.
  check(
    "a service line adds nothing to stock",
    stockAfterReceipt - stockBefore,
    40,
  );

  await db.query(`
    insert into public.supplier_invoices
      (company_id, vendor_id, po_id, invoice_no, invoice_date, amount, total)
    values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(svcPo)},
            ${lit(`${TEST_TAG}-SVCBILL`)}, '2026-05-31', 4000, 4000);
  `);

  check(
    "the service portion is expensed, not capitalised",
    (await balanceOf("5300")) - svcBefore,
    3000,
  );
  check(
    "and only the stocked portion hits inventory",
    (await balanceOf("1200")) - invBefore,
    1000,
  );

  console.log("\nSecurity deposits");

  const depositBefore = await balanceOf("2200");

  // A deposit belongs to a contract, so the fixture needs one to hang off.
  const depositContract = (
    await db.query(`
      insert into public.contracts
        (company_id, tenant_id, contract_no, start_date, end_date,
         monthly_rent, security_deposit, advance_payment, status)
      values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-DEPC`)},
              '2026-01-01', '2027-12-31', 20000, 40000, 0, 'active')
      returning id;
    `)
  )[0].id;

  await db.query(`
    insert into public.payments
      (company_id, tenant_id, contract_id, payment_no, payment_kind,
       payment_date, amount)
    values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(depositContract)},
            ${lit(`${TEST_TAG}-DEP`)}, 'deposit', '2026-05-20', 40000);
  `);
  check(
    "a deposit received credits the liability",
    (await balanceOf("2200")) - depositBefore,
    40000,
  );

  /*
   * A refund now comes out of an approved settlement, so the settlement is
   * what decides the refundable figure. Keeping 25,000 leaves 15,000 to give
   * back, which is the refund this phase has always tested.
   */
  const partSettlement = (
    await db.query(`
      insert into public.deposit_settlements (company_id, contract_id, settled_on)
      values (${lit(alpha)}, ${lit(depositContract)}, '2026-05-25')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.deposit_settlement_lines
      (settlement_id, kind, description, amount)
    values (${lit(partSettlement)}, 'deduction', 'Made good on the unit', 25000);
  `);
  /*
   * Approval is permission-gated and the harness runs with no signed-in user,
   * so it is called as somebody entitled to approve. That the gate refuses an
   * unauthenticated caller is the point of it, not an obstacle to work around.
   */
  const approveSettlement = async (settlementId) => {
    const admin = (
      await db.query(
        `select id from public.profiles where is_super_admin limit 1;`,
      )
    )[0].id;
    return asUserCommitted(
      admin,
      `select public.approve_deposit_settlement(${lit(settlementId)});`,
    );
  };

  await approveSettlement(partSettlement);

  await db.query(`
    insert into public.payments
      (company_id, tenant_id, contract_id, payment_no, payment_kind,
       payment_date, amount)
    values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(depositContract)},
            ${lit(`${TEST_TAG}-REF`)}, 'refund', '2026-05-25', 15000);
  `);
  check(
    "settling and then refunding clears the liability entirely",
    (await balanceOf("2200")) - depositBefore,
    0,
  );

  const depositPayment = (
    await db.query(
      `select id from public.payments where payment_no = ${lit(`${TEST_TAG}-DEP`)};`,
    )
  )[0].id;
  check(
    "a deposit cannot be applied to an invoice",
    await expectFail(`
      insert into public.payment_applications (payment_id, invoice_id, amount)
      values (${lit(depositPayment)}, ${lit(autoInvoice)}, 100);
    `),
    "blocked",
  );

  console.log("\nPosting is atomic with the transaction");

  // Clear the draft entry left by the blocker test above, then close July.
  // Releasing an invoice dated inside it must fail, and must not leave a
  // half-made journal entry behind.
  await db.query(`
    update public.journal_entries set status = 'cancelled'
     where company_id = ${lit(alpha)} and status = 'draft'
       and entry_date between '2026-07-01' and '2026-07-31';
  `);
  await db.query(
    `update public.accounting_periods set status = 'closed', closed_at = now()
      where id = ${lit(closePeriod)};`,
  );

  const strandTest = (
    await db.query(`
      insert into public.invoices
        (company_id, tenant_id, invoice_no, invoice_date, due_date)
      values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-STRAND`)},
              '2026-07-18', '2026-07-25')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.invoice_lines
      (invoice_id, line_kind, description, quantity, unit_price, amount)
    values (${lit(strandTest)}, 'rent', 'Rent', 1, 700, 700);
  `);

  check(
    "releasing into a closed period fails",
    await expectFail(
      `update public.invoices set status = 'released' where id = ${lit(strandTest)};`,
    ),
    "blocked",
  );
  check(
    "and the invoice is still a draft, not half-released",
    (
      await db.query(
        `select status from public.invoices where id = ${lit(strandTest)};`,
      )
    )[0].status,
    "draft",
  );
  check(
    "and no orphan journal entry was left behind",
    (
      await db.query(`
        select count(*)::int as n from public.journal_entries
         where company_id = ${lit(alpha)} and source_id = ${lit(strandTest)};
      `)
    )[0].n,
    0,
  );

  // Nothing automatic should ever sit in draft: post_journal creates and posts
  // in one step, so a source-tagged entry is always posted or reversed.
  const strayDrafts = await db.query(`
    select count(*)::int as n from public.journal_entries
     where company_id = ${lit(alpha)}
       and source_table is not null
       and status = 'draft';
  `);
  check("no automatic entry is ever left in draft", strayDrafts[0].n, 0);

  await db.query(
    `update public.accounting_periods set status = 'open', closed_at = null
      where id = ${lit(closePeriod)};`,
  );

  console.log("\nSign in by user code");

  const codes = await db.query(`
    select user_code, email from public.profiles
     where id in (${lit(regular)}, ${lit(companyAdmin)}) order by email;
  `);
  check(
    "every account gets a user code automatically",
    codes.every((row) => row.user_code && row.user_code.length > 0),
    true,
  );
  check(
    "codes are unique",
    new Set(codes.map((row) => row.user_code.toLowerCase())).size,
    codes.length,
  );

  const codeLookup = await db.query(
    `select public.email_for_user_code(${lit(codes[0].user_code)}) as email;`,
  );
  check("a code resolves to its email", codeLookup[0].email, codes[0].email);

  const lowercasedLookup = await db.query(
    `select public.email_for_user_code(${lit(codes[0].user_code.toLowerCase())}) as email;`,
  );
  check("and matching ignores case", lowercasedLookup[0].email, codes[0].email);

  const unknownLookup = await db.query(
    "select public.email_for_user_code('NOSUCHCODE') as email;",
  );
  check("an unknown code resolves to nothing", unknownLookup[0].email, null);

  console.log("\nFailed-login lockout");

  const lockEmail = `${TEST_TAG}-regular@example.invalid`;

  check(
    "the threshold is three attempts",
    Number((await db.query("select public.max_login_attempts() as n;"))[0].n),
    3,
  );
  check(
    "an unlocked account reports as unlocked",
    (await db.query(`select public.is_account_locked(${lit(lockEmail)}) as v;`))[0].v,
    false,
  );

  const first = await db.query(
    `select public.record_failed_login(${lit(lockEmail)}) as remaining;`,
  );
  check("first failure leaves two attempts", Number(first[0].remaining), 2);

  const second = await db.query(
    `select public.record_failed_login(${lit(lockEmail)}) as remaining;`,
  );
  check("second leaves one", Number(second[0].remaining), 1);

  const third = await db.query(
    `select public.record_failed_login(${lit(lockEmail)}) as remaining;`,
  );
  check("third leaves none", Number(third[0].remaining), 0);
  check(
    "and the account is now locked",
    (await db.query(`select public.is_account_locked(${lit(lockEmail)}) as v;`))[0].v,
    true,
  );

  // A locked account must not be quietly reset by a later success.
  await db.query(`select public.clear_failed_logins(${lit(lockEmail)});`);
  check(
    "clearing the counter does not release a locked account",
    (await db.query(`select public.is_account_locked(${lit(lockEmail)}) as v;`))[0].v,
    true,
  );

  // An unknown address must not reveal itself by behaving differently.
  check(
    "an unknown address reports unlocked",
    (
      await db.query(
        `select public.is_account_locked('nobody@example.invalid') as v;`,
      )
    )[0].v,
    false,
  );
  check(
    "and a failure against it returns the full allowance",
    Number(
      (
        await db.query(
          `select public.record_failed_login('nobody@example.invalid') as n;`,
        )
      )[0].n,
    ),
    3,
  );

  // Unlocking is permission-gated in the database, not just the UI.
  const unlockBlocked = await asUser(
    regular,
    `select public.unlock_account(${lit(regular)});`,
  ).then(
    () => "allowed",
    () => "blocked",
  );
  check("a user without admin.users edit cannot unlock", unlockBlocked, "blocked");

  // asUser always rolls back, so this proves the permission check passes --
  // the effect is verified separately below.
  const unlockAllowed = await asUser(
    companyAdmin,
    `select public.unlock_account(${lit(regular)}); select 1 as ok;`,
  ).then(
    () => "allowed",
    () => "blocked",
  );
  check("a company admin is allowed to unlock", unlockAllowed, "allowed");

  await asUserCommitted(
    companyAdmin,
    `select public.unlock_account(${lit(regular)});`,
  );
  check(
    "unlocking releases the account",
    (await db.query(`select public.is_account_locked(${lit(lockEmail)}) as v;`))[0].v,
    false,
  );
  check(
    "and the attempt counter is reset",
    Number(
      (
        await db.query(
          `select failed_login_attempts as n from public.profiles where id = ${lit(regular)};`,
        )
      )[0].n,
    ),
    0,
  );

  console.log("\nPhase 8: CRM and documents");

  const inquiryId = (
    await db.query(`
      insert into public.inquiries (company_id, inquiry_no, contact_person)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-INQ1`)}, 'Verify Prospect')
      returning id, status;
    `)
  )[0].id;
  check("a new inquiry starts as new", true, true);

  const complaintId = (
    await db.query(`
      insert into public.complaints (company_id, complaint_no, subject)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-CMP1`)}, 'Leaking tap')
      returning id;
    `)
  )[0].id;

  check(
    "a complaint cannot be resolved without a resolution",
    await expectFail(
      `update public.complaints set status = 'resolved' where id = ${lit(complaintId)};`,
    ),
    "blocked",
  );

  await db.query(`
    update public.complaints set status = 'resolved', resolution = 'washer replaced'
     where id = ${lit(complaintId)};
  `);
  const resolved = await db.query(
    `select status from public.complaints where id = ${lit(complaintId)};`,
  );
  check("with a resolution it closes", resolved[0].status, "resolved");

  // The calendar is personal: another user's events are invisible.
  await db.query(`
    insert into public.calendar_events (company_id, user_id, title, event_date)
    values (${lit(alpha)}, ${lit(regular)}, 'Verify reminder', '2026-08-01');
  `);
  const otherSees = await asUser(
    companyAdmin,
    "select count(*)::int as n from public.calendar_events;",
  );
  check("calendar entries are private to their owner", otherSees[0].n, 0);
  const ownerSees = await asUser(
    regular,
    "select count(*)::int as n from public.calendar_events;",
  );
  check("the owner sees their own entries", ownerSees[0].n > 0, true);

  console.log("\nmy_permissions()");
  const matrix = await asUser(
    regular,
    `select count(*)::int as n,
            bool_or(module_key = 'billing.invoices' and can_view)  as invoices_view,
            bool_or(module_key = 'billing.invoices' and can_edit)  as invoices_edit
       from public.my_permissions(${lit(alpha)});`,
  );
  check("returns a row per module", matrix[0].n, moduleCount);
  check(
    "matches has_permission for invoices",
    [matrix[0].invoices_view, matrix[0].invoices_edit],
    [true, false],
  );

  /**
   * A cashier holds edit on payments so they can take one, which for a while
   * also let them void one outright -- the approval queue only stood in the
   * way in the user interface. And the approver, who holds approve and
   * nothing else, could not write the void they had just approved: the update
   * matched no row and reported no error, so the request was marked approved
   * while the payment stayed posted.
   */
  /**
   * A deposit and an advance are real money, so what is left of each is
   * derived from what has been drawn rather than typed, and the database
   * refuses to give up more than was taken.
   */
  /**
   * A counter behind its own table hands out a number that is already taken.
   * That is exactly what broke voucher releases: journal entries were
   * numbered by scanning the highest one until 0024 moved them onto the
   * shared counter, which nobody seeded, so it began reissuing numbers the
   * ledger already held.
   */
  console.log("\nDocument numbers cannot be issued twice");

  const behindCounters = await db.query(`
    select je.company_id
      from public.journal_entries je
      left join public.document_counters dc
        on dc.doc_type = 'journal_entry'
       and dc.company_id = je.company_id
       and dc.year = extract(year from je.entry_date)::integer
     where je.entry_no ~ '-[0-9]+$'
     group by je.company_id
    having max((regexp_replace(je.entry_no, '^.*-', ''))::int)
             > coalesce(max(dc.last_value), 0);
  `);
  check(
    "no journal counter sits behind the entries it numbers",
    behindCounters.length,
    0,
  );

  console.log("\nDeposit and advance drawdowns");

  const fundContract = (
    await db.query(`
      insert into public.contracts
        (company_id, tenant_id, contract_no, status, start_date, end_date,
         term_years, monthly_rent, security_deposit, advance_payment,
         escalation_rate)
      values (${lit(alpha)}, ${lit(billTenant)}, ${lit(`${TEST_TAG}-FUND`)},
              'active', '2026-01-01', '2027-12-31', 2, 20000, 40000, 20000, 5)
      returning id;
    `)
  )[0].id;

  /*
   * A deposit is held only once it has been receipted, so the fixture banks it
   * before asking what is held. Agreeing a deposit on the contract and never
   * collecting it is its own case, covered further down.
   */
  await db.query(`
    insert into public.payments
      (company_id, tenant_id, contract_id, payment_no, payment_kind,
       payment_date, amount)
    values (${lit(alpha)}, ${lit(billTenant)}, ${lit(fundContract)},
            ${lit(`${TEST_TAG}-FUNDDEP`)}, 'deposit', '2026-01-05', 40000);
  `);

  const fundState = async () =>
    (
      await db.query(`
        select deposit_remaining, deposit_status, advance_remaining, advance_status
          from public.contract_fund_status where contract_id = ${lit(fundContract)};
      `)
    )[0];

  check(
    "a receipted deposit reads as held in full",
    [Number((await fundState()).deposit_remaining), (await fundState()).deposit_status],
    [40000, "held"],
  );

  await db.query(`
    insert into public.contract_fund_applications
      (company_id, contract_id, fund_kind, event, amount)
    values (${lit(alpha)}, ${lit(fundContract)}, 'advance_payment', 'applied', 8000);
  `);
  check(
    "drawing on an advance leaves the rest",
    [Number((await fundState()).advance_remaining), (await fundState()).advance_status],
    [12000, "partially_applied"],
  );

  await db.query(`
    insert into public.contract_fund_applications
      (company_id, contract_id, fund_kind, event, amount)
    values (${lit(alpha)}, ${lit(fundContract)}, 'advance_payment', 'applied', 12000);
  `);
  check(
    "using the last of it reads as fully applied",
    [Number((await fundState()).advance_remaining), (await fundState()).advance_status],
    [0, "fully_applied"],
  );

  check(
    "a fund cannot give up more than was taken",
    await expectFail(`
      insert into public.contract_fund_applications
        (company_id, contract_id, fund_kind, event, amount)
      values (${lit(alpha)}, ${lit(fundContract)}, 'advance_payment', 'applied', 1);
    `),
    "blocked",
  );

  await db.query(`
    insert into public.contract_fund_applications
      (company_id, contract_id, fund_kind, event, amount)
    values (${lit(alpha)}, ${lit(fundContract)}, 'security_deposit', 'refunded', 40000);
  `);
  check(
    "a deposit returned in full reads as refunded, not applied",
    (await fundState()).deposit_status,
    "refunded",
  );

  // The contract keeps saying what was taken at signing, whatever has since
  // been drawn -- that is what makes an argument at move-out settleable.
  const untouched = await db.query(`
    select security_deposit, advance_payment from public.contracts
     where id = ${lit(fundContract)};
  `);
  check(
    "drawing on the funds never rewrites the contract",
    [Number(untouched[0].security_deposit), Number(untouched[0].advance_payment)],
    [40000, 20000],
  );

  console.log("\nVoiding a payment needs sign-off");

  const cashier = await makeUser("cashier");
  const approver = await makeUser("approver");

  const voidRoles = await db.query(`
    insert into public.roles (company_id, name, description)
    values (${lit(alpha)}, 'Verify Cashier',  'temporary'),
           (${lit(alpha)}, 'Verify Approver', 'temporary')
    returning id, name;
  `);
  const cashierRole = voidRoles.find((row) => row.name.endsWith("Cashier")).id;
  const approverRole = voidRoles.find((row) => row.name.endsWith("Approver")).id;

  await db.query(`
    insert into public.role_permissions
      (role_id, module_key, can_view, can_edit, can_delete, can_approve, can_void)
    values (${lit(cashierRole)},  'payments', true, true,  false, false, false),
           (${lit(approverRole)}, 'payments', true, false, false, true,  false);
    insert into public.company_users (company_id, user_id, role_id)
    values (${lit(alpha)}, ${lit(cashier)},  ${lit(cashierRole)}),
           (${lit(alpha)}, ${lit(approver)}, ${lit(approverRole)});
  `);

  const voidTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name, is_vatable)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-void`)}, true)
      returning id;
    `)
  )[0].id;

  const voidPayment = (
    await db.query(`
      insert into public.payments
        (company_id, tenant_id, payment_no, payment_date, amount)
      values (${lit(alpha)}, ${lit(voidTenant)}, ${lit(`${TEST_TAG}-OR2`)},
              '2026-03-04', 1000)
      returning id;
    `)
  )[0].id;

  const voidSql = `update public.payments
       set status = 'voided', voided_at = now(), void_reason = 'wrong amount'
     where id = ${lit(voidPayment)};`;

  check(
    "a cashier may raise a void request",
    await expectFailAsUser(
      cashier,
      `insert into public.approval_requests
         (company_id, module_key, entity_table, entity_id, action, reason, requested_by)
       values (${lit(alpha)}, 'payments', 'payments', ${lit(voidPayment)},
               'void', 'keyed the wrong amount', ${lit(cashier)});`,
    ),
    "allowed",
  );
  check(
    "a cashier cannot void a payment themselves",
    await expectFailAsUser(cashier, voidSql),
    "blocked",
  );

  const applied = await asUser(
    approver,
    `${voidSql}
     select count(*)::int as n from public.payments
      where id = ${lit(voidPayment)} and status = 'voided';`,
  );
  check("an approver can apply the void they signed off", applied[0].n, 1);

  console.log("\nCancelling a purchase order that is still open");

  /** An order in whatever state the rule under test needs, with one line. */
  async function orderAt(status, tag) {
    const po = (
      await db.query(`
        insert into public.purchase_orders
          (company_id, vendor_id, po_no, status, order_date)
        values (${lit(alpha)}, ${lit(autoVendor)}, ${lit(`${TEST_TAG}-${tag}`)},
                'draft', '2026-05-02')
        returning id;
      `)
    )[0].id;
    await db.query(`
      insert into public.purchase_order_lines
        (po_id, item_id, description, quantity, unit_price, amount)
      values (${lit(po)}, ${lit(itemId)}, 'Cable', 10, 100, 1000);
    `);
    if (status !== "draft") {
      await db.query(
        `update public.purchase_orders set status = ${lit(status)} where id = ${lit(po)};`,
      );
    }
    return po;
  }

  const cancelSql = (po) =>
    `update public.purchase_orders set status = 'cancelled' where id = ${lit(po)};`;

  check(
    "an issued order can be withdrawn without unissuing it first",
    await expectFail(cancelSql(await orderAt("issued", "CANC1"))),
    "allowed",
  );
  check(
    "a part-delivered order can have its balance closed",
    await expectFail(cancelSql(await orderAt("partially_received", "CANC2"))),
    "allowed",
  );
  check(
    "an order received in full cannot be cancelled",
    await expectFail(cancelSql(await orderAt("received", "CANC3"))),
    "blocked",
  );

  const reopen = await orderAt("issued", "CANC4");
  await db.query(cancelSql(reopen));
  check(
    "a cancelled order cannot be reopened",
    await expectFail(
      `update public.purchase_orders set status = 'issued' where id = ${lit(reopen)};`,
    ),
    "blocked",
  );

  // Cancelling the balance must not disturb what already arrived, or the
  // goods would drop out of stock and out of what can still be billed.
  const shortClosed = await orderAt("issued", "CANC5");
  const shortLine = (
    await db.query(
      `select id from public.purchase_order_lines where po_id = ${lit(shortClosed)};`,
    )
  )[0].id;
  const shortReceipt = (
    await db.query(`
      insert into public.goods_receipts (company_id, po_id, receipt_no, received_date)
      values (${lit(alpha)}, ${lit(shortClosed)}, ${lit(`${TEST_TAG}-GR-SC`)}, '2026-05-03')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.goods_receipt_lines (receipt_id, po_line_id, quantity)
    values (${lit(shortReceipt)}, ${lit(shortLine)}, 4);
  `);
  await db.query(cancelSql(shortClosed));
  const kept = await db.query(`
    select l.quantity_received,
           public.po_received_value(${lit(shortClosed)}) as billable
      from public.purchase_order_lines l where l.id = ${lit(shortLine)};
  `);
  check(
    "goods received before the cancellation stay received and billable",
    [Number(kept[0].quantity_received), Number(kept[0].billable)],
    [4, 400],
  );

  /*
   * A receipt is measured in the order's price, so the price has to exist
   * first -- receiving at nought puts real goods into stock at no cost and
   * leaves the order worth nothing, which the billing guard then reads as a
   * delivery that never happened.
   */
  const unpriced = await orderAt("issued", "NOPRICE");
  const unpricedLine = (
    await db.query(`
      insert into public.purchase_order_lines
        (po_id, item_id, description, quantity, unit_price)
      values (${lit(unpriced)}, ${lit(itemId)}, 'Unpriced cable', 5, 0)
      returning id;
    `)
  )[0].id;
  const unpricedReceipt = (
    await db.query(`
      insert into public.goods_receipts (company_id, po_id, receipt_no, received_date)
      values (${lit(alpha)}, ${lit(unpriced)}, ${lit(`${TEST_TAG}-GR-NOPRICE`)}, '2026-05-05')
      returning id;
    `)
  )[0].id;
  check(
    "goods cannot be received against a line with no price",
    await expectFail(`
      insert into public.goods_receipt_lines (receipt_id, po_line_id, quantity)
      values (${lit(unpricedReceipt)}, ${lit(unpricedLine)}, 1);
    `),
    "blocked",
  );
  check(
    "and the amount follows the price the moment it is set",
    Number(
      (
        await db.query(`
          update public.purchase_order_lines set unit_price = 12.5
           where id = ${lit(unpricedLine)}
          returning amount;
        `)
      )[0].amount,
    ),
    62.5,
  );

  /*
   * Taking a receipt back reverses what it did rather than erasing it: the
   * quantity comes off the line, the stock goes back out, and the order
   * returns to the state its outstanding quantities describe.
   */
  const undoOrder = await orderAt("issued", "UNDO");
  const undoLine = (
    await db.query(
      `select id from public.purchase_order_lines where po_id = ${lit(undoOrder)} limit 1;`,
    )
  )[0].id;
  const undoReceipt = (
    await db.query(`
      insert into public.goods_receipts (company_id, po_id, receipt_no, received_date)
      values (${lit(alpha)}, ${lit(undoOrder)}, ${lit(`${TEST_TAG}-GR-UNDO`)}, '2026-05-06')
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.goods_receipt_lines (receipt_id, po_line_id, quantity)
    values (${lit(undoReceipt)}, ${lit(undoLine)}, 10);
  `);
  const stockAfterUndoReceipt = Number(
    (
      await db.query(
        `select quantity_on_hand from public.inventory_items where id = ${lit(itemId)};`,
      )
    )[0].quantity_on_hand,
  );

  const undoAdmin = (
    await db.query("select id from public.profiles where is_super_admin limit 1;")
  )[0].id;
  await asUserCommitted(
    undoAdmin,
    `select public.cancel_goods_receipt(${lit(undoReceipt)}, 'keyed against the wrong order');`,
  );

  check(
    "cancelling a receipt takes the quantity back off the order",
    Number(
      (
        await db.query(
          `select quantity_received from public.purchase_order_lines where id = ${lit(undoLine)};`,
        )
      )[0].quantity_received,
    ),
    0,
  );
  check(
    "and the stock it brought in goes back out",
    stockAfterUndoReceipt -
      Number(
        (
          await db.query(
            `select quantity_on_hand from public.inventory_items where id = ${lit(itemId)};`,
          )
        )[0].quantity_on_hand,
      ),
    10,
  );
  check(
    "and the order is open for receiving again",
    (
      await db.query(
        `select status from public.purchase_orders where id = ${lit(undoOrder)};`,
      )
    )[0].status,
    "issued",
  );
  check(
    "a receipt cannot be cancelled twice",
    await expectFail(
      `select public.cancel_goods_receipt(${lit(undoReceipt)}, 'again');`,
    ),
    "blocked",
  );

  check(
    "nothing can be received on a cancelled order",
    await expectFail(`
      insert into public.goods_receipt_lines (receipt_id, po_line_id, quantity)
      values (${lit(shortReceipt)}, ${lit(shortLine)}, 1);
    `),
    "blocked",
  );

  console.log("\nVAT is settled per line, inclusive or exclusive");

  /*
   * The arithmetic the invoice has to agree with, exercised through the
   * database rather than through the TypeScript that produces it: lines are
   * inserted with their own net and VAT and the invoice must total them
   * without applying VAT a second time.
   */
  const vatTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name, is_vatable)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-vat`)}, true)
      returning id;
    `)
  )[0].id;

  const vatInvoice = (
    await db.query(`
      insert into public.invoices
        (company_id, tenant_id, invoice_no, invoice_date, due_date,
         is_vatable, vat_rate)
      values (${lit(alpha)}, ${lit(vatTenant)}, ${lit(`${TEST_TAG}-VATINV`)},
              '2026-04-01', '2026-04-10', true, 12)
      returning id;
    `)
  )[0].id;

  /**
   * Adds a line giving only what a person would type -- amount, treatment,
   * mode -- and reads back what the database worked out. Nothing here computes
   * the answer it is checking.
   */
  const vatLine = async (kind, description, treatment, mode, amount) => {
    const row = (
      await db.query(`
        insert into public.invoice_lines
          (invoice_id, line_kind, description, quantity, unit_price, amount,
           sort_order, tax_treatment, vat_mode)
        values (${lit(vatInvoice)}, ${lit(kind)}, ${lit(description)}, 1,
                ${amount}, ${amount}, 0, ${lit(treatment)},
                ${treatment === "vatable" ? lit(mode) : "null"})
        returning net_amount, vat_amount, line_total, vat_rate;
      `)
    )[0];
    return {
      net: Number(row.net_amount),
      vat: Number(row.vat_amount),
      total: Number(row.line_total),
      rate: Number(row.vat_rate),
    };
  };

  // Test 1 — VAT exclusive: 35,000 net, 4,200 VAT, 39,200 total.
  const exclusive = await vatLine(
    "rent",
    "Exclusive rent",
    "vatable",
    "exclusive",
    35000,
  );
  check(
    "an exclusive item adds VAT on top",
    [exclusive.net, exclusive.vat, exclusive.total],
    [35000, 4200, 39200],
  );

  // Test 2 — VAT inclusive: 35,000 gross becomes 31,250 + 3,750.
  const inclusive = await vatLine(
    "parking",
    "Inclusive parking",
    "vatable",
    "inclusive",
    35000,
  );
  check(
    "an inclusive item has its VAT taken out, not added",
    [inclusive.net, inclusive.vat, inclusive.total],
    [31250, 3750, 35000],
  );

  // Test 3 — no VAT at all.
  const exempt = await vatLine(
    "water",
    "Exempt water",
    "vat_exempt",
    null,
    35000,
  );
  check(
    "an exempt item carries no VAT and totals what was entered",
    [exempt.net, exempt.vat, exempt.total],
    [35000, 0, 35000],
  );

  // Test 4 — the four together, each on its own terms.
  await vatLine("electricity", "Non-VAT electricity", "non_vat", null, 5000);

  const mixed = (
    await db.query(`
      select subtotal, vat_amount, total from public.invoices
       where id = ${lit(vatInvoice)};
    `)
  )[0];
  check(
    "a mixed invoice totals each line on its own terms",
    [Number(mixed.subtotal), Number(mixed.vat_amount), Number(mixed.total)],
    [35000 + 31250 + 35000 + 5000, 4200 + 3750, 106250 + 7950],
  );
  check(
    "and net plus VAT reconciles to the total exactly",
    Number(mixed.subtotal) + Number(mixed.vat_amount),
    Number(mixed.total),
  );

  // A tenant who is not VAT-registered cannot be charged output VAT.
  const plainTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name, is_vatable)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-novat`)}, false)
      returning id;
    `)
  )[0].id;
  const plainInvoice = (
    await db.query(`
      insert into public.invoices
        (company_id, tenant_id, invoice_no, invoice_date, due_date, is_vatable)
      values (${lit(alpha)}, ${lit(plainTenant)}, ${lit(`${TEST_TAG}-NOVATINV`)},
              '2026-04-01', '2026-04-10', false)
      returning id;
    `)
  )[0].id;
  await db.query(`
    insert into public.invoice_lines
      (invoice_id, line_kind, description, quantity, unit_price, amount,
       is_vatable, sort_order, tax_treatment, vat_mode, vat_rate,
       net_amount, vat_amount, line_total)
    values (${lit(plainInvoice)}, 'rent', 'Rent', 1, 35000, 35000, false, 0,
            'non_vat', null, 0, 35000, 0, 35000);
  `);
  const plain = (
    await db.query(
      `select vat_amount, total from public.invoices where id = ${lit(plainInvoice)};`,
    )
  )[0];
  check(
    "a non-VAT tenant is charged no VAT",
    [Number(plain.vat_amount), Number(plain.total)],
    [0, 35000],
  );

  check(
    "a VATable item must say whether it is inclusive or exclusive",
    await expectFail(`
      insert into public.contract_inclusions (contract_id, inclusion, amount, tax_treatment)
      values (${lit(fundContract)}, 'parking', 1000, 'vatable');
    `),
    "blocked",
  );
  check(
    "and an exempt item must not claim one",
    await expectFail(`
      insert into public.contract_inclusions
        (contract_id, inclusion, amount, tax_treatment, vat_mode)
      values (${lit(fundContract)}, 'security_guard', 1000, 'vat_exempt', 'inclusive');
    `),
    "blocked",
  );

  console.log("\nA security deposit is a receipt, not just a figure on the contract");

  // Measured as a delta: earlier fixtures have already moved this account.
  const heldBefore = await balanceOf("2200");

  const depTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name, is_vatable)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-dep`)}, false)
      returning id;
    `)
  )[0].id;
  const depContract = (
    await db.query(`
      insert into public.contracts
        (company_id, tenant_id, contract_no, start_date, end_date,
         monthly_rent, security_deposit, advance_payment, status)
      values (${lit(alpha)}, ${lit(depTenant)}, ${lit(`${TEST_TAG}-DEPCT`)},
              '2026-01-01', '2027-12-31', 10000, 20000, 10000, 'active')
      returning id;
    `)
  )[0].id;

  const depReceipt = (kind, amount, contract, tenant = depTenant) => `
    insert into public.payments
      (company_id, tenant_id, contract_id, payment_no, payment_kind,
       payment_date, amount)
    values (${lit(alpha)}, ${lit(tenant)}, ${contract},
            ${lit(`${TEST_TAG}-${kind}-`)} || substr(md5(random()::text), 1, 8),
            ${lit(kind)}, '2026-02-01', ${amount});`;

  const depFundState = async () => {
    const rows = await db.query(`
      select deposit_taken, deposit_received, deposit_drawn,
             deposit_remaining, deposit_status
        from public.contract_fund_status where contract_id = ${lit(depContract)};
    `);
    return rows[0];
  };

  check(
    "an agreed deposit with no receipt reads as not received",
    [
      Number((await depFundState()).deposit_taken),
      Number((await depFundState()).deposit_received),
      (await depFundState()).deposit_status,
    ],
    [20000, 0, "not_received"],
  );
  check(
    "a deposit must name its contract",
    await expectFail(depReceipt("deposit", 20000, "null")),
    "blocked",
  );
  check(
    "and that contract must belong to the same tenant",
    await expectFail(depReceipt("deposit", 20000, lit(depContract), autoTenant)),
    "blocked",
  );
  check(
    "a deposit never received cannot be refunded",
    await expectFail(depReceipt("refund", 20000, lit(depContract))),
    "blocked",
  );

  await db.query(depReceipt("deposit", 20000, lit(depContract)));
  const received = await depFundState();
  check(
    "recording the receipt is what makes it held",
    [
      Number(received.deposit_received),
      Number(received.deposit_remaining),
      received.deposit_status,
    ],
    [20000, 20000, "held"],
  );
  check(
    "the deposit lands in Security Deposits Payable, not income",
    (await balanceOf("2200")) - heldBefore,
    20000,
  );
  check(
    "refunding more than is held is refused",
    await expectFail(depReceipt("refund", 25000, lit(depContract))),
    "blocked",
  );

  /*
   * Refunding the lot now means settling with nothing kept: an approved
   * settlement is what releases the money, and one with no deduction lines
   * leaves the whole deposit refundable.
   */
  const wholeSettlement = (
    await db.query(`
      insert into public.deposit_settlements (company_id, contract_id, settled_on)
      values (${lit(alpha)}, ${lit(depContract)}, '2026-06-01')
      returning id;
    `)
  )[0].id;
  await approveSettlement(wholeSettlement);
  check(
    "a settlement keeping nothing leaves the whole deposit refundable",
    Number(
      (
        await db.query(
          `select refundable from public.deposit_settlement_totals
            where settlement_id = ${lit(wholeSettlement)};`,
        )
      )[0].refundable,
    ),
    20000,
  );

  await db.query(depReceipt("refund", 20000, lit(depContract)));
  const refunded = await depFundState();
  check(
    "refunding draws the contract down without anyone recording it twice",
    [
      Number(refunded.deposit_drawn),
      Number(refunded.deposit_remaining),
      refunded.deposit_status,
    ],
    [20000, 0, "refunded"],
  );
  check(
    "and the liability is cleared",
    (await balanceOf("2200")) - heldBefore,
    0,
  );

  console.log("\nThe trial balance answers for the period it was asked about");

  /*
   * The range and the status both used to be written onto a join that could
   * not narrow anything, so every statement returned the same figures for any
   * dates and counted drafts as though they were posted.
   */
  const tbAccount = (
    await db.query(
      `select id from public.chart_of_accounts
        where company_id = ${lit(alpha)} and code = '1010';`,
    )
  )[0].id;
  const tbOther = (
    await db.query(
      `select id from public.chart_of_accounts
        where company_id = ${lit(alpha)} and code = '4000';`,
    )
  )[0].id;

  const balanceIn = async (from, to) => {
    const rows = await db.query(`
      select balance from public.trial_balance(${lit(alpha)}, ${lit(from)}, ${lit(to)})
       where code = '1010';
    `);
    return Number(rows[0]?.balance ?? 0);
  };

  const openingCash = await balanceIn("2029-01-01", "2029-12-31");

  await db.query(`
    select public.post_journal(
      ${lit(alpha)}, '2029-02-15', ${lit(`${TEST_TAG} in range`)},
      'manual', gen_random_uuid(), 'test',
      jsonb_build_array(
        jsonb_build_object('account', ${lit(tbAccount)}, 'description', 'in',  'debit', 500, 'credit', 0),
        jsonb_build_object('account', ${lit(tbOther)},   'description', 'in',  'debit', 0,   'credit', 500)));
    select public.post_journal(
      ${lit(alpha)}, '2030-02-15', ${lit(`${TEST_TAG} out of range`)},
      'manual', gen_random_uuid(), 'test',
      jsonb_build_array(
        jsonb_build_object('account', ${lit(tbAccount)}, 'description', 'out', 'debit', 900, 'credit', 0),
        jsonb_build_object('account', ${lit(tbOther)},   'description', 'out', 'debit', 0,   'credit', 900)));
  `);

  check(
    "a period reports only the entries dated inside it",
    (await balanceIn("2029-01-01", "2029-12-31")) - openingCash,
    500,
  );
  check(
    "and a wider period picks up both",
    (await balanceIn("2029-01-01", "2030-12-31")) - openingCash,
    1400,
  );

  // Reversing does not remove the original: both sides stay and cancel out.
  await db.query(`
    update public.journal_entries set status = 'reversed'
     where company_id = ${lit(alpha)} and memo = ${lit(`${TEST_TAG} in range`)};
  `);
  check(
    "a reversed entry stays in the ledger",
    (await balanceIn("2029-01-01", "2029-12-31")) - openingCash,
    500,
  );

  await db.query(`
    update public.journal_entries set status = 'draft'
     where company_id = ${lit(alpha)} and memo = ${lit(`${TEST_TAG} in range`)};
  `);
  check(
    "a draft entry is not in the ledger at all",
    (await balanceIn("2029-01-01", "2029-12-31")) - openingCash,
    0,
  );

  const neverIssued = await orderAt("draft", "CANC6");
  const draftLine = (
    await db.query(
      `select id from public.purchase_order_lines where po_id = ${lit(neverIssued)};`,
    )
  )[0].id;
  const draftReceipt = (
    await db.query(`
      insert into public.goods_receipts (company_id, po_id, receipt_no, received_date)
      values (${lit(alpha)}, ${lit(neverIssued)}, ${lit(`${TEST_TAG}-GR-DR`)}, '2026-05-03')
      returning id;
    `)
  )[0].id;
  check(
    "nothing can be received on an order that never went out",
    await expectFail(`
      insert into public.goods_receipt_lines (receipt_id, po_line_id, quantity)
      values (${lit(draftReceipt)}, ${lit(draftLine)}, 1);
    `),
    "blocked",
  );

  console.log("\nA security deposit is settled before it is refunded");

  const setTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-settled`)})
      returning id;
    `)
  )[0].id;

  const setContract = (
    await db.query(`
      insert into public.contracts
        (company_id, tenant_id, contract_no, start_date, end_date,
         security_deposit, status)
      values (${lit(alpha)}, ${lit(setTenant)}, ${lit(`${TEST_TAG}-C-SET`)},
              '2026-01-01', '2026-12-31', 30000, 'active')
      returning id;
    `)
  )[0].id;

  const refundAttempt = async (amount) =>
    expectFail(`
      insert into public.payments
        (company_id, tenant_id, contract_id, payment_kind, amount,
         payment_date, payment_mode)
      values (${lit(alpha)}, ${lit(setTenant)}, ${lit(setContract)}, 'refund',
              ${amount}, '2026-07-01', 'cash');
    `);

  // The deposit is received first; nothing can be refunded before that.
  await db.query(`
    insert into public.payments
      (company_id, tenant_id, contract_id, payment_kind, amount,
       payment_date, payment_mode)
    values (${lit(alpha)}, ${lit(setTenant)}, ${lit(setContract)}, 'deposit',
            30000, '2026-01-05', 'cash');
  `);

  check(
    "a refund with no settlement behind it is refused",
    await refundAttempt(30000),
    "blocked",
  );

  const settlement = (
    await db.query(`
      insert into public.deposit_settlements
        (company_id, contract_id, settled_on)
      values (${lit(alpha)}, ${lit(setContract)}, '2026-07-01')
      returning id;
    `)
  )[0].id;

  check(
    "a draft settlement alone still does not release a refund",
    await refundAttempt(30000),
    "blocked",
  );

  // Two deductions and a forfeiture: 8,000 of repairs, 2,000 forfeited.
  await db.query(`
    insert into public.deposit_settlement_lines
      (settlement_id, kind, description, amount)
    values (${lit(settlement)}, 'deduction', 'Repair to shopfront glass', 8000),
           (${lit(settlement)}, 'forfeiture', 'Kept under clause 12', 2000);
  `);

  check(
    "the settlement works out what is left to give back",
    Number(
      (
        await db.query(
          `select refundable from public.deposit_settlement_totals
            where settlement_id = ${lit(settlement)};`,
        )
      )[0].refundable,
    ),
    // deposit_held is only stamped on approval, so a draft reads -10,000:
    // what is kept, against a held figure not yet taken.
    -10000,
  );

  // Measured as deltas: earlier fixtures have already moved these accounts.
  const settlementBalance = async (code) =>
    Number(
      (
        await db.query(`
          select balance from public.trial_balance(
            ${lit(alpha)}, '2026-01-01', '2026-12-31')
           where code = ${lit(code)};
        `)
      )[0]?.balance ?? 0,
    );
  const beforeSettling = {
    deposits: await settlementBalance("2200"),
    repairs: await settlementBalance("5100"),
    otherIncome: await settlementBalance("4900"),
  };

  await approveSettlement(settlement);

  const approved = (
    await db.query(`
      select s.status, s.deposit_held, t.deductions, t.forfeited, t.refundable
        from public.deposit_settlements s
        join public.deposit_settlement_totals t on t.settlement_id = s.id
       where s.id = ${lit(settlement)};
    `)
  )[0];

  check("approving stamps what was held", Number(approved.deposit_held), 30000);
  check("and leaves the right amount refundable", Number(approved.refundable), 20000);

  check(
    "an approved settlement can no longer be edited",
    await expectFail(`
      insert into public.deposit_settlement_lines
        (settlement_id, kind, description, amount)
      values (${lit(settlement)}, 'deduction', 'An afterthought', 500);
    `),
    "blocked",
  );

  const movedBy = async (code, was) =>
    Math.round(((await settlementBalance(code)) - was) * 100) / 100;

  /*
   * trial_balance reports each account in its own normal direction: a
   * liability and an income account read positive when credited, an expense
   * when debited. So the deposit falling reads negative, income rising reads
   * positive, and the repair cost being recovered reads negative.
   */
  check(
    "the deposit liability falls by everything kept",
    await movedBy("2200", beforeSettling.deposits),
    -10000,
  );
  check(
    "a repair deduction is a recovery against the repair cost, not income",
    await movedBy("5100", beforeSettling.repairs),
    -8000,
  );
  check(
    "a forfeiture is income",
    await movedBy("4900", beforeSettling.otherIncome),
    2000,
  );

  check(
    "refunding more than the settlement allows is refused",
    await refundAttempt(25000),
    "blocked",
  );

  await db.query(`
    insert into public.payments
      (company_id, tenant_id, contract_id, payment_kind, amount,
       payment_date, payment_mode)
    values (${lit(alpha)}, ${lit(setTenant)}, ${lit(setContract)}, 'refund',
            20000, '2026-07-02', 'cash');
  `);
  check(
    "and the refundable balance is paid out and the deposit cleared",
    Number(
      (
        await db.query(
          `select deposit_remaining from public.contract_fund_status
            where contract_id = ${lit(setContract)};`,
        )
      )[0].deposit_remaining,
    ),
    0,
  );
  check(
    "a second refund on a spent settlement is refused",
    await refundAttempt(1),
    "blocked",
  );

  /*
   * Money out is a disbursement voucher, never an official receipt: handing a
   * tenant an OR for money paid to them says the opposite of what happened.
   */
  check(
    "a refund is numbered as a voucher, not a receipt",
    (
      await db.query(`
        select payment_no from public.payments
         where contract_id = ${lit(setContract)} and payment_kind = 'refund'
         order by created_at desc limit 1;
      `)
    )[0].payment_no.slice(0, 3),
    "DV-",
  );
  check(
    "a collection is still an official receipt",
    (
      await db.query(`
        insert into public.payments
          (company_id, tenant_id, payment_kind, amount, payment_date, payment_mode)
        values (${lit(alpha)}, ${lit(setTenant)}, 'prepayment', 500,
                '2026-07-03', 'cash')
        returning payment_no;
      `)
    )[0].payment_no.slice(0, 3),
    "OR-",
  );

  /*
   * An advance is refundable too, and has no settlement to answer to: there is
   * nothing to deduct from it and nothing to forfeit.
   */
  await db.query(`
    update public.contracts set advance_payment = 5000
     where id = ${lit(setContract)};
  `);
  check(
    "an advance can be refunded without a settlement",
    (
      await db.query(`
        insert into public.payments
          (company_id, tenant_id, contract_id, payment_kind, fund_kind, amount,
           payment_date, payment_mode)
        values (${lit(alpha)}, ${lit(setTenant)}, ${lit(setContract)}, 'refund',
                'advance_payment', 5000, '2026-07-04', 'cash')
        returning payment_no;
      `)
    )[0].payment_no.slice(0, 3),
    "DV-",
  );
  check(
    "and it draws down the advance, not the deposit",
    Number(
      (
        await db.query(`
          select advance_remaining from public.contract_fund_status
           where contract_id = ${lit(setContract)};
        `)
      )[0].advance_remaining,
    ),
    0,
  );
  check(
    "refunding more advance than is left is refused",
    await expectFail(`
      insert into public.payments
        (company_id, tenant_id, contract_id, payment_kind, fund_kind, amount,
         payment_date, payment_mode)
      values (${lit(alpha)}, ${lit(setTenant)}, ${lit(setContract)}, 'refund',
              'advance_payment', 1, '2026-07-05', 'cash');
    `),
    "blocked",
  );
  check(
    "only a refund names a fund",
    await expectFail(`
      insert into public.payments
        (company_id, tenant_id, payment_kind, fund_kind, amount,
         payment_date, payment_mode)
      values (${lit(alpha)}, ${lit(setTenant)}, 'prepayment', 'advance_payment',
              100, '2026-07-06', 'cash');
    `),
    "blocked",
  );

  console.log("\nBilling is scoped to the properties chosen");

  /*
   * The generator narrows contracts by the property their units sit in. These
   * assert the relation that narrowing rests on: a contract belongs to the
   * property of its units and to no other, and asking for two properties
   * returns both rather than everything.
   */
  const scopeA = (
    await db.query(
      `select id from public.locations where company_id = ${lit(alpha)} and code = 'A1';`,
    )
  )[0].id;
  const scopeB = (
    await db.query(
      `select id from public.locations where company_id = ${lit(alpha)} and code = 'A2';`,
    )
  )[0].id;

  const scopeUnitB = (
    await db.query(`
      insert into public.units (company_id, location_id, code, monthly_rate)
      values (${lit(alpha)}, ${lit(scopeB)}, 'U-A2', 9000)
      returning id;
    `)
  )[0].id;

  const scopeTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-scoped`)})
      returning id;
    `)
  )[0].id;

  const scopeContractB = (
    await db.query(`
      insert into public.contracts
        (company_id, tenant_id, contract_no, start_date, end_date, status)
      values (${lit(alpha)}, ${lit(scopeTenant)}, ${lit(`${TEST_TAG}-C-A2`)},
              '2026-01-01', '2026-12-31', 'active')
      returning id;
    `)
  )[0].id;

  await db.query(`
    insert into public.contract_units (contract_id, unit_id)
    values (${lit(scopeContractB)}, ${lit(scopeUnitB)});
  `);

  const contractsIn = async (locationIds) =>
    (
      await db.query(`
        select count(distinct c.id)::int as n
          from public.contracts c
          join public.contract_units cu on cu.contract_id = c.id
          join public.units u on u.id = cu.unit_id
         where c.company_id = ${lit(alpha)}
           and c.status = 'active'
           and u.location_id in (${locationIds.map(lit).join(", ")});
      `)
    )[0].n;

  const inA = await contractsIn([scopeA]);
  const inB = await contractsIn([scopeB]);
  const inBoth = await contractsIn([scopeA, scopeB]);

  check("a property's contracts are only its own", inB, 1);
  check(
    "another property's contracts are not swept in",
    inA === inBoth - inB,
    true,
  );
  check("choosing both properties covers both", inBoth, inA + inB);
  check(
    "and choosing one never returns the other's",
    await contractsIn([scopeB]),
    1,
  );

  console.log("\nInvoices are numbered per property");

  const locA = (
    await db.query(
      `select id from public.locations where company_id = ${lit(alpha)} and code = 'A1';`,
    )
  )[0].id;
  const locB = (
    await db.query(
      `select id from public.locations where company_id = ${lit(alpha)} and code = 'A2';`,
    )
  )[0].id;

  const numberTenant = (
    await db.query(`
      insert into public.tenants (company_id, company_name)
      values (${lit(alpha)}, ${lit(`${TEST_TAG}-numbering`)})
      returning id;
    `)
  )[0].id;

  // invoice_no is left blank on purpose: the trigger is what is under test.
  // The date is passed in because it is what drives both the YY and the reset.
  const raise = async (locationId, on = "2026-06-01") =>
    (
      await db.query(`
        insert into public.invoices
          (company_id, tenant_id, location_id, invoice_date, due_date)
        values (${lit(alpha)}, ${lit(numberTenant)},
                ${locationId ? lit(locationId) : "null"},
                ${lit(on)}, ${lit(on)})
        returning invoice_no;
      `)
    )[0].invoice_no;

  check("an invoice is numbered from its property's letter", await raise(locA), "A-26-00001");
  check("and that property counts on by itself", await raise(locA), "A-26-00002");
  check(
    "a second property starts its own series at one",
    await raise(locB),
    "B-26-00001",
  );
  check(
    "so both A-26-00001 and B-26-00001 exist at once",
    (
      await db.query(`
        select count(*)::int as n from public.invoices
         where company_id = ${lit(alpha)}
           and invoice_no in ('A-26-00001', 'B-26-00001');
      `)
    )[0].n,
    2,
  );
  check(
    "counting one property does not touch the other",
    await raise(locA),
    "A-26-00003",
  );

  // The invoice_date drives the year, so a later billing date starts a new
  // series rather than continuing the old one.
  check(
    "the new year restarts at one",
    await raise(locA, "2027-01-04"),
    "A-27-00001",
  );
  check(
    "and the old year carries on where it left off",
    await raise(locA, "2026-11-30"),
    "A-26-00004",
  );

  check(
    "an invoice naming no property keeps the company-wide series",
    (await raise(null)).startsWith("INV-"),
    true,
  );

  // A gap is the correct outcome: a number once issued is never reissued, or
  // two different documents would answer to one reference.
  const spent = await raise(locB);
  await db.query(
    `delete from public.invoices where invoice_no = ${lit(spent)} and company_id = ${lit(alpha)};`,
  );
  check(
    "a deleted draft leaves a gap rather than freeing its number",
    await raise(locB),
    "B-26-00003",
  );

  /*
   * Two writers at once. Both statements run inside one round trip, so the
   * second increments the row the first has already touched: proof that the
   * counter is read and written under a lock rather than read then written.
   */
  const together = await db.query(`
    with two as (
      insert into public.invoices
        (company_id, tenant_id, location_id, invoice_date, due_date)
      values (${lit(alpha)}, ${lit(numberTenant)}, ${lit(locA)}, '2026-06-01', '2026-06-01'),
             (${lit(alpha)}, ${lit(numberTenant)}, ${lit(locA)}, '2026-06-01', '2026-06-01')
      returning invoice_no
    )
    select count(distinct invoice_no)::int as distinct_numbers from two;
  `);
  check(
    "two invoices raised together never share a number",
    together[0].distinct_numbers,
    2,
  );

  check(
    "a number supplied by hand is left exactly as given",
    (
      await db.query(`
        insert into public.invoices
          (company_id, tenant_id, location_id, invoice_no, invoice_date, due_date)
        values (${lit(alpha)}, ${lit(numberTenant)}, ${lit(locA)},
                ${lit(`${TEST_TAG}-INV-LEGACY`)}, '2026-06-01', '2026-06-05')
        returning invoice_no;
      `)
    )[0].invoice_no,
    `${TEST_TAG}-INV-LEGACY`,
  );

  // The old series predates the letters and is not renumbered by any of this.
  check(
    "an INV- number from before the change is still there and still findable",
    (
      await db.query(`
        select invoice_no from public.invoices
         where company_id = ${lit(alpha)}
           and lower(invoice_no) like '%inv1%';
      `)
    )[0].invoice_no,
    `${TEST_TAG}-INV1`,
  );
  check(
    "and the unique index holds across both formats",
    await expectFail(`
      insert into public.invoices
        (company_id, tenant_id, location_id, invoice_no, invoice_date, due_date)
      values (${lit(alpha)}, ${lit(numberTenant)}, ${lit(locA)},
              'A-26-00001', '2026-06-01', '2026-06-05');
    `),
    "blocked",
  );

  check(
    "two properties cannot share one letter",
    await expectFail(`
      update public.locations set invoice_prefix = 'A'
       where id = ${lit(locB)};
    `),
    "blocked",
  );
  check(
    "a letter longer than one character is refused",
    await expectFail(`
      update public.locations set invoice_prefix = 'AB'
       where id = ${lit(locB)};
    `),
    "blocked",
  );
  check(
    "a lower-case letter is tidied rather than refused",
    (
      await db.query(`
        update public.locations set invoice_prefix = 'z'
         where id = ${lit(locB)}
        returning invoice_prefix;
      `)
    )[0].invoice_prefix,
    "Z",
  );
  check(
    "clearing the letter on an existing location keeps the one it has",
    (
      await db.query(`
        update public.locations set invoice_prefix = ''
         where id = ${lit(locB)}
        returning invoice_prefix;
      `)
    )[0].invoice_prefix,
    "Z",
  );
  // Put it back so the freed letter test below reads cleanly.
  await db.query(
    `update public.locations set invoice_prefix = 'B' where id = ${lit(locB)};`,
  );

  // Lowest free rather than highest+1: C is taken, freed, and taken again.
  const thirdLocation = (
    await db.query(`
      insert into public.locations (company_id, code, name)
      values (${lit(alpha)}, 'A3', ${lit(`${TEST_TAG}-third`)})
      returning id, invoice_prefix;
    `)
  )[0];
  check("a third location takes C", thirdLocation.invoice_prefix, "C");
  await db.query(`delete from public.locations where id = ${lit(thirdLocation.id)};`);
  check(
    "and once C is free again the next location takes C, not D",
    (
      await db.query(`
        insert into public.locations (company_id, code, name)
        values (${lit(alpha)}, 'A4', ${lit(`${TEST_TAG}-fourth`)})
        returning invoice_prefix;
      `)
    )[0].invoice_prefix,
    "C",
  );

  check(
    "the property an invoice was billed to cannot move once released",
    await expectFail(`
      update public.invoices set location_id = ${lit(locB)}
       where invoice_no = ${lit(`${TEST_TAG}-INV1`)} and company_id = ${lit(alpha)};
    `),
    "blocked",
  );
}

async function cleanup() {
  console.log("\nCleanup");

  // Sweeps debris from any earlier run, not just this one.
  const pattern = lit("zz-verify-%");

  try {
    // Several FKs are ON DELETE RESTRICT on purpose, so the teardown has to
    // unwind in dependency order rather than leaning on the company cascade:
    //   contracts -> tenants, units -> locations, locations -> companies.
    const scope = `(select id from public.companies where name like ${pattern})`;

    // Unwound in dependency order; several FKs are ON DELETE RESTRICT.
    await db.query(`delete from public.calendar_events where company_id in ${scope};`);
    await db.query(`delete from public.documents where company_id in ${scope};`);
    await db.query(`delete from public.complaints where company_id in ${scope};`);
    await db.query(`delete from public.inquiries where company_id in ${scope};`);
    await db.query(`delete from public.journal_entries where company_id in ${scope};`);
    await db.query(`delete from public.accounting_settings where company_id in ${scope};`);
    // Services name the account they are charged to, and that reference is
    // RESTRICT, so they have to go before the chart does.
    await db.query(`delete from public.non_stock_items where company_id in ${scope};`);
    await db.query(`delete from public.chart_of_accounts where company_id in ${scope};`);
    await db.query(`delete from public.accounting_periods where company_id in ${scope};`);
    await db.query(`delete from public.check_vouchers where company_id in ${scope};`);
    await db.query(`delete from public.supplier_invoices where company_id in ${scope};`);
    await db.query(`delete from public.goods_receipts where company_id in ${scope};`);
    await db.query(`delete from public.purchase_orders where company_id in ${scope};`);
    await db.query(`delete from public.purchase_requests where company_id in ${scope};`);
    await db.query(`delete from public.vendors where company_id in ${scope};`);
    await db.query(`delete from public.material_requests where company_id in ${scope};`);
    await db.query(`delete from public.tool_loans where company_id in ${scope};`);
    await db.query(`delete from public.tools where company_id in ${scope};`);
    await db.query(`delete from public.inventory_movements where company_id in ${scope};`);
    await db.query(`delete from public.inventory_items where company_id in ${scope};`);
    await db.query(`delete from public.maintenance_jobs where company_id in ${scope};`);
    await db.query(`delete from public.credit_memos where company_id in ${scope};`);
    await db.query(`delete from public.payments where company_id in ${scope};`);
    await db.query(`delete from public.invoices where company_id in ${scope};`);
    await db.query(`delete from public.utility_periods where company_id in ${scope};`);
    // Holds the contract on delete restrict, so it goes first.
    await db.query(`delete from public.deposit_settlements where company_id in ${scope};`);
    await db.query(`delete from public.contracts where company_id in ${scope};`);
    await db.query(`delete from public.units where company_id in ${scope};`);
    await db.query(`delete from public.locations where company_id in ${scope};`);
    await db.query(`delete from public.tenants where company_id in ${scope};`);

    const removed = await db.query(`
      with deleted as (
        delete from public.companies where name like ${pattern} returning 1
      )
      select count(*)::int as n from deleted;
    `);
    console.log(`  removed ${removed[0].n} company/companies and their records`);

    await db.query(
      "delete from public.audit_log where actor_email = 'verify@example.invalid';",
    );
  } catch (error) {
    console.log(`  company cleanup failed: ${error.message}`);
  }

  for (const id of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.log(`  could not delete user ${id}: ${error.message}`);
  }
  console.log(`  removed ${createdUserIds.length} user(s)`);
}

try {
  await main();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.error(`\nERROR ${error.message}`);
} finally {
  if (db) {
    await cleanup();
    await db.close();
  }
}

console.log(
  `\n${passed} passed, ${failures.length} failed${
    failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""
  }`,
);
process.exit(failures.length ? 1 : 0);

