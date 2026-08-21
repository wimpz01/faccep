/**
 * Tax rates stop being constants and become a setting.
 *
 * Until now a BIR rate lived in two places that had no way of knowing about
 * each other: withholding_rate() in 0035 and WITHHOLDING_KINDS in the
 * purchasing constants. Both said "goods 1%, services 2%". Nothing kept them
 * saying the same thing, and neither could be changed without a deployment --
 * which is the wrong answer for numbers the BIR revises by circular.
 *
 * They now live in one table the company can edit. The two rates that were
 * hard-coded are seeded with exactly the values they had, so nothing about
 * existing bills changes.
 *
 * The table also carries the rates that apply the other way round -- what a
 * tenant withholds from rent it pays us. Those have never been in the system
 * at all; the collection side is built on top of them in 0101.
 *
 * Rates here are current, not historical. A document that has already been
 * raised keeps the figures it was raised with (an invoice stamps its own
 * vat_rate, a supplier bill stores its computed withholding_tax), so editing
 * a rate moves the next document and never an old one.
 */

create type public.tax_rate_kind as enum (
  -- What we withhold from a supplier when we pay them.
  'supplier_withholding',
  -- What a tenant withholds from us when they pay their rent.
  'tenant_withholding'
);

create table public.tax_rates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind       public.tax_rate_kind not null,
  code       text not null,
  label      text not null,
  rate       numeric(6, 3) not null check (rate >= 0 and rate <= 100),
  -- The BIR alphanumeric tax code, printed on form 2307. Reference only.
  atc        text,
  note       text,
  is_active  boolean not null default true,
  sort       integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (company_id, kind, code)
);

comment on table public.tax_rates is
  'Editable BIR rates. Current values only -- raised documents keep the rate they were raised with.';
comment on column public.tax_rates.code is
  'Stable key the code matches on. The label may be reworded; this may not.';
comment on column public.tax_rates.atc is
  'BIR alphanumeric tax code, e.g. WC100 for rental. Printed on form 2307.';

create index tax_rates_company_idx on public.tax_rates (company_id, kind, sort);

alter table public.tax_rates enable row level security;

create policy tax_rates_read on public.tax_rates
  for select to authenticated
  using (public.has_permission(company_id, 'accounting.tax', 'view'));

create policy tax_rates_write on public.tax_rates
  for all to authenticated
  using (public.has_permission(company_id, 'accounting.tax', 'edit'))
  with check (public.has_permission(company_id, 'accounting.tax', 'edit'));

create trigger tax_rates_touch
  before update on public.tax_rates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

/*
 * The supplier rates are seeded at exactly the values withholding_rate()
 * returned, so no existing bill is recomputed to a different figure.
 *
 * The tenant rates are new. 5% on rent is RR 2-98 sec 2.57.2(A)(8): the
 * lessee withholds it from gross rental, net of VAT, and hands over a 2307.
 * Government lessees withhold a further 5% of the VAT, creditable rather than
 * final since 1 January 2021 (TRAIN sec 37, amending NIRC sec 114(C)).
 */
insert into public.tax_rates (company_id, kind, code, label, rate, atc, note, sort)
select c.id, v.kind, v.code, v.label, v.rate, v.atc, v.note, v.sort
  from public.companies c
  cross join (values
    ('supplier_withholding'::public.tax_rate_kind, 'goods', 'Goods', 1.0, 'WC158',
     'Withheld from a supplier of goods.', 10),
    ('supplier_withholding'::public.tax_rate_kind, 'services', 'Services', 2.0, 'WC160',
     'Withheld from a supplier of services.', 20),
    ('tenant_withholding'::public.tax_rate_kind, 'rental', 'Rental income tax', 5.0, 'WC100',
     'Withheld by the tenant from rent, computed on the amount net of VAT. Creditable against our income tax; the tenant issues BIR form 2307.', 10),
    ('tenant_withholding'::public.tax_rate_kind, 'government_vat', 'Government VAT', 5.0, 'WV010',
     'Withheld only by a government tenant, on the VAT. Creditable rather than final since 1 January 2021.', 20)
  ) as v(kind, code, label, rate, atc, note, sort)
on conflict (company_id, kind, code) do nothing;

-- Any company made later starts with the same rates.
create or replace function public.seed_tax_rates()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.tax_rates (company_id, kind, code, label, rate, atc, note, sort)
  select new.id, v.kind, v.code, v.label, v.rate, v.atc, v.note, v.sort
    from (values
      ('supplier_withholding'::public.tax_rate_kind, 'goods', 'Goods', 1.0, 'WC158',
       'Withheld from a supplier of goods.', 10),
      ('supplier_withholding'::public.tax_rate_kind, 'services', 'Services', 2.0, 'WC160',
       'Withheld from a supplier of services.', 20),
      ('tenant_withholding'::public.tax_rate_kind, 'rental', 'Rental income tax', 5.0, 'WC100',
       'Withheld by the tenant from rent, computed on the amount net of VAT.', 10),
      ('tenant_withholding'::public.tax_rate_kind, 'government_vat', 'Government VAT', 5.0, 'WV010',
       'Withheld only by a government tenant, on the VAT.', 20)
    ) as v(kind, code, label, rate, atc, note, sort)
  on conflict (company_id, kind, code) do nothing;
  return null;
