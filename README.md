# Faccep — Property Management System

Phases 1 and 2 of the system described in `SPEC.md`: authentication, roles and
permissions, audit trail, multi-company setup, and the core property, tenant and
contract records.

Stack: Next.js 16 (App Router, TypeScript) · Supabase (Postgres + Auth +
Storage) · Tailwind CSS 4.

---

## What is built

**Phase 1 — foundation**

| Area | Status |
|---|---|
| Email/password sign-in, no public signup | Done |
| Multi-company tenancy with a company switcher | Done |
| Locations per company | Done |
| Admin-defined roles, named freely, scoped per company | Done |
| Permission matrix — View / Edit / Delete / Approve / Void per module | Done |
| Per-user overrides layered on the role (allow / deny / inherit) | Done |
| Audit trail with before/after values, filters, pagination | Done |
| Module registry covering every module in the spec | Done (registry only) |

**Phase 2 — core records**

| Area | Status |
|---|---|
| Unit inventory per location: area, rate, appliances, sub-meter serials | Done |
| Unit photos in private Storage, company-scoped | Done |
| Occupancy dashboard per location, derived from live contracts | Done |
| Tenant profiles, VAT status, blacklisting that blocks re-onboarding | Done |
| Contracts: multi-unit, escalation, billing inclusions, utility rules | Done |
| Contract lifecycle draft → active → terminated, gated on Approve | Done |
| Generated contract document, editable clauses, print / save as PDF | Done |
| Scanned wet-signed copy stored against the contract | Done |

**Phase 3 — billing core**

| Area | Status |
|---|---|
| Utility periods: provider bill in, per-unit rate derived out | Done |
| Meter reading grid with previous readings carried forward | Done |
| Building reconciliation: provider vs sub-metered, system loss surfaced | Done |
| Invoice generation: rent with escalation, utilities, genset share, penalties | Done |
| Released invoices immutable; cancel needs approval, or issue a credit memo | Done |
| Payments with oldest-first application; void needs approval and reopens balances | Done |
| Postdated cheque register with maturity tracking | Done |
| Shared approval queue (cancel / void / purchase requests) | Done |

**Phase 4 — dashboard**

| Area | Status |
|---|---|
| Occupancy per location, receivables, collections this month | Done |
| Notifications: overdue, due in 2 days, renewals at 6 months, cheque maturities | Done |
| Utility usage and unbilled-loss summary | Done |

**Phase 5 — maintenance, inventory, purchasing**

| Area | Status |
|---|---|
| Repair workflow reported → … → closed, before/after photos enforced in the DB | Done |
| Scheduled maintenance, printable, raise-a-job per cycle | Done |
| Inventory with stock derived from a movement ledger | Done |
| Material requests: issue deducts stock, close-off returns leftovers | Done |
| Tools with borrow/return slips and one-loan-at-a-time enforcement | Done |
| Contractor percent-complete sign-off gating payment tranches | Done |
| Purchase request → approval → order → receiving (stock updated on receipt) | Done |
| Suppliers with TIN and payment terms | Done |
| Payables: supplier invoices net of withholding tax, cheque vouchers | Done |

**Phase 6 — accounting**

| Area | Status |
|---|---|
| Chart of accounts, with a standard Philippine SME chart on tap | Done |
| Journal entries: must balance to save and again to post | Done |
| Posted entries immutable; corrections by reversal only | Done |
| Accounting periods; posting into a closed period is refused | Done |
| Trial balance, income statement, balance sheet, indicative cash flow | Done |
| Automatic posting from billing, payments, payables and inventory | Done |

**Phase 7 — reports**

| Area | Status |
|---|---|
| Customer aging and receivables detail | Done |
| Collection report by mode and tenant | Done |
| Vendor aging | Done |
| Income per location, month and charge type | Done |
| Active tenants, security deposits by location, available units | Done |
| Utility over/loss with the unrecovered value | Done |
| Maintenance cost by location, contracted vs materials | Done |
| BIR 2307, 1601-EQ summary, VAT relief schedule | Done |

**Phase 8 — front office**

