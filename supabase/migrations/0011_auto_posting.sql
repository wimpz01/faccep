-- Automatic posting: the operational modules now write their own journal
-- entries, so the ledger stays in step without re-keying.
--
-- Design rules, applied throughout:
--
--   * Posting is done by database triggers, not application code, so it cannot
--     be skipped by a code path that forgets to call it.
--   * Every posting is tagged with (source_table, source_id, source_event) and
--     a partial unique index makes a second posting of the same event
--     impossible. Re-running is a no-op rather than a double entry.
--   * Nothing is ever un-posted. A cancellation or void writes a reversing
--     entry, exactly as a manual correction would.
--   * If accounting is not configured for a company (no AR account mapped),
--     posting is skipped silently so the billing modules still work standalone.
--     If it IS configured but a required account is missing, posting raises --
--     a half-configured chart is a mistake worth surfacing, not hiding.

-- ---------------------------------------------------------------------------
-- Extra account mappings
-- ---------------------------------------------------------------------------

alter table public.accounting_settings
  add column if not exists parking_income_id     uuid references public.chart_of_accounts (id) on delete set null,
  add column if not exists penalty_income_id     uuid references public.chart_of_accounts (id) on delete set null,
  add column if not exists sales_allowance_id    uuid references public.chart_of_accounts (id) on delete set null,
  add column if not exists input_vat_id          uuid references public.chart_of_accounts (id) on delete set null,
  add column if not exists customer_advances_id  uuid references public.chart_of_accounts (id) on delete set null,
  add column if not exists default_expense_id    uuid references public.chart_of_accounts (id) on delete set null;

-- Two accounts the original chart did not carry.
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
         default_expense_id     = coalesce(s.default_expense_id,     public.account_by_code(p_company, '5900')),
         security_deposit_id    = coalesce(s.security_deposit_id,    public.account_by_code(p_company, '2200')),
         customer_advances_id   = coalesce(s.customer_advances_id,   public.account_by_code(p_company, '2300')),
         updated_at             = now()
   where s.company_id = p_company;
end;
$$;

create or replace function public.account_by_code(p_company uuid, p_code text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.chart_of_accounts
   where company_id = p_company and lower(code) = lower(p_code);
$$;

-- ---------------------------------------------------------------------------
-- Posting plumbing
-- ---------------------------------------------------------------------------

alter table public.journal_entries
  add column if not exists source_event text;

-- One posting per source event, ever.
create unique index if not exists journal_entries_source_event_unique
  on public.journal_entries (company_id, source_table, source_id, source_event)
  where source_table is not null and source_event is not null;

create or replace function public.next_journal_no(p_company uuid, p_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text := 'JV-' || extract(year from p_date)::int || '-';
  v_last   text;
  v_next   integer;
begin
  select entry_no into v_last
    from public.journal_entries
   where company_id = p_company and entry_no like v_prefix || '%'
   order by entry_no desc
   limit 1;

  v_next := coalesce(nullif(regexp_replace(coalesce(v_last, ''), '^.*-', ''), '')::integer, 0) + 1;
  return v_prefix || lpad(v_next::text, 5, '0');
end;
$$;

/**
 * Creates and posts one journal entry from a jsonb array of lines, each
 * {account, debit, credit, description}.
 *
 * Returns the entry id, or NULL when there was nothing to post or the same
 * source event has already been posted.
 */
create or replace function public.post_journal(
  p_company      uuid,
  p_date         date,
  p_memo         text,
  p_source_table text,
  p_source_id    uuid,
  p_source_event text,
  p_lines        jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry   uuid;
  v_line    jsonb;
  v_order   integer := 0;
  v_debit   numeric(14, 2) := 0;
  v_credit  numeric(14, 2) := 0;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return null;
  end if;

  -- Already posted for this event: nothing to do.
  if exists (
    select 1 from public.journal_entries
     where company_id = p_company
       and source_table = p_source_table
       and source_id = p_source_id
       and source_event = p_source_event
  ) then
    return null;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_debit  := v_debit  + coalesce((v_line ->> 'debit')::numeric, 0);
    v_credit := v_credit + coalesce((v_line ->> 'credit')::numeric, 0);
  end loop;

  if round(v_debit, 2) = 0 and round(v_credit, 2) = 0 then
    return null;
  end if;

  insert into public.journal_entries
    (company_id, entry_no, entry_date, memo, source_table, source_id, source_event)
  values (p_company, public.next_journal_no(p_company, p_date), p_date, p_memo,
          p_source_table, p_source_id, p_source_event)
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_line ->> 'debit')::numeric, 0) = 0
       and coalesce((v_line ->> 'credit')::numeric, 0) = 0 then
      continue;
    end if;

    insert into public.journal_lines
      (entry_id, account_id, description, debit, credit, sort_order)
    values (v_entry,
            (v_line ->> 'account')::uuid,
            v_line ->> 'description',
            round(coalesce((v_line ->> 'debit')::numeric, 0), 2),
            round(coalesce((v_line ->> 'credit')::numeric, 0), 2),
            v_order);
    v_order := v_order + 1;
  end loop;

  -- The guard trigger re-checks the balance and the period on the way through.
  update public.journal_entries
     set status = 'posted', posted_at = now()
   where id = v_entry;

  return v_entry;
end;
$$;

/** Writes a reversing entry for a previously posted source event. */
create or replace function public.reverse_posting(
  p_company      uuid,
  p_source_table text,
  p_source_id    uuid,
  p_source_event text,
  p_reason       text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.journal_entries%rowtype;
  v_lines    jsonb;
begin
  select * into v_original
    from public.journal_entries
   where company_id = p_company
     and source_table = p_source_table
     and source_id = p_source_id
     and source_event = p_source_event
     and status = 'posted';

  if not found then
    return;
  end if;

  select jsonb_agg(jsonb_build_object(
           'account', l.account_id,
           'description', l.description,
           'debit', l.credit,      -- swapped
           'credit', l.debit
         ) order by l.sort_order)
    into v_lines
    from public.journal_lines l
   where l.entry_id = v_original.id;

  perform public.post_journal(
    p_company,
    current_date,
    'Reversal of ' || v_original.entry_no || ': ' || p_reason,
    p_source_table,
    p_source_id,
    p_source_event || ':reversal',
    v_lines
  );

  update public.journal_entries set status = 'reversed' where id = v_original.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

/**
 * Releasing an invoice:
 *   DR Accounts Receivable   total
 *     CR income accounts     per line kind
 *     CR VAT Payable         output tax
 */
create or replace function public.post_invoice_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_lines jsonb := '[]'::jsonb;
  r record;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ar_account_id is null then
    return null;  -- accounting not in use for this company
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.reverse_posting(
      new.company_id, 'invoices', new.id, 'release',
      coalesce(new.cancellation_reason, 'cancelled'));
    return null;
  end if;

  if not (old.status = 'draft' and new.status = 'released') then
    return null;
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', s.ar_account_id,
    'description', 'Invoice ' || new.invoice_no,
    'debit', new.total, 'credit', 0));

  for r in
    select line_kind, sum(amount) as amount
      from public.invoice_lines
     where invoice_id = new.id
     group by line_kind
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', case r.line_kind
                   when 'rent'           then s.rent_income_id
                   when 'parking'        then coalesce(s.parking_income_id, s.other_income_id)
                   when 'water'          then s.utility_income_id
                   when 'electricity'    then s.utility_income_id
                   when 'genset'         then s.utility_income_id
                   when 'penalty'        then coalesce(s.penalty_income_id, s.other_income_id)
                   else s.other_income_id
                 end,
      'description', initcap(replace(r.line_kind, '_', ' ')),
      'debit', 0, 'credit', r.amount));
  end loop;

  if new.vat_amount > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.vat_payable_id,
      'description', 'Output VAT',
      'debit', 0, 'credit', new.vat_amount));
  end if;

  perform public.post_journal(
    new.company_id, new.invoice_date,
    'Invoice ' || new.invoice_no || ' released',
    'invoices', new.id, 'release', v_lines);

  return null;