end;
$fn$;

create trigger companies_seed_tax_rates
  after insert on public.companies
  for each row execute function public.seed_tax_rates();

-- ---------------------------------------------------------------------------
-- withholding_rate() reads the setting
-- ---------------------------------------------------------------------------

/**
 * The rate we withhold from a supplier, as a percentage.
 *
 * Falls back to the figures this function was born with when the company has
 * no row -- deliberately. A missing setting must not quietly become 0%, which
 * would under-withhold and leave the company owing the BIR the difference.
 */
create or replace function public.withholding_rate(
  p_company uuid,
  p_kind public.withholding_kind
)
returns numeric
language sql
stable
set search_path = public
as $fn$
  select coalesce(
    (select r.rate
       from public.tax_rates r
      where r.company_id = p_company
        and r.kind = 'supplier_withholding'
        and r.code = p_kind::text
        and r.is_active),
    case p_kind
      when 'goods'    then 1.0
      when 'services' then 2.0
      else 0.0
    end
  )::numeric;
$fn$;

comment on function public.withholding_rate(uuid, public.withholding_kind) is
  'Supplier withholding rate from tax_rates, falling back to the statutory defaults so a missing setting never reads as 0%.';

-- Supplier bills now compute from the setting rather than the constant.
create or replace function public.sync_supplier_invoice_totals(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_gross    numeric(14, 2);
  v_net      numeric(14, 2);
  v_vat      numeric(14, 2);
  v_ewt      numeric(14, 2);
  v_invoice  record;
  v_vatable  boolean;
begin
  select si.*, v.is_vatable
    into v_invoice
    from public.supplier_invoices si
    join public.vendors v on v.id = si.vendor_id
   where si.id = p_invoice;

  if not found then
    return;
  end if;

  select coalesce(round(sum(amount), 2), 0)
    into v_gross
    from public.supplier_invoice_lines
   where invoice_id = p_invoice;

  -- No lines means the bill was entered as a single figure; leave it alone.
  if v_gross = 0 then
    return;
  end if;

  v_vatable := v_invoice.is_vatable;

  if v_vatable and v_invoice.vat_rate > 0 then
    v_net := round(v_gross / (1 + v_invoice.vat_rate / 100), 2);
    v_vat := round(v_gross - v_net, 2);
  else
    v_net := v_gross;
    v_vat := 0;
  end if;

  -- Expanded withholding is computed on the VAT-exclusive base.
  if v_vatable then
    v_ewt := round(
      v_net * public.withholding_rate(v_invoice.company_id, v_invoice.charge_kind) / 100,
      2);
  else
    v_ewt := 0;
  end if;

  update public.supplier_invoices
     set amount          = v_net,
         vat_amount      = v_vat,
         withholding_tax = v_ewt,
         total           = round(v_net + v_vat - v_ewt, 2)
   where id = p_invoice;
end;
$fn$;

-- The single-argument form is left in place so nothing that still calls it
-- breaks, but it is no longer the one the system uses.
comment on function public.withholding_rate(public.withholding_kind) is
  'Superseded by withholding_rate(company, kind), which reads the editable setting. Kept only so older call sites keep working.';

-- ---------------------------------------------------------------------------
-- Where tax withheld from us is held
-- ---------------------------------------------------------------------------

/*
 * Tax a tenant withholds from our rent is not lost money -- it is paid to the
 * BIR on our behalf and credited against our income tax. It is an asset, and
 * it needs an account of its own; Input VAT is a different tax and Withholding
 * Tax Payable is the opposite direction (what we owe on suppliers' behalf).
 */
insert into public.chart_of_accounts (company_id, code, name, account_type, description)
select c.id, '1450', 'Creditable Withholding Tax', 'asset',
       'Income tax and VAT withheld from us by tenants, supported by the form 2307 they issue. Credited against our income tax.'
  from public.companies c
-- Matches chart_of_accounts_code_unique, which is on lower(code).
on conflict (company_id, lower(code)) do nothing;

alter table public.accounting_settings
  add column if not exists creditable_wht_id uuid references public.chart_of_accounts (id);

comment on column public.accounting_settings.creditable_wht_id is
  'Asset account for tax withheld from us by tenants.';

update public.accounting_settings s
   set creditable_wht_id = a.id
  from public.chart_of_accounts a
 where a.company_id = s.company_id
   and a.code = '1450'
   and s.creditable_wht_id is null;
