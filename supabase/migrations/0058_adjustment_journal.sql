/**
 * A posted stock adjustment writes a journal entry, like every other posted
 * transaction.
 *
 * post_inventory_movement() returned early for anything that was not an issue
 * or a return, so a count correction moved stock and left the ledger untouched:
 * inventory on the balance sheet no longer agreed with inventory on the shelf,
 * and nothing said why.
 *
 * Corrections need an account of their own. Charging them to Repairs and
 * Maintenance, where issues go, would say the stock was consumed by a repair,
 * which is exactly what a count correction means it was not. 5700 carries both
 * directions so shortages and overages net against each other -- one line
 * saying what stock differences actually cost over a year.
 *
 * An item may override it. Fuel shrinkage and tool shrinkage are not the same
 * conversation, so inventory_items.adjustment_account_id wins when it is set.
 */

alter table public.accounting_settings
  add column if not exists inventory_adjustment_id uuid
    references public.chart_of_accounts (id) on delete set null;

alter table public.inventory_items
  add column if not exists adjustment_account_id uuid
    references public.chart_of_accounts (id) on delete set null;

comment on column public.inventory_items.adjustment_account_id is
  'Where corrections to this item are charged. Falls back to the company''s '
  'inventory adjustment account when not set.';

-- The account itself, for companies that already have a chart.
insert into public.chart_of_accounts (company_id, code, name, account_type)
select c.id, '5700', 'Inventory Adjustments', 'expense'
  from public.companies c
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.code = '5700');

update public.accounting_settings s
   set inventory_adjustment_id =
         coalesce(s.inventory_adjustment_id, public.account_by_code(s.company_id, '5700'));

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------

create or replace function public.post_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s         public.accounting_settings%rowtype;
  v_value   numeric(14, 2);
  v_offset  uuid;
  v_is_adj  boolean;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.inventory_account_id is null then
    return null;
  end if;

  v_value := round(abs(new.quantity) * new.unit_cost, 2);
  if v_value = 0 then
    return null;
  end if;

  /*
   * Anything an adjustment document produced is a correction, whatever kind
   * it carries: stock found during a count is not a purchase, and stock
   * written off is not a repair.
   */
  v_is_adj := new.movement_kind = 'adjustment'
           or new.reference_table = 'inventory_adjustments';

  if v_is_adj then
    select coalesce(i.adjustment_account_id,
                    s.inventory_adjustment_id,
                    public.account_by_code(new.company_id, '5700'))
      into v_offset
      from public.inventory_items i
     where i.id = new.item_id;

    if v_offset is null then
      return null;
    end if;

    if new.quantity > 0 then
      -- Found: the shelf has more than the books said.
      perform public.post_journal(
        new.company_id, new.created_at::date,
        coalesce(new.note, 'Stock adjustment'),
        'inventory_movements', new.id, 'adjustment',
        jsonb_build_array(
          jsonb_build_object('account', s.inventory_account_id,
                             'description', 'Stock found on count',
                             'debit', v_value, 'credit', 0),
          jsonb_build_object('account', v_offset,
                             'description', 'Inventory adjustment',
                             'debit', 0, 'credit', v_value)));
    else
      -- Short: the shelf has less than the books said.
      perform public.post_journal(
        new.company_id, new.created_at::date,
        coalesce(new.note, 'Stock adjustment'),
        'inventory_movements', new.id, 'adjustment',
        jsonb_build_array(
          jsonb_build_object('account', v_offset,
                             'description', 'Inventory adjustment',
                             'debit', v_value, 'credit', 0),
          jsonb_build_object('account', s.inventory_account_id,
                             'description', 'Stock short on count',
                             'debit', 0, 'credit', v_value)));
    end if;

    return null;
  end if;

  if new.movement_kind not in ('issue', 'return') then
    return null;
  end if;

  if new.movement_kind = 'issue' then
    perform public.post_journal(
      new.company_id, new.created_at::date,
      coalesce(new.note, 'Materials issued'),
      'inventory_movements', new.id, 'issue',
      jsonb_build_array(
        jsonb_build_object('account', s.maintenance_expense_id,
                           'description', 'Materials consumed',
                           'debit', v_value, 'credit', 0),
        jsonb_build_object('account', s.inventory_account_id,
                           'description', 'Stock issued',
                           'debit', 0, 'credit', v_value)));
  else
    perform public.post_journal(
      new.company_id, new.created_at::date,
      coalesce(new.note, 'Materials returned'),
      'inventory_movements', new.id, 'return',
      jsonb_build_array(
        jsonb_build_object('account', s.inventory_account_id,
                           'description', 'Stock returned',
                           'debit', v_value, 'credit', 0),
        jsonb_build_object('account', s.maintenance_expense_id,
                           'description', 'Materials returned unused',
                           'debit', 0, 'credit', v_value)));
  end if;

  return null;
end;
$$;

-- New companies get the account with the rest of the chart.
-- Reproduced from 0011 with 5700 added, since a function cannot be appended to.
create or replace function public.seed_chart_of_accounts(p_company uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
         inventory_account_id   = coalesce(s.inventory_account_id,   public.account_by_code(p_company, '1200')),
         maintenance_expense_id = coalesce(s.maintenance_expense_id, public.account_by_code(p_company, '5100')),
         inventory_adjustment_id = coalesce(s.inventory_adjustment_id, public.account_by_code(p_company, '5700')),
         default_expense_id     = coalesce(s.default_expense_id,     public.account_by_code(p_company, '5900')),
         security_deposit_id    = coalesce(s.security_deposit_id,    public.account_by_code(p_company, '2200')),
         customer_advances_id   = coalesce(s.customer_advances_id,   public.account_by_code(p_company, '2300')),
         updated_at             = now()
   where s.company_id = p_company;
end;
$$;