end;
$$;

create trigger invoices_post_to_ledger
  after update of status on public.invoices
  for each row execute function public.post_invoice_release();

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

/**
 * Money in lands in Customer Advances first:
 *   DR Cash   amount
 *     CR Customer Advances
 *
 * Each application then moves it to receivables (see below). A prepayment
 * simply never gets applied, which is exactly what the advance account means.
 *
 * A refund is the other way round, against the deposit liability.
 */
create or replace function public.post_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_lines jsonb;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ar_account_id is null then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.status = 'voided' and old.status <> 'voided' then
      perform public.reverse_posting(
        new.company_id, 'payments', new.id, 'receipt',
        coalesce(new.void_reason, 'voided'));
    end if;
    return null;
  end if;

  if new.payment_kind = 'refund' then
    v_lines := jsonb_build_array(
      jsonb_build_object('account', s.security_deposit_id,
                         'description', 'Refund ' || new.payment_no,
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.cash_account_id,
                         'description', 'Cash paid out',
                         'debit', 0, 'credit', new.amount));
  else
    v_lines := jsonb_build_array(
      jsonb_build_object('account', s.cash_account_id,
                         'description', 'Receipt ' || new.payment_no,
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.customer_advances_id,
                         'description', 'Unapplied customer credit',
                         'debit', 0, 'credit', new.amount));
  end if;

  perform public.post_journal(
    new.company_id, new.payment_date,
    'Payment ' || new.payment_no,
    'payments', new.id, 'receipt', v_lines);

  return null;
end;
$$;

create trigger payments_post_to_ledger
  after insert or update of status on public.payments
  for each row execute function public.post_payment();

/**
 * Applying a receipt to an invoice moves it off the advance account:
 *   DR Customer Advances
 *     CR Accounts Receivable
 */
