-- Phase 6 -- in-house accounting: chart of accounts, periods, journal entries,
-- and the balance functions the financial statements are built from.
--
-- Posted entries are immutable (spec 11): corrections are made by reversal,
-- never by editing history.

create type public.account_type as enum (
  'asset',
  'liability',
  'equity',
  'income',
  'expense'
);

create table public.chart_of_accounts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  code         text not null,
  name         text not null,
  account_type public.account_type not null,
  parent_id    uuid references public.chart_of_accounts (id) on delete set null,
  description  text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index chart_of_accounts_code_unique
  on public.chart_of_accounts (company_id, lower(code));
create index chart_of_accounts_type_idx
  on public.chart_of_accounts (company_id, account_type);

/** Assets and expenses increase on the debit side; everything else on credit. */
create or replace function public.is_debit_normal(p_type public.account_type)
returns boolean
language sql
immutable
as $$
  select p_type in ('asset', 'expense');
$$;

create type public.period_status as enum ('open', 'closed');

create table public.accounting_periods (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name       text not null,
  start_date date not null,
  end_date   date not null,
  status     public.period_status not null default 'open',
  closed_at  timestamptz,
  created_at timestamptz not null default now(),
  constraint accounting_periods_dates check (end_date >= start_date)
);

create unique index accounting_periods_unique
  on public.accounting_periods (company_id, start_date);
create index accounting_periods_range_idx
  on public.accounting_periods (company_id, start_date, end_date);

create type public.journal_status as enum ('draft', 'posted', 'reversed');