| Area | Status |
|---|---|
| Prospect inquiries with follow-up chasing | Done |
| Printable leasing proposal with editable clauses | Done |
| Complaint log; cannot close without recording a resolution | Done |
| Personal calendar fed by renewals, cheques, permits, maintenance | Done |
| Internal document storage with expiry reminders | Done |

The module registry is seeded for the **whole** specification, not just Phase 1,
so roles you define today already carry permissions for modules that arrive
later. Only Phase 1 modules have pages; the rest appear in the matrix but have
no UI yet.

---

## Setup

### 1. Create a Supabase project

At [supabase.com](https://supabase.com), create a project and note its URL and
keys (Project Settings → API).

### 2. Environment

```bash
cp .env.example .env.local
```

| Variable | Needed for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the app |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the app |
| `SUPABASE_SERVICE_ROLE_KEY` | creating user accounts (no public signup) |
| `SUPABASE_ACCESS_TOKEN` | the CLI and the script transport |
| `SUPABASE_DB_URL` | optional — see below |

The scripts talk to the database over one of two transports, chosen
automatically: a direct Postgres connection when `SUPABASE_DB_URL` is set and
reachable, otherwise the Supabase Management API using `SUPABASE_ACCESS_TOKEN`,
which executes SQL as the `postgres` role **without** needing the database
password. Setting `SUPABASE_DB_URL` is faster and avoids per-statement HTTP, but
nothing requires it.

The service role key and the access token both bypass row level security.
`.env.local` is gitignored — keep it that way.

### 3. Run the migrations

```bash
npm run db:push
```

Applies `supabase/migrations/*.sql` in order using `SUPABASE_DB_URL`, records
what ran in a `_migrations` table so it is safe to repeat, and wraps each file
in its own transaction so a failure cannot leave the schema half-applied.

| File | Contents |
|---|---|
| `0001_foundation.sql` | companies, locations, profiles, roles, permission matrix, audit log |
| `0002_permissions_rls.sql` | `has_permission` / `my_permissions` + RLS on every table |
| `0003_seed_modules.sql` | module registry for the whole spec |
| `0004_core_records.sql` | units, tenants, contracts, occupancy and blacklist triggers |
| `0005_storage.sql` | private `unit-photos` and `documents` buckets, company-scoped |
| `0006_billing.sql` | approvals, utility periods, meter readings, invoices, payments, PDCs |
| `0007_fix_settlement_cast.sql` | enum-cast fix in the settlement trigger |
| `0008_maintenance_inventory_purchasing.sql` | maintenance, inventory, tools, purchasing, payables |
| `0009_accounting.sql` | chart of accounts, periods, journals, trial balance |
| `0010_crm_documents.sql` | inquiries, complaints, calendar, document storage |
| `0011_auto_posting.sql` | triggers that post operational documents to the ledger |
| `0012_fix_line_kind_cast.sql` | enum-cast fix in the invoice posting rule |

---

## How automatic posting works

Seeding the chart of accounts is what switches it on. Until a company has an
AR account mapped in `accounting_settings`, the billing modules run standalone
and post nothing — so accounting is opt-in per company. Once mapped, every
document writes its own journal entry:

| Event | Entry |
|---|---|
| Invoice released | DR Receivables · CR income by line kind · CR Output VAT |
| Payment received | DR Cash · CR Customer Advances |
| Payment applied to an invoice | DR Customer Advances · CR Receivables |
| Security deposit received | DR Cash · CR Security Deposits Payable |
| Deposit refunded | DR Security Deposits Payable · CR Cash |
| Credit memo issued | DR Sales Allowances · CR Receivables |
| Supplier invoice recorded | DR Expense or Inventory, DR Input VAT · CR Withholding Tax, CR Payables |
| Voucher released | DR Payables · CR Cash |
| Materials issued to a job | DR Repairs and Maintenance · CR Inventory |
| Materials returned unused | the reverse |

Four rules hold throughout:

**Triggers, not application code.** Posting cannot be skipped by a code path
that forgets to call it.

**Exactly once.** Every posting is tagged `(source_table, source_id,
source_event)` with a unique index behind it. Re-running is a no-op, never a
double entry.

**Nothing is un-posted.** Cancelling an invoice or voiding a payment writes a
reversing entry and marks the original reversed, exactly as a manual
correction would.

**A payment lands in Customer Advances first**, and only moves to receivables
when it is applied. That is what makes prepayments correct without a special
case — an unapplied receipt simply stays in the advance account. A security
deposit is different: it is a refundable liability, so it books straight to
Security Deposits Payable and can never be applied to a bill.

**Posting is atomic with the transaction.** Entries are created *and* posted in
one step, so an automatic entry is never left sitting in draft. If the posting
cannot succeed — an invoice dated inside a closed period, say — the release
fails with it and nothing is written.

One consequence worth knowing: because posting runs through the same guard as
manual entries, **releasing an invoice dated inside a closed accounting period
will fail.** Reopen the period or date the invoice differently.

---

## Purchasing: the three-way match

Request → approval → order → **receive** → **bill** → voucher → payment.

The bill is raised from the purchase order itself, not typed from scratch. The
page shows what was ordered, what has been received, what has already been
billed, and what is still billable; the form starts at that remaining figure
and the supplier and order link come across automatically.

The database enforces the match:

- an order with **nothing received** cannot be billed at all;
- a bill cannot exceed the **received** value, not the ordered value;
- successive bills cannot cumulatively pass it either.

That is what stops paying for goods that never arrived — the informal
purchasing the system replaces. Goods receipts deliberately post nothing to the
ledger; the accounting entry comes from the bill, so inventory is valued once,
at the price actually invoiced.

### Stock and non-stock lines

Not everything bought is stock. A purchase line is either:

- **Stocked** — pick an inventory item. Receiving adds to stock, and the bill
  debits Inventory.
- **Non-stock** — services, utilities, professional fees. Nothing touches
  stock, and the line carries the expense account it is charged to, defaulting
  to the company's general expense account.

A bill against a mixed order splits its debit across Inventory and those
expense accounts, pro-rata by what was actually received, with the rounding
residual landing on the largest share so the entry balances exactly. A bill
raised without a purchase order at all — the usual case for a utility bill —
carries its own **Charge to** account.

---

## Closing a period

A period will not close while any **transaction on hold** is dated inside it.
The Periods page lists what is in the way and disables the Close button until
it is clear; the database refuses the close regardless, so the rule holds even
if it is reached another way.

**Blocks the close** — closing would strand these, because posting into a
closed period is refused:

| Item | Why |
|---|---|
| Draft invoices | Could never be released afterwards |
| Draft journal entries | Could never be posted afterwards |
| Pending approvals on the period's invoices or payments | Approving applies the change, which needs to post |
| Cheque vouchers prepared but not released | A voucher keeps its own date, so releasing it later would post into the closed period |

**Listed as a note only** — nothing gets stranded, so these do not block:
utility periods still unlocked, and purchase orders issued but not fully
received (goods arriving later are dated on receipt).

**Not listed at all:** a released invoice that is still unpaid. It is a
finished transaction; the receivable carries forward and has no bearing on the
close. Requiring every invoice to be *paid* before closing a month would mean
never closing one.

### Cancel, never delete

A transaction that will not proceed is **cancelled**, not removed. Deleting a
draft leaves no trace of the work, the decision or the reason; cancelling keeps
the document and its lines exactly as they were, records why it went no
further, and clears the period-close blocker.

| Document | Not proceeding | Already live |
|---|---|---|
| Invoice | Cancel the draft, with a reason | Approval-gated cancellation, or a credit memo |
| Journal entry | Cancel the draft, with a reason | Reversal — a posted entry can never be cancelled |
| Cheque voucher | Cancel it; the supplier invoices simply reopen | Reversal on cancel after release |

Cancelling a draft needs no approval, because a draft never reached the ledger.
Once cancelled, the document is frozen: it cannot be edited, released or
posted.

Pasting each file into the Supabase SQL editor by hand works too.

### 3b. Verify the permission model

```bash
npm run db:verify
```

Creates two throwaway companies and three throwaway users, checks every rung of
the precedence ladder, the tenancy boundary, the append-only audit log, and the
Phase 2 triggers (unit occupancy, escalation constraint, blacklist block), then
deletes everything it made. Run it after any migration change.

### 4. Create the first super admin

```bash
node scripts/bootstrap-admin.mjs you@example.com
```

Creates the account and promotes it, printing a generated initial password.
Pass a password as a second argument to choose your own. If the account already
exists it is promoted in place and the password is left alone.

A super admin bypasses every permission check and is the only role that can
create a company — there is no membership row to authorise against before one
exists.

### 5. Start

```bash
npm install
```

```bash
npm run dev
```

Sign in, create your first company, then add locations, roles and users.

### 6. Optional — starter roles

`supabase/seed/example_roles.sql` creates the example roles from spec §2
(Manager, Billing Processor, Cashier, Property Custodian) wired to the
confirmed segregation-of-duties rules. Set the company name at the top of the
file before running it. Everything it creates is editable in the UI afterwards.

---

## How permissions resolve

Precedence, highest first:

1. **Super admin** — everything, in every company.
2. **Company admin** — everything, within that one company.
3. **Per-user override** — an explicit allow or deny on one (module, action).
4. **Role** — the role's matrix value.
5. **Deny** — the default when nothing above grants it.

Two layers enforce this:

- **Row level security** in Postgres, via `has_permission(company, module,
  action)`. This is the real boundary — it holds even if a bug in the app
  forgets to check.
- **`requirePermission()` / `assertPermission()`** in the app, so pages redirect
  and server actions return a readable error instead of failing on an empty
  result set.

`my_permissions(company)` returns the whole resolved matrix in one round trip;
it is loaded once per request and cached.

### Why `void` is its own flag

A void keeps the record and reverses its effect, so it is neither Edit nor
Delete. Per spec §2 and §7 it is a separate permission that additionally needs
approval before taking effect. The approval workflow itself lands with the
modules that own voidable records (billing, payments) in Phase 3.

---

## Layout

```
app/
  (app)/                    signed-in shell: sidebar, company switcher
    dashboard/              counts + recent activity
    properties/             locations with occupancy; units per location
    tenants/                tenant profiles, status, their contracts
    contracts/              list, create, detail, printable document
    admin/
      companies/            create and edit companies
      locations/            locations per company
      users/                accounts, company access, per-user overrides
      roles/[id]/           the permission matrix editor
      audit/                filterable audit trail
  login/                    sign in
  forbidden/, no-company/   guard destinations
lib/
  auth.ts                   session context, page and action guards
  permissions.ts            module keys, actions, matrix helpers
  audit.ts                  audit writer and before/after diffing
  format.ts                 peso, dates, escalation maths
  supabase/                 request-scoped, service-role, browser, proxy clients
scripts/
  db-push.mjs               migration runner
  db-verify.mjs             permission-model and trigger checks
supabase/
  migrations/               schema, RLS, module seed
  seed/                     optional starter roles
```

---

## How Phase 2 hangs together

**Occupancy is derived, never typed.** `sync_unit_status()` fires whenever a
contract changes status or gains/loses a unit: a draft contract marks its units
`reserved`, activating marks them `occupied`, terminating releases them to
`vacant`. The only manual state is `inactive`, which the trigger never
overwrites. Nothing in the UI sets occupancy directly.

**Blacklisting is enforced in the database.** Spec §12 requires that an
abandoning tenant be blocked from re-onboarding. A trigger refuses any contract
insert for a blacklisted tenant, so it holds even if a future code path forgets
to check.

**Escalation is computed, not stored.** The rate is one of 0/3/5 (a check
constraint), and per-year rent and deposit are derived on demand — so a rate
correction reflows the whole schedule instead of leaving stale rows behind.

**Contract documents are rendered from the record.** Clauses are
`contentEditable` so the wording can be adjusted before printing, per spec §4.2.
Those edits deliberately affect the printout only, never the stored contract —
the record stays the source of truth.

---

## Notes for the next phase

- Every new table needs `company_id` plus the same RLS pattern as `locations`,
  otherwise it is invisible to `has_permission`.
- Financial records (invoices, payments, journal entries) must be
  insert-and-void, never update-in-place, per spec §2/§6/§11. Add the void and
  approval columns when those tables are created rather than retrofitting.
- The audit trail has no update or delete policy on purpose. Do not add one.