create or replace function public.post_payment_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
begin
  select * into v_payment from public.payments where id = coalesce(new.payment_id, old.payment_id);
  select * into s from public.accounting_settings where company_id = v_payment.company_id;
  if not found or s.ar_account_id is null then
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.reverse_posting(
      v_payment.company_id, 'payment_applications', old.id, 'apply', 'application removed');
    return null;
  end if;

  select * into v_invoice from public.invoices where id = new.invoice_id;

  perform public.post_journal(
    v_payment.company_id, v_payment.payment_date,
    'Applied ' || v_payment.payment_no || ' to ' || v_invoice.invoice_no,
    'payment_applications', new.id, 'apply',
    jsonb_build_array(
      jsonb_build_object('account', s.customer_advances_id,
                         'description', 'Applied to ' || v_invoice.invoice_no,
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.ar_account_id,
                         'description', 'Settlement of ' || v_invoice.invoice_no,
                         'debit', 0, 'credit', new.amount)));

  return null;
end;
$$;

create trigger payment_applications_post_to_ledger
  after insert or delete on public.payment_applications
  for each row execute function public.post_payment_application();

-- ---------------------------------------------------------------------------
-- Credit memos
-- ---------------------------------------------------------------------------

/**
 *   DR Sales Allowances
 *     CR Accounts Receivable
 */
create or replace function public.post_credit_memo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_invoice public.invoices%rowtype;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ar_account_id is null then
    return null;
  end if;

  select * into v_invoice from public.invoices where id = new.invoice_id;

  perform public.post_journal(
    new.company_id, new.memo_date,
    'Credit memo ' || new.memo_no || ' against ' || v_invoice.invoice_no,
    'credit_memos', new.id, 'issue',
    jsonb_build_array(
      jsonb_build_object('account', coalesce(s.sales_allowance_id, s.other_income_id),
                         'description', new.reason,
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.ar_account_id,
                         'description', 'Credit to ' || v_invoice.invoice_no,
                         'debit', 0, 'credit', new.amount)));

  return null;
end;
$$;

create trigger credit_memos_post_to_ledger
  after insert on public.credit_memos
  for each row execute function public.post_credit_memo();

-- ---------------------------------------------------------------------------
-- Supplier invoices and vouchers
-- ---------------------------------------------------------------------------

/**
 *   DR Expense (or Inventory when the bill is against a purchase order)
 *   DR Input VAT
 *     CR Withholding Tax Payable
 *     CR Accounts Payable
 */
create or replace function public.post_supplier_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_debit_account uuid;
  v_lines jsonb;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ap_account_id is null then
    return null;
  end if;

  v_debit_account := case
    when new.job_id is not null then s.maintenance_expense_id
    when new.po_id is not null  then s.inventory_account_id
    else s.default_expense_id
  end;

  v_lines := jsonb_build_array(
    jsonb_build_object('account', v_debit_account,
                       'description', 'Supplier invoice ' || new.invoice_no,
                       'debit', new.amount, 'credit', 0));

  if new.vat_amount > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.input_vat_id, 'description', 'Input VAT',
      'debit', new.vat_amount, 'credit', 0));
  end if;

  if new.withholding_tax > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.withholding_tax_id, 'description', 'Creditable tax withheld',
      'debit', 0, 'credit', new.withholding_tax));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', s.ap_account_id, 'description', 'Payable to supplier',
    'debit', 0, 'credit', new.total));

  perform public.post_journal(
    new.company_id, new.invoice_date,
    'Supplier invoice ' || new.invoice_no,
    'supplier_invoices', new.id, 'accrue', v_lines);

  return null;
end;
$$;

create trigger supplier_invoices_post_to_ledger
  after insert on public.supplier_invoices
  for each row execute function public.post_supplier_invoice();

/**
 *   DR Accounts Payable
 *     CR Cash
 */
create or replace function public.post_voucher_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ap_account_id is null then
    return null;
  end if;

  if new.status = 'cancelled' and old.status = 'released' then
    perform public.reverse_posting(
      new.company_id, 'check_vouchers', new.id, 'release', 'voucher cancelled');
    return null;
  end if;

  if not (new.status = 'released' and old.status <> 'released') then
    return null;
  end if;

  perform public.post_journal(
    new.company_id, new.voucher_date,
    'Voucher ' || new.voucher_no,
    'check_vouchers', new.id, 'release',
    jsonb_build_array(
      jsonb_build_object('account', s.ap_account_id,
                         'description', 'Settlement of supplier balances',
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.cash_account_id,
                         'description', coalesce('Cheque ' || new.check_no, 'Cash paid'),
                         'debit', 0, 'credit', new.amount)));

  return null;
end;
$$;

create trigger check_vouchers_post_to_ledger
  after update of status on public.check_vouchers
  for each row execute function public.post_voucher_release();

-- ---------------------------------------------------------------------------
-- Inventory issued to maintenance
-- ---------------------------------------------------------------------------

/**
 * Material leaving the store is an expense; material coming back reverses it.
 *   DR Repairs and Maintenance
 *     CR Inventory
 */
create or replace function public.post_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_value numeric(14, 2);
begin
  if new.movement_kind not in ('issue', 'return') then
    return null;
  end if;

  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.inventory_account_id is null then
    return null;
  end if;

  v_value := round(abs(new.quantity) * new.unit_cost, 2);
  if v_value = 0 then
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

create trigger inventory_movements_post_to_ledger
  after insert on public.inventory_movements
  for each row execute function public.post_inventory_movement();
