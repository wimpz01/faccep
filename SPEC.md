# Faccep Property Management System — Specification

## 1. Overview

Faccep is a commercial property leasing business (retail/commercial units across one or more
buildings/locations). Today, everything — tenant records, contracts, monthly utility billing,
payment tracking, repair/maintenance, purchasing, inventory, and accounting — is run manually
across Excel and QuickBooks.

This system replaces that manual workflow with a single **web application** (desktop + mobile
browser) that automates tenant billing, contracts, payments, repair & maintenance, purchasing,
inventory, and full accounting, with role-based access and dashboards for owners/managers.

**Platform:** Web app, responsive (desktop + mobile browser). No native mobile app in scope.
**Accounting:** Full in-house accounting module — this system replaces QuickBooks (no QuickBooks
integration/export needed).
**Notifications:** In-app dashboard notifications + a user portal notification center. No email or
SMS delivery required.
**Multi-company:** Required. A single install must support multiple companies, each owning one or
more locations/buildings, with users, data, and reports scoped per company.

---

## 2. User Roles & Permissions

Roles are **fully custom and admin-defined** — there is no fixed role list in the system. Admin
creates a role by choosing which modules/transactions it can access and with what permission level
(View/Edit/Delete/Approve — see below), then assigns users to that role. New roles can be created
at any time as the business needs them.

Example roles given as a starting point (not an exhaustive or fixed set):

| Example Role | Typical access |
|---|---|
| **Admin** | Full access to everything, including creating users, creating/editing roles, and setting access rights. Only Admin can do this. |
| **Manager** | Approves items that require approval (invoice cancellations, voids, purchase requests, etc.) — see the Approve permission below. |
| **Billing Processor / Encoder** | Creates/enters billing invoices — cannot accept or apply payments (see segregation-of-duties note below). |
| **Cashier** | Creates/applies client payments. View-only on invoices; cannot edit/delete invoices or payments (see §7). |
| **Property Custodian** | In charge of repair and maintenance. |
| *(others as needed)* | e.g. Accounting, Property Manager, Encoder — Admin can create any role needed and scope its module access. |

**Rules:**
- Only Admin can create users, create/edit roles, and configure access rights per user/role.
- **Access rights are granular per transaction/module** — for each transaction type (e.g., tenant
  billing, payments, contracts, purchasing, inventory, repair reports, accounting entries), Admin
  can set a role's (or an individual user's) permission independently as any combination of:
  - **View** — can see the record/list, no changes allowed
  - **Edit** — can create and modify records
  - **Delete** — can remove records
  - **Approve** — can approve items that require sign-off (e.g., invoice cancellations, voids,
    purchase requests) — this is what defines an "approver" role like Manager, rather than a
    separate hardcoded concept
  - A user can be, for example, View + Edit on Billing but View-only on Payments, or Approve-capable
    on Purchasing but not on Accounting — permissions are not all-or-nothing per role.
- Every create/edit/delete/void action must be captured in an **audit trail** (who, what, when,
  before/after values where practical).
- **Void** on payments is not a simple access-right toggle — it requires **approval** before it
  takes effect (same pattern as invoice cancellation), and is treated as its own permission,
  separate from Delete, since a void keeps the record but reverses its effect.
- Dashboard views (financial figures, occupancy, notifications, etc.) are **not restricted to
  Admin/Owner by default** — visibility of each dashboard item is governed by the same per-user
  access rights Admin configures. Admin can grant or withhold access to any dashboard section
  (e.g., income/profit per location) for any user, the same way as any other transaction/module.

