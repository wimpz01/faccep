-- Payment terms become a setting, and a supplier records its tax treatment.
--
-- Terms were free text, so "30 days", "30days" and "Net 30" were three
-- different things and none of them carried a day count anything could use.
-- They are now a per-company list with the number of days on them.
--
-- Withholding: BIR expanded withholding tax on income payments to suppliers is
-- 1% on goods and 2% on services. It only arises where the supplier is
-- VAT-registered, so the rate is only meaningful alongside that flag.

create table public.payment_terms (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name       text not null,
  days       integer not null default 0 check (days >= 0),
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index payment_terms_unique
  on public.payment_terms (company_id, lower(name));

alter table public.payment_terms enable row level security;

create policy payment_terms_read on public.payment_terms
  for select using (public.has_permission(company_id, 'purchasing.vendors', 'view'));
create policy payment_terms_write on public.payment_terms
  for all using (public.has_permission(company_id, 'purchasing.vendors', 'edit'))
  with check (public.has_permission(company_id, 'purchasing.vendors', 'edit'));

comment on table public.payment_terms is
  'How long a supplier gives us to pay. Days drives the due date on a bill.';

-- The terms every company starts with; extend or retire them per company.
insert into public.payment_terms (company_id, name, days, sort_order)
select c.id, t.name, t.days, t.sort_order
  from public.companies c
  cross join (values
    ('Cash on delivery',  0, 10),
    ('7 days',            7, 20),
    ('15 days',          15, 30),
    ('30 days',          30, 40),
    ('45 days',          45, 50),
    ('60 days',          60, 60)
  ) as t(name, days, sort_order)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Supplier tax treatment
-- ---------------------------------------------------------------------------

create type public.withholding_kind as enum ('none', 'goods', 'services');

alter table public.vendors
  add column if not exists payment_terms_id uuid
    references public.payment_terms (id) on delete set null,
  add column if not exists is_vatable boolean not null default false,
  add column if not exists withholding public.withholding_kind not null default 'none';

-- Carry across any free text that already matches a term by name.
update public.vendors v
   set payment_terms_id = t.id
  from public.payment_terms t
 where t.company_id = v.company_id
   and lower(t.name) = lower(btrim(coalesce(v.payment_terms, '')))
   and v.payment_terms_id is null;

alter table public.vendors drop column if exists payment_terms;

-- Withholding only arises on a VAT-registered supplier.
alter table public.vendors
  add constraint vendors_withholding_needs_vat
    check (withholding = 'none' or is_vatable);

comment on column public.vendors.is_vatable is
  'VAT-registered supplier. Their bills carry input VAT.';
comment on column public.vendors.withholding is
  'Expanded withholding tax: goods 1%, services 2%, none = not withheld.';

/** The BIR rate for a withholding kind, as a percentage. */
create or replace function public.withholding_rate(p_kind public.withholding_kind)
returns numeric
language sql
immutable
as $$
  select case p_kind
           when 'goods'    then 1.0
           when 'services' then 2.0
           else 0.0
         end::numeric;
$$;
