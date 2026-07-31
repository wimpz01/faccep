-- Module registry seed.
--
-- Covers every module in the specification, not just Phase 1, so that roles
-- created today already carry the full permission matrix and later phases only
-- need to add UI. Re-runnable.

insert into public.modules
  (key, label, module_group, description, sort_order, supports_approve, supports_void)
values
  -- Dashboard (spec 3) -- each panel is separately grantable.
  ('dashboard.income',          'Income & Profit',            'Dashboard', 'Sales, income and profit figures per location.',            10, false, false),
  ('dashboard.occupancy',       'Occupancy & Vacancies',      'Dashboard', 'Occupancy rate and available units per location.',          20, false, false),
  ('dashboard.utilities',       'Utility Usage',              'Dashboard', 'Water and electricity usage summaries.',                    30, false, false),
  ('dashboard.expenses',        'Expenses',                   'Dashboard', 'Expense totals per location.',                              40, false, false),
  ('dashboard.notifications',   'Notifications Panel',        'Dashboard', 'Overdue tenants, contract ends, maintenance, PDC alerts.',  50, false, false),

  -- Tenants & contracts (spec 4)
  ('tenants',                   'Tenant Profiles',            'Tenants',   'Tenant company records, units held, billing inclusions.',  100, false, false),
  ('contracts',                 'Contracts',                  'Tenants',   'Contract generation, renewal and termination.',            110, true,  false),
  ('clearance',                 'End of Contract & Clearance','Tenants',   'Move-out inspection, deposit deduction and refund.',       120, true,  false),

  -- Property (spec 5)
  ('properties',                'Property Profiles',          'Property',  'Locations and property-level details.',                    200, false, false),
  ('units',                     'Units & Spaces',             'Property',  'Unit list, area, rate, photos, sub-meter serials.',        210, false, false),

  -- Billing (spec 6)
  ('billing.meter_readings',    'Meter Readings',             'Billing',   'Per-unit water and electric meter reading entry.',         300, false, false),
  ('billing.utility_rates',     'Utility Rates & Genset',     'Billing',   'Provider bill entry, derived rates, genset allocation.',    310, true,  false),
  ('billing.invoices',          'Tenant Invoices',            'Billing',   'Invoice generation and release.',                          320, true,  true),
  ('billing.credit_memos',      'Credit Memos',               'Billing',   'Credit memos issued against posted invoices.',             330, true,  true),

  -- Payments (spec 7)
  ('payments',                  'Client Payments',            'Payments',  'Payments, prepayments and refunds.',                       400, true,  true),
  ('payments.pdc',              'Postdated Checks',           'Payments',  'PDC register, maturity and deposit status.',               410, true,  true),

  -- Repair & maintenance (spec 8)
  ('maintenance.scheduled',     'Scheduled Maintenance',      'Maintenance','Recurring job schedule and accomplishment reports.',       500, true,  false),
  ('maintenance.repairs',       'Repair Jobs',                'Maintenance','On-demand repair workflow, reported through closed.',     510, true,  false),
  ('maintenance.material_requests','Material Requests',       'Maintenance','Materials requested and issued against a job.',           520, true,  false),
  ('maintenance.progress_signoff','Contractor Progress Sign-off','Maintenance','Percent-complete sign-off gating each payment tranche.',530, true,  false),

  -- Inventory (spec 9)
  ('inventory.items',           'Inventory Items',            'Inventory', 'Stock items and categories.',                              600, false, false),
  ('inventory.movements',       'Stock Movements',            'Inventory', 'Issuances, adjustments and returns to inventory.',         610, true,  true),
  ('inventory.tools',           'Tools & Equipment',          'Inventory', 'Tool register and borrow/return slips.',                   620, true,  false),

  -- Purchasing & payables (spec 10)
  ('purchasing.requests',       'Purchase Requests',          'Purchasing','Purchase/material requests awaiting approval.',            700, true,  true),
  ('purchasing.orders',         'Purchase Orders',            'Purchasing','Purchase orders issued to suppliers.',                     710, true,  true),
  ('purchasing.receiving',      'Receiving',                  'Purchasing','Goods receipt against purchase orders.',                   720, true,  false),
  ('purchasing.vendors',        'Vendors',                    'Purchasing','Supplier records, TIN, terms.',                            730, false, false),
  ('payables.invoices',         'Supplier Invoices',          'Payables',  'Supplier bills posted to accounts payable.',               800, true,  true),
  ('payables.vouchers',         'Check Vouchers',             'Payables',  'Check voucher preparation.',                               810, true,  true),
  ('payables.payments',         'Supplier Payments',          'Payables',  'Release of payment to suppliers.',                         820, true,  true),

  -- Accounting (spec 11)
  ('accounting.coa',            'Chart of Accounts',          'Accounting','Account list per company.',                                900, false, false),
  ('accounting.journal',        'Journal Entries',            'Accounting','Manual journal entries and reversals.',                    910, true,  true),
  ('accounting.ar',             'Accounts Receivable',        'Accounting','Receivable ledger and application.',                       920, true,  false),
  ('accounting.ap',             'Accounts Payable',           'Accounting','Payable ledger and application.',                          930, true,  false),
  ('accounting.periods',        'Period Close',               'Accounting','Opening and closing of accounting periods.',               940, true,  false),
  ('accounting.tax',            'Tax Compliance',             'Accounting','BIR 2307, 1601-EQ and VAT relief preparation.',            950, true,  false),

  -- Reports (spec 13)
  ('reports.receivables',       'Receivables & Aging Reports','Reports',   'Customer balances, aging, late payment, collections.',    1000, false, false),
  ('reports.sales',             'Sales & Income Reports',     'Reports',   'Monthly sales and income per location.',                  1010, false, false),
  ('reports.expenses',          'Expense Reports',            'Reports',   'Monthly expenses per location, supplier expenses.',       1020, false, false),
  ('reports.tenants',           'Tenant Reports',             'Reports',   'Active tenants, security deposits, available units.',     1030, false, false),
  ('reports.utilities',         'Utility Over/Loss Reports',  'Reports',   'Building consumption versus tenant-billed totals.',       1040, false, false),
  ('reports.maintenance',       'Maintenance Cost Reports',   'Reports',   'Maintenance and repair cost summaries.',                  1050, false, false),
  ('reports.financials',        'Financial Statements',       'Reports',   'Balance sheet, income statement, cash flow.',             1060, false, false),
  ('reports.tax',               'Tax Reports',                'Reports',   'Withholding tax and VAT relief reports.',                 1070, false, false),

  -- Additional modules (spec 14)
  ('bank.deposits',             'Bank Deposits',              'Other',     'Deposit slips for matured postdated checks.',             1100, true,  false),
  ('crm.inquiries',             'Tenant Inquiries',           'Other',     'Prospect log, proposals and follow-ups.',                 1110, false, false),
  ('crm.complaints',            'Complaint Log',              'Other',     'Tenant complaints and resolution tracking.',              1120, false, false),
  ('calendar',                  'Calendar',                   'Other',     'Personal calendar and reminders.',                        1130, false, false),
  ('documents',                 'Internal Documents',         'Other',     'Permits, registrations, signed contracts, letters.',      1140, false, false),

  -- Administration (spec 2, spec 15)
  ('admin.companies',           'Companies',                  'Administration','Company records.',                                    1200, false, false),
  ('admin.locations',           'Locations',                  'Administration','Locations belonging to a company.',                   1210, false, false),
  ('admin.users',               'Users',                      'Administration','User accounts, company access, per-user overrides.',  1220, false, false),
  ('admin.roles',               'Roles & Permissions',        'Administration','Role definitions and the permission matrix.',         1230, false, false),
  ('admin.audit',               'Audit Trail',                'Administration','Read-only log of every change.',                      1240, false, false)
on conflict (key) do update
   set label            = excluded.label,
       module_group     = excluded.module_group,
       description      = excluded.description,
       sort_order       = excluded.sort_order,
       supports_approve = excluded.supports_approve,
       supports_void    = excluded.supports_void;