**Suggested data model:** roles are their own table (admin-created, named freely — e.g. "Billing
Processor", "Property Custodian"), with a permission matrix of `(role_or_user, module,
transaction_type) → {view, edit, delete, approve}` (booleans, independently settable). Individual
users can also get overrides on top of their role. This lets Admin build any org structure without
the system assuming a fixed role list.

**Default permission examples (confirmed):**
- **Tenant records** — once a tenant is approved/set up, only Admin/Owner can delete that tenant
  record (other roles that touch tenant data cannot delete it).
- **Invoicing/accounting** — once an invoice is released and entered into the accounting system, it
  cannot be directly edited or deleted. Corrections happen through one of two paths: (a) **cancel
  the invoice**, which requires approval before it takes effect, or (b) issue a **credit memo**
  against it. The original invoice record is preserved either way — nothing is silently edited or
  removed.
- **Cashier** — view-only on invoices (cannot edit them); no edit or delete on payment records
  either. Cashier's only allowed action on payments is to **apply payment**; voiding a payment
  requires approval and is not something Cashier can do unilaterally.

These examples establish the general pattern to extend to the rest of the modules: transactions
that are financial "source of truth" (invoices, journal entries, posted payments) should **not be
directly editable or deletable once finalized** — corrections go through an approval-gated
cancellation or a credit memo/reversing entry instead. This should be a system-wide rule, not just
for invoicing.

**Confirmed separation of duties:** Encoder (creates/enters billing invoices) is a distinct role
from whoever is allowed to **accept and apply payments** (e.g., Cashier) — an Encoder cannot also
process payments, and a payment-accepting role isn't automatically able to create invoices. This is
the same segregation-of-duties principle as the Cashier example above (view-only on invoices,
apply-only on payments), just stated generally: creating a transaction and settling/approving it
should default to different roles unless Admin explicitly overrides that.

**Still open:** the full default matrix for every remaining role × module combination beyond the
examples above (e.g., what Property Manager can do in Contracts, what Property Custodian can do in
Purchasing) — the pattern above should guide filling this in, but the complete table should be
confirmed or refined during setup rather than assumed.

Note: **Maintenance and Purchasing are separate modules**, not one nested inside the other. A
material request created in Maintenance (§8) hands off to Purchasing (§10) as its own record with
its own approval flow — a Maintenance user isn't automatically granted access into Purchasing just
because they can create a material request; that handoff itself is a separate permission to set.

---

## 3. Dashboard

Each dashboard section's visibility is controlled by the per-user access rights Admin configures
(see §2) — not hardcoded to Admin/Owner only. Admin decides which users can see which sections.
Includes:

- Sales / income and profit, filterable **per location**
- Occupancy rate and vacant spaces available, per location
- Water usage and electricity usage summaries
- Expenses per location
- **Notifications panel** (in-app):
  - Overdue tenants — alert 2 days before due date, and when overdue
  - Tenants nearing contract end — alert 6 months before end date, to trigger renewal notice
  - Upcoming repair/maintenance schedule
  - Postdated checks nearing maturity date

---

## 4. Tenant Module

### 4.1 Tenant Profile (setup)
- Company name, company address, company number, contact person / owner name, mobile number, email
- Taxable status (VATable or not)
- Location + unit(s) rented — **a tenant profile can hold multiple units**
- Monthly rental rate
- Contract term (years, e.g. 1 or 2)
- Security deposit amount
- Contract start date, end date
- **Escalation rate**: selectable per tenant — 0%, 3%, or 5% (applies annually to both rent and
  security deposit, per succeeding year)
- Electricity/water billing type per tenant: **fixed**, **minimum + overage**, or **pure
  consumption-based**
- Billing inclusions checklist: monthly rent, parking, security guard, water, electricity, other —
  only the items agreed in that tenant's contract should appear on their invoice

### 4.2 Contract Generation
System generates a contract document from the tenant profile, containing:
- Items included, rent amount, VAT, deposit, advance, escalation rate (0/3/5%), annual increase
  application, penalty terms, rent due date, water/electricity billing rules, repair
  responsibility, lease period, renewal terms, termination grounds
- Output must let the user edit selected fields before finalizing, and support **Print** and
  **Download as PDF** (see §15 Document Output Standard). **No e-signature needed** — contracts
  are printed, wet-signed, and scanned back in (the scanned copy is stored per §14 Internal
  Documents).

---

## 5. Property Module

- **Property profile** per location: property type (commercial building, office, warehouse, vacant
  lot, apartment)
- **Unit/space list** per property: unit code, area (sqm), monthly rate, photos, included
  appliances (e.g. bed, TV, ref), and **sub-meter serials** allocated for water and electricity
- Unit photos + measurements can be shared directly to prospects/inquiries from this module

---

## 6. Billing Module

- Auto-generate invoices based on the tenant's contract term, or create manually
- Invoice line items depend on tenant's billing inclusions: monthly rental fee, water bill,
  electric bill, late-payment penalty (if applicable), other fees
- VAT applied only for VATable tenants
- **Utility computation** (per current manual process, to be automated):
  - Consumption = present meter reading − previous meter reading (per tenant, per utility)
  - Rate = derived from the actual utility provider's bill for that period (total ₱ ÷ total
    kWh/liters consumed by the building)
  - Amount = consumption × rate (or fixed/minimum rate, depending on tenant's billing type)
  - Building-level reconciliation: total tenant billed usage vs. total meter/provider reading, to
    surface the discrepancy (system loss / unbilled usage)
  - **Generator (genset) expense allocation — confirmed**: total genset expense (fuel/maintenance)
    for the period is allocated to each tenant **pro-rated by their kWh usage** — i.e., each
    tenant's share = (tenant's electric kWh consumption ÷ total building electric kWh consumption)
    × total genset expense for the period. This amount is added to the tenant's electric bill line
    item.
- Late payment penalty: 2% on electric/water if unpaid more than 1 week after the tenant received
  the billing
- **Once an invoice is released and posted to accounting, it can't be directly edited or deleted**
  — corrections go through an approval-gated cancellation or a credit memo (see §2 and §11).

---

## 7. Payment Module

- Payment types: **Payment**, **Prepayment**, **Refund** (e.g., security deposit refund at
  contract end, net of deductions for damages/unpaid bills — see §12 clearance process)
- Modes: Cash, GCash, Check (dated or postdated)
- **PDC (postdated check) tracking**: capture check number, bank, amount, and maturity date per
  tenant; system should track PDC status (pending / matured / deposited / bounced) and surface
  upcoming maturities on the dashboard
- Payment and invoice records cannot be edited or deleted directly, once created/posted; **void
  requires approval** before it takes effect, and is logged in the audit trail

---

## 8. Repair & Maintenance Module

### 8.1 Scheduled Maintenance
- Recurring job scheduling (e.g., "clean gutters every April", "reapply roof sealant every May")
- Printable schedule
- Accomplishment report per completed job (date done, who did it, notes)

### 8.2 On-Demand Repair Workflow
Status flow: **Reported → Approved → Assigned → In Progress → Completed → Inspected → Closed**
- Before/after photos required at Completed/Inspected stages
- Project costing distinguishes **in-house** vs **contracted** work:
  - In-house: linked to a Material Request (deducts from Inventory — see §9). The Material Request
    acts as a **checklist of materials issued for that job** (item, quantity issued) — used at job
    completion to check off what was actually used vs. what's left over.
  - Contracted: linked to a vendor/contractor and tracked against Purchasing/Payables (§10).
    **Confirmed**: requires a formal **% complete sign-off** before each payment tranche is
    released — each progress payment must be tied to a recorded completion percentage, approved
    (see Approve permission, §2) before Payables (§10) will release that tranche. This directly
    closes the current gap where contractor payments go out without verifying actual progress.

---

## 9. Inventory Management ★ (priority)

- Categories: electrical supplies, cleaning materials, paints, etc. (configurable list)
- Stock is **deducted automatically** when a material request is approved/issued for a maintenance
  job
- **Materials-used checklist**: each job's Material Request lists the items/quantities issued to
  it. At job completion (Completed/Inspected stage — see §8.2), the assigned staff checks off what
  was actually used against that list, which surfaces any leftover quantity automatically rather
  than relying on someone remembering to report it.
- **Material return flow**: leftover/unused materials identified by the checklist go through a
  separate **Return to Inventory** transaction — item, quantity, condition, and which job it came
  from — which re-adds the quantity back to stock. This directly closes the current gap where
  leftover materials get set aside and lost track of.
- **Tools & equipment** tracked separately from consumable materials, with a **borrow/return slip**
  (who borrowed, what, when, expected return date, actual return date, condition)

---

## 10. Purchasing & Payables ★ (priority on purchasing)

**Purchasing flow:** Material/purchase request → Approval → Purchase Order → Receive items →
Supplier invoice
**Payables flow:** Check voucher → Payment
**Vendor management:** supplier name, TIN, address, contact person, payment terms

This directly targets the current pain point: purchasing today is informal (maintenance staff
requests → in-charge buys → hands over manually, no paper trail, no approval gate).

---

## 11. Accounting Module (full, in-house)

- General ledger, chart of accounts, journal entries
- Accounts payable, accounts receivable
- Trial balance, balance sheet, income statement, cash flow statement
- Inventory valuation feeds into the GL (from §9)
- Philippine tax compliance — **confirmed forms/reports the system must be able to generate**:
  - **BIR Form 2307** (Certificate of Creditable Tax Withheld at Source)
  - **BIR Form 1601-EQ** (Quarterly Remittance Return of Creditable Income Taxes Withheld)
  - **VAT relief** reporting (for VATable tenant transactions)
- Multi-company: each company has its own chart of accounts and financial statements; consolidated
  reporting across companies is a nice-to-have, not confirmed as required
- **Posted journal entries/invoices cannot be directly edited or deleted** — corrections are made
  via an approval-gated cancellation or a credit memo/reversing entry, preserving a full audit
  history

---

## 12. End-of-Contract / Clearance

- Unit inspection before refunding security deposit
- Deduct unpaid bills and/or repair costs from the deposit before refunding the balance
- **Default handling**: tenant unpaid for 2–3 months → flagged for contract termination
- **Abandonment**: tenant vacates without notice → items left behind are forfeited, tenant is
  flagged as **blacklisted** in the system (should block future re-onboarding without override)

---

## 13. Reports

- Customer balance summary & detailed
- Customer aging / vendor aging
- Monthly sales report; income per location
- Monthly expense report; expenses per location
- List of active tenants
- List of postdated checks (status, maturity)
- List of receivables; late payment report
- Collection report (daily/monthly, flexible date filter)
- Financial statements (balance sheet, income statement, cash flow)
- Security deposit report (filterable by tenant or by group/location)
- Withholding tax report (BIR Form 2307, Form 1601-EQ) and VAT relief report
- Available units per location (with rate and details)
- Utility over/loss report (water/electric — building consumption vs. tenant-billed total)
- Maintenance cost report
- Supplier expenses report

---

## 14. Additional Modules

- **Bank**: generate a deposit slip for incoming matured postdated checks
- **Tenant Inquiry / CRM**: log prospect inquiries, auto-generate a proposal for a specific unit
  with editable fields, printable/downloadable as PDF (see §15), follow-up
  notifications/reminders, send unit photos + measurements on request
- **Tenant complaint log**: log complaints with follow-up tracking to resolution
- **User calendar**: personal calendar per user with notification alarms (ties into maintenance
  schedule, contract renewals, PDC maturities)
- **Internal document storage**: business permit, DTI registration, Mayor's permit, generated
  contracts (auto-linked to the tenant they belong to), and outbound letters (notices, memos)

---

## 15. Cross-Cutting Requirements

- **Audit trail**: every create/edit/delete/void logged with user, timestamp, and change detail,
  viewable by Admin.
- **Multi-company / multi-location**: data, users, and reports must be scoped correctly — a
  location belongs to exactly one company; a user's access can span one or more companies depending
  on role.
- **Access-gated visibility**: financial dashboards (income/profit) are opt-in visible, not
  default-visible to every role.
- **Document output standard**: every generated document must support both **Print** and
  **Download as PDF**. Only **contracts, letters, and proposals** — templated documents — allow
  editing selected fields before finalizing. **Invoices are a different kind of object**: they're a
  **transaction created by a user** (e.g., Encoder/Billing Processor enters line items, amounts,
  etc. — see §6), not a fill-in-the-blank template. Once that transaction is posted, it becomes
  locked (see §2/§6/§11) — the PDF output is simply a printable rendering of the posted transaction
  data, not an editable document. Reports work the same way: generated from system data, printable/
  downloadable, not editable.
- **Scale — confirmed**: roughly **3 locations and ~5 tenants per location at launch**, with the
  expectation of adding more of both over time. This is a small-to-mid dataset — no need to design
  around high-volume/big-data concerns (e.g., sharding, heavy caching layers). The priority instead
  is that adding a new location, unit, or tenant is a simple, low-friction action for Admin/Property
  Manager, since growth will happen incrementally through the UI rather than bulk import.

---

## 16. Confirmed Decisions Log

Everything that was originally flagged as an open question has now been confirmed. Kept here as a
single reference point rather than scattered across sections:

- **Platform**: Web app (browser, desktop + mobile) — §1
- **Accounting**: Full in-house module, replacing QuickBooks — §1, §11
- **Notifications**: In-app dashboard + user portal only (no email/SMS) — §1
- **Genset expense allocation**: Pro-rated by tenant's kWh usage — §6
- **Contract signing**: No e-signature — print, wet-sign, scan back in — §4.2
- **Contracted-repair payments**: Require a % complete sign-off, approved, before each tranche — §8.2
- **BIR compliance**: Form 2307, Form 1601-EQ, and VAT relief reporting — §11, §13
- **Scale at launch**: ~3 locations, ~5 tenants per location, expandable over time — §15
- **Data migration**: None — starting clean, all tenant/contract/balance records will be manually
  re-input into the new system rather than imported from Excel/QuickBooks

---

## 17. Suggested Build Order (phased)

Given the scope, a phased rollout is strongly recommended rather than building everything at once:

1. **Foundation**: Auth, roles/permissions, audit trail, multi-company/location setup
2. **Core records**: Property/unit profiles, tenant profiles, contract generation
3. **Billing core**: Meter reading entry, utility computation, invoice generation, payment
   recording, PDC tracking
4. **Dashboard v1**: Occupancy, overdue tenants, contract-renewal alerts, PDC maturity alerts
5. **Repair & maintenance + Inventory + Purchasing** (the user's named priority pain point)
6. **Accounting module**: GL, COA, AP/AR, financial statements
7. **Reports suite**: build out remaining reports from §13
8. **CRM/inquiry module, complaints log, calendar, document storage**
