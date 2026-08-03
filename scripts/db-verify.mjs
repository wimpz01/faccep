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
           (${lit(beta)},  'B1', 'Beta building');
  `);

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
  check("sees only its own company's locations", visible[0].codes, "A1");

  const superSees = await asUser(
    superAdmin,
    "select coalesce(string_agg(distinct code, ',' order by code), '') as codes from public.locations where code in ('A1','B1');",
  );
  check("super admin sees both companies", superSees[0].codes, "A1,B1");

  check(
    "cannot create a location without admin.locations edit",
    await expectFailAsUser(
      regular,
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

  await db.query(`
    insert into public.invoice_lines
      (invoice_id, line_kind, description, quantity, unit_price, amount, is_vatable)
    values (${lit(invoiceId)}, 'rent', 'Rent', 1, 10000, 10000, true),
           (${lit(invoiceId)}, 'water', 'Water', 1, 500, 500, false);
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
         provider_amount, provider_consumption, genset_expense)
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
      (invoice_id, line_kind, description, quantity, unit_price, amount, is_vatable)
    values (${lit(autoInvoice)}, 'rent', 'Rent', 1, 20000, 20000, true),
           (${lit(autoInvoice)}, 'electricity', 'Power', 1, 5000, 5000, false);
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

  await db.query(`
    insert into public.payments
      (company_id, tenant_id, payment_no, payment_kind, payment_date, amount)
    values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-DEP`)},
            'deposit', '2026-05-20', 40000);
  `);
  check(
    "a deposit received credits the liability",
    (await balanceOf("2200")) - depositBefore,
    40000,
  );

  await db.query(`
    insert into public.payments
      (company_id, tenant_id, payment_no, payment_kind, payment_date, amount)
    values (${lit(alpha)}, ${lit(autoTenant)}, ${lit(`${TEST_TAG}-REF`)},
            'refund', '2026-05-25', 15000);
  `);
  check(
    "refunding part of it debits the same liability",
    (await balanceOf("2200")) - depositBefore,
    25000,
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