create table public.journal_entries (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  entry_no      text not null,
  entry_date    date not null default current_date,
  memo          text,
  status        public.journal_status not null default 'draft',
  -- Set when the entry was raised automatically from another module, so the
  -- ledger can always be traced back to the transaction that caused it.
  source_table  text,
  source_id     uuid,
  reverses_id   uuid references public.journal_entries (id) on delete set null,
  posted_at     timestamptz,
  posted_by     uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index journal_entries_no_unique
  on public.journal_entries (company_id, lower(entry_no));
create index journal_entries_date_idx
  on public.journal_entries (company_id, entry_date);
create index journal_entries_source_idx
  on public.journal_entries (source_table, source_id);

create table public.journal_lines (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references public.journal_entries (id) on delete cascade,
  account_id  uuid not null references public.chart_of_accounts (id) on delete restrict,
  description text,
  debit       numeric(14, 2) not null default 0 check (debit >= 0),
  credit      numeric(14, 2) not null default 0 check (credit >= 0),
  sort_order  integer not null default 0,
  -- A line is one side or the other, never both and never neither.
  constraint journal_lines_one_side
    check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);

create index journal_lines_entry_idx on public.journal_lines (entry_id, sort_order);
create index journal_lines_account_idx on public.journal_lines (account_id);

/**
 * Posting checks: the entry must balance, must have lines, and must fall in an
 * open period. Once posted, nothing about the entry may change again.
 */
create or replace function public.guard_journal_entry()
returns trigger
language plpgsql
as $$
declare
  v_debit  numeric(14, 2);
  v_credit numeric(14, 2);
  v_lines  integer;
  v_closed integer;
begin
  if old.status in ('posted', 'reversed')
     and new.status = old.status
     and (new.entry_date is distinct from old.entry_date
       or new.memo      is distinct from old.memo
       or new.entry_no  is distinct from old.entry_no) then
    raise exception 'A posted journal entry cannot be edited. Reverse it instead.'
      using errcode = 'check_violation';
  end if;

  if new.status = 'posted' and old.status = 'draft' then
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      into v_debit, v_credit, v_lines
      from public.journal_lines where entry_id = new.id;

    if v_lines = 0 then
      raise exception 'Add at least two lines before posting.'
        using errcode = 'check_violation';
    end if;

    if v_debit <> v_credit then
      raise exception 'Entry does not balance: debits % vs credits %.', v_debit, v_credit
        using errcode = 'check_violation';
    end if;

    select count(*) into v_closed
      from public.accounting_periods p
     where p.company_id = new.company_id
       and p.status = 'closed'
       and new.entry_date between p.start_date and p.end_date;

    if v_closed > 0 then
      raise exception 'That date falls in a closed accounting period.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger journal_entries_guard
  before update on public.journal_entries
  for each row execute function public.guard_journal_entry();

/** Lines are frozen once the entry leaves draft. */
create or replace function public.guard_journal_lines()
returns trigger
language plpgsql
as $$
declare
  v_status public.journal_status;
begin
  select status into v_status
    from public.journal_entries
   where id = coalesce(new.entry_id, old.entry_id);

  if v_status <> 'draft' then
    raise exception 'Cannot change the lines of a posted journal entry.'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger journal_lines_guard
  before insert or update or delete on public.journal_lines
  for each row execute function public.guard_journal_lines();

/**
 * Trial balance as at a date. Signed to the account's normal side, so assets
 * and expenses read positive on debit balances and the rest on credit.
 */
create or replace function public.trial_balance(
  p_company uuid,
  p_from    date default '1900-01-01',
  p_to      date default '2999-12-31'
)
returns table (
  account_id   uuid,
  code         text,
  name         text,
  account_type public.account_type,
  debit_total  numeric,
  credit_total numeric,
  balance      numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id,
         a.code,
         a.name,
         a.account_type,
         coalesce(sum(l.debit), 0)  as debit_total,
         coalesce(sum(l.credit), 0) as credit_total,
         case when public.is_debit_normal(a.account_type)
              then coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0)
              else coalesce(sum(l.credit), 0) - coalesce(sum(l.debit), 0)
         end as balance
    from public.chart_of_accounts a
    left join public.journal_lines l on l.account_id = a.id
    left join public.journal_entries e
           on e.id = l.entry_id
          and e.status = 'posted'
          and e.entry_date between p_from and p_to
   where a.company_id = p_company
   group by a.id, a.code, a.name, a.account_type
   order by a.code;
$$;

-- ---------------------------------------------------------------------------
-- Automatic posting from the operational modules
-- ---------------------------------------------------------------------------

/**
 * Company-level account mapping, so posting rules do not hardcode account
 * codes. One row per company; each column points at a chart account.
 */
create table public.accounting_settings (
  company_id            uuid primary key references public.companies (id) on delete cascade,
  ar_account_id         uuid references public.chart_of_accounts (id) on delete set null,
  ap_account_id         uuid references public.chart_of_accounts (id) on delete set null,
  cash_account_id       uuid references public.chart_of_accounts (id) on delete set null,
  rent_income_id        uuid references public.chart_of_accounts (id) on delete set null,
  utility_income_id     uuid references public.chart_of_accounts (id) on delete set null,
  other_income_id       uuid references public.chart_of_accounts (id) on delete set null,
  vat_payable_id        uuid references public.chart_of_accounts (id) on delete set null,
  withholding_tax_id    uuid references public.chart_of_accounts (id) on delete set null,
  inventory_account_id  uuid references public.chart_of_accounts (id) on delete set null,
  maintenance_expense_id uuid references public.chart_of_accounts (id) on delete set null,
  security_deposit_id   uuid references public.chart_of_accounts (id) on delete set null,
  updated_at            timestamptz not null default now()
);

/** Seeds a standard Philippine SME chart for a company. Re-runnable. */
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
      ('5000', 'Utilities Expense',           'expense'),
      ('5100', 'Repairs and Maintenance',     'expense'),
      ('5200', 'Salaries and Wages',          'expense'),
      ('5300', 'Security Services',           'expense'),
      ('5400', 'Supplies Expense',            'expense'),
      ('5500', 'Taxes and Licenses',          'expense'),
      ('5600', 'Depreciation',                'expense'),
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
     set ar_account_id          = (select id from public.chart_of_accounts where company_id = p_company and code = '1100'),
         ap_account_id          = (select id from public.chart_of_accounts where company_id = p_company and code = '2000'),
         cash_account_id        = (select id from public.chart_of_accounts where company_id = p_company and code = '1010'),
         rent_income_id         = (select id from public.chart_of_accounts where company_id = p_company and code = '4000'),
         utility_income_id      = (select id from public.chart_of_accounts where company_id = p_company and code = '4100'),
         other_income_id        = (select id from public.chart_of_accounts where company_id = p_company and code = '4900'),
         vat_payable_id         = (select id from public.chart_of_accounts where company_id = p_company and code = '2100'),
         withholding_tax_id     = (select id from public.chart_of_accounts where company_id = p_company and code = '2110'),
         inventory_account_id   = (select id from public.chart_of_accounts where company_id = p_company and code = '1200'),
         maintenance_expense_id = (select id from public.chart_of_accounts where company_id = p_company and code = '5100'),
         security_deposit_id    = (select id from public.chart_of_accounts where company_id = p_company and code = '2200'),
         updated_at             = now()
   where s.company_id = p_company;
end;
$$;

create trigger chart_of_accounts_set_updated_at before update on public.chart_of_accounts
  for each row execute function public.set_updated_at();
create trigger journal_entries_set_updated_at before update on public.journal_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.chart_of_accounts   enable row level security;
alter table public.accounting_periods  enable row level security;
alter table public.journal_entries     enable row level security;
alter table public.journal_lines       enable row level security;
alter table public.accounting_settings enable row level security;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('chart_of_accounts',   'accounting.coa'),
      ('accounting_periods',  'accounting.periods'),
      ('journal_entries',     'accounting.journal'),
      ('accounting_settings', 'accounting.coa')
    ) as v(table_name, module_key)
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (public.is_company_member(company_id))',
      t.table_name || '_read', t.table_name);

    execute format(
      'create policy %I on public.%I for all to authenticated
         using (public.has_permission(company_id, %L, ''edit''))
         with check (public.has_permission(company_id, %L, ''edit''))',
      t.table_name || '_write', t.table_name, t.module_key, t.module_key);
  end loop;
end;
$$;

create policy journal_lines_read on public.journal_lines
  for select to authenticated
  using (exists (select 1 from public.journal_entries e
                  where e.id = journal_lines.entry_id
                    and public.is_company_member(e.company_id)));

create policy journal_lines_write on public.journal_lines
  for all to authenticated
  using (exists (select 1 from public.journal_entries e
                  where e.id = journal_lines.entry_id
                    and public.has_permission(e.company_id, 'accounting.journal', 'edit')))
  with check (exists (select 1 from public.journal_entries e
                  where e.id = journal_lines.entry_id
                    and public.has_permission(e.company_id, 'accounting.journal', 'edit')));
