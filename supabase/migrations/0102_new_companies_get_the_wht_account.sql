/**
 * A company created after 0100 never got the Creditable Withholding Tax
 * account.
 *
 * 0100 added account 1450 and linked it, but only to companies that already
 * existed. New ones are built by seed_chart_of_accounts(), which knows a fixed
 * list of accounts and 1450 was not on it -- so the first collection from a
 * withholding tenant on a new company was refused outright by the posting
 * guard, with no way to fix it from the interface.
 *
 * Caught by db-verify, which builds a company from scratch and then tries to
 * collect with tax withheld. It is the sort of gap that only shows up on the
 * second company, which is the worst time to find it.
 */

create or replace function public.seed_chart_of_accounts(p_company uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
begin
  for r in
    select * from (values
      ('1000', 'Cash on Hand',                'asset'),
      ('1010', 'Cash in Bank',                'asset'),
      ('1100', 'Accounts Receivable',         'asset'),
      ('1200', 'Inventory - Supplies',        'asset'),
      ('1300', 'Prepaid Expenses',            'asset'),
      ('1400', 'Input VAT',                   'asset'),
      -- Tax withheld from us by tenants. Creditable against our income tax,
      -- so it is carried as an asset and not written off.
      ('1450', 'Creditable Withholding Tax',  'asset'),
      ('1500', 'Property and Equipment',      'asset'),
      ('2000', 'Accounts Payable',            'liability'),
      ('2100', 'VAT Payable',                 'liability'),
      ('2110', 'Withholding Tax Payable',     'liability'),
      ('2200', 'Security Deposits Payable',   'liability'),
      ('2300', 'Advance Rentals',             'liability'),
      ('3000', 'Owner''s Equity',             'equity'),
      ('3900', 'Retained Earnings',           'equity'),
      ('4000', 'Rental Income',               'income'),
      ('4100', 'Utility Income',              'income'),
      ('4200', 'Parking Income',              'income'),
      ('4300', 'Penalty Income',              'income'),
      ('4900', 'Other Income',                'income'),
      ('4950', 'Sales Allowances',            'income'),
      ('5000', 'Utilities Expense',           'expense'),
      ('5100', 'Repairs and Maintenance',     'expense'),
      ('5200', 'Salaries and Wages',          'expense'),
      ('5300', 'Security Services',           'expense'),
      ('5400', 'Supplies Expense',            'expense'),
      ('5500', 'Taxes and Licenses',          'expense'),
      ('5600', 'Depreciation',                'expense'),
      ('5700', 'Inventory Adjustments',      'expense'),
      ('5900', 'Miscellaneous Expense',       'expense')
    ) as v(code, name, account_type)
  loop
    insert into public.chart_of_accounts (company_id, code, name, account_type)
    values (p_company, r.code, r.name, r.account_type::public.account_type)
    on conflict (company_id, lower(code)) do nothing;
  end loop;

  insert into public.accounting_settings (company_id) values (p_company)
  on conflict (company_id) do nothing;

  update public.accounting_settings s
     set ar_account_id          = coalesce(s.ar_account_id,          public.account_by_code(p_company, '1100')),
         ap_account_id          = coalesce(s.ap_account_id,          public.account_by_code(p_company, '2000')),
         cash_account_id        = coalesce(s.cash_account_id,        public.account_by_code(p_company, '1010')),
         rent_income_id         = coalesce(s.rent_income_id,         public.account_by_code(p_company, '4000')),
         utility_income_id      = coalesce(s.utility_income_id,      public.account_by_code(p_company, '4100')),
         parking_income_id      = coalesce(s.parking_income_id,      public.account_by_code(p_company, '4200')),
         penalty_income_id      = coalesce(s.penalty_income_id,      public.account_by_code(p_company, '4300')),
         other_income_id        = coalesce(s.other_income_id,        public.account_by_code(p_company, '4900')),
         sales_allowance_id     = coalesce(s.sales_allowance_id,     public.account_by_code(p_company, '4950')),
         vat_payable_id         = coalesce(s.vat_payable_id,         public.account_by_code(p_company, '2100')),
         input_vat_id           = coalesce(s.input_vat_id,           public.account_by_code(p_company, '1400')),
         withholding_tax_id     = coalesce(s.withholding_tax_id,     public.account_by_code(p_company, '2110')),
         creditable_wht_id      = coalesce(s.creditable_wht_id,      public.account_by_code(p_company, '1450')),
         inventory_account_id   = coalesce(s.inventory_account_id,   public.account_by_code(p_company, '1200')),
         maintenance_expense_id = coalesce(s.maintenance_expense_id, public.account_by_code(p_company, '5100')),
         inventory_adjustment_id = coalesce(s.inventory_adjustment_id, public.account_by_code(p_company, '5700')),
         default_expense_id     = coalesce(s.default_expense_id,     public.account_by_code(p_company, '5900')),
         security_deposit_id    = coalesce(s.security_deposit_id,    public.account_by_code(p_company, '2200')),
         customer_advances_id   = coalesce(s.customer_advances_id,   public.account_by_code(p_company, '2300')),
         updated_at             = now()
   where s.company_id = p_company;
end;
$fn$;

/*
 * Any company that was seeded between 0100 and now, and so has settings but no
 * link to 1450. Creates the account where it is missing, then links it.
 */
insert into public.chart_of_accounts (company_id, code, name, account_type, description)
select s.company_id, '1450', 'Creditable Withholding Tax', 'asset',
       'Income tax and VAT withheld from us by tenants, supported by the form 2307 they issue. Credited against our income tax.'
  from public.accounting_settings s
 where s.creditable_wht_id is null
on conflict (company_id, lower(code)) do nothing;

update public.accounting_settings s
   set creditable_wht_id = public.account_by_code(s.company_id, '1450')
 where s.creditable_wht_id is null;
