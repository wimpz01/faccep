-- Phase 2 -- core records: units, tenants and contracts.
--
-- Permission keys reused from the registry seeded in 0003: 'units', 'tenants',
-- 'contracts'. Nothing new is added to public.modules.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.unit_status as enum (
  'vacant',
  'occupied',
  'reserved',
  'inactive'
);

create type public.tenant_status as enum (
  'prospect',
  'active',
  'ended',
  'blacklisted'
);

create type public.contract_status as enum (
  'draft',
  'active',
  'expired',
  'terminated'
);

-- Spec 4.1: fixed, minimum + overage, or pure consumption.
create type public.utility_billing_type as enum (
  'fixed',
  'minimum_overage',
  'consumption'
);

-- Spec 4.1 billing inclusions checklist.
create type public.billing_inclusion as enum (
  'rent',
  'parking',
  'security_guard',
  'water',
  'electricity',
  'other'
);

-- ---------------------------------------------------------------------------
-- Units (spec 5)
-- ---------------------------------------------------------------------------

create table public.units (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete cascade,
  location_id            uuid not null references public.locations (id) on delete restrict,
  code                   text not null,
  floor                  text,
  area_sqm               numeric(10, 2) check (area_sqm is null or area_sqm > 0),
  monthly_rate           numeric(14, 2) not null default 0 check (monthly_rate >= 0),
  status                 public.unit_status not null default 'vacant',
  description            text,
  -- Free-text list, e.g. bed, TV, ref. Kept as an array rather than its own
  -- table because it is only ever read and written whole.
  appliances             text[] not null default '{}',
  water_meter_serial     text,
  electric_meter_serial  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index units_location_code_key
  on public.units (location_id, lower(code));
create index units_company_id_idx on public.units (company_id);
create index units_location_id_idx on public.units (location_id);
create index units_status_idx on public.units (company_id, status);

comment on column public.units.status is
  'Maintained by the contract lifecycle; see sync_unit_status().';

create table public.unit_photos (
  id           uuid primary key default gen_random_uuid(),
  unit_id      uuid not null references public.units (id) on delete cascade,
  storage_path text not null,
  caption      text,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index unit_photos_unit_id_idx on public.unit_photos (unit_id, sort_order);

-- ---------------------------------------------------------------------------
-- Tenants (spec 4.1)
-- ---------------------------------------------------------------------------

create table public.tenants (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  company_name      text not null,
  address           text,
  company_number    text,
  contact_person    text,
  mobile_number     text,
  email             text,
  tin               text,
  -- Spec 4.1: VAT is applied on invoices only for VATable tenants.
  is_vatable        boolean not null default false,
  status            public.tenant_status not null default 'prospect',
  -- Spec 12: abandonment forfeits belongings and blacklists the tenant, which
  -- must block re-onboarding unless deliberately overridden.
  blacklisted_at    timestamptz,
  blacklist_reason  text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint tenants_blacklist_reason_required
    check (status <> 'blacklisted' or blacklist_reason is not null)
);

create unique index tenants_company_name_key
  on public.tenants (company_id, lower(company_name));
create index tenants_company_id_idx on public.tenants (company_id);
create index tenants_status_idx on public.tenants (company_id, status);

-- ---------------------------------------------------------------------------
-- Contracts (spec 4.1, 4.2)
-- ---------------------------------------------------------------------------

create table public.contracts (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete cascade,
  tenant_id                uuid not null references public.tenants (id) on delete restrict,
  contract_no              text not null,
  status                   public.contract_status not null default 'draft',

  start_date               date not null,
  end_date                 date not null,
  term_years               integer not null default 1 check (term_years > 0),

  monthly_rent             numeric(14, 2) not null default 0 check (monthly_rent >= 0),
  security_deposit         numeric(14, 2) not null default 0 check (security_deposit >= 0),
  advance_payment          numeric(14, 2) not null default 0 check (advance_payment >= 0),

  -- Spec 4.1: 0%, 3% or 5%, applied annually to rent and deposit alike.
  escalation_rate          numeric(5, 2) not null default 0
                             check (escalation_rate in (0, 3, 5)),

  -- Spec 6: rent due day of month, and the 2% penalty on unpaid utilities.
  rent_due_day             integer not null default 5
                             check (rent_due_day between 1 and 28),
  penalty_rate             numeric(5, 2) not null default 2
                             check (penalty_rate >= 0),

  water_billing_type       public.utility_billing_type not null default 'consumption',
  water_fixed_amount       numeric(14, 2) check (water_fixed_amount is null or water_fixed_amount >= 0),
  water_minimum_amount     numeric(14, 2) check (water_minimum_amount is null or water_minimum_amount >= 0),

  electric_billing_type    public.utility_billing_type not null default 'consumption',
  electric_fixed_amount    numeric(14, 2) check (electric_fixed_amount is null or electric_fixed_amount >= 0),
  electric_minimum_amount  numeric(14, 2) check (electric_minimum_amount is null or electric_minimum_amount >= 0),

  repair_responsibility    text,
  renewal_terms            text,
  termination_grounds      text,
  notes                    text,

  -- Scanned wet-signed copy (spec 4.2 -- no e-signature).
  signed_document_path     text,
  signed_at                date,

  terminated_at            date,
  termination_reason       text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint contracts_dates_ordered check (end_date > start_date)
);

create unique index contracts_company_no_key
  on public.contracts (company_id, lower(contract_no));
create index contracts_company_id_idx on public.contracts (company_id);
create index contracts_tenant_id_idx on public.contracts (tenant_id);
create index contracts_status_idx on public.contracts (company_id, status);
-- Drives the "contract ending in 6 months" dashboard alert (spec 3).
create index contracts_end_date_idx on public.contracts (company_id, end_date)
  where status = 'active';

-- A tenant profile can hold multiple units (spec 4.1).
create table public.contract_units (
  contract_id uuid not null references public.contracts (id) on delete cascade,
  unit_id     uuid not null references public.units (id) on delete restrict,
  primary key (contract_id, unit_id)
);

create index contract_units_unit_id_idx on public.contract_units (unit_id);

-- Only the items agreed in that tenant's contract appear on their invoice
-- (spec 4.1, spec 6).
create table public.contract_inclusions (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  inclusion   public.billing_inclusion not null,
  label       text,
  amount      numeric(14, 2) check (amount is null or amount >= 0),
  sort_order  integer not null default 0,
  constraint contract_inclusions_other_needs_label
    check (inclusion <> 'other' or label is not null)
);

create unique index contract_inclusions_unique
  on public.contract_inclusions (contract_id, inclusion, coalesce(label, ''));
create index contract_inclusions_contract_idx
  on public.contract_inclusions (contract_id, sort_order);

-- ---------------------------------------------------------------------------
-- Unit occupancy follows the contracts that reference it
-- ---------------------------------------------------------------------------

create or replace function public.sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit_ids uuid[];
begin
  -- Collect the units touched by this statement. OLD and NEW are referenced
  -- through separate branches: touching the unassigned one raises in plpgsql.
  if tg_table_name = 'contract_units' then
    if tg_op = 'DELETE' then
      v_unit_ids := array[old.unit_id];
    else
      v_unit_ids := array[new.unit_id];
    end if;
  else
    select array_agg(cu.unit_id) into v_unit_ids
      from public.contract_units cu
     where cu.contract_id = new.id;
  end if;

  if v_unit_ids is null or cardinality(v_unit_ids) = 0 then
    return null;
  end if;

  -- 'inactive' is set by hand and is never overwritten here.
  update public.units u
     set status = case
                    when exists (
                      select 1
                        from public.contract_units cu
                        join public.contracts c on c.id = cu.contract_id
                       where cu.unit_id = u.id
                         and c.status = 'active'
                    ) then 'occupied'::public.unit_status
                    when exists (
                      select 1
                        from public.contract_units cu
                        join public.contracts c on c.id = cu.contract_id
                       where cu.unit_id = u.id
                         and c.status = 'draft'
                    ) then 'reserved'::public.unit_status
                    else 'vacant'::public.unit_status
                  end
   where u.id = any (v_unit_ids)
     and u.status <> 'inactive';

  return null;  -- AFTER trigger: return value is ignored.
end;
$$;

create trigger contract_units_sync_status
  after insert or delete on public.contract_units
  for each row execute function public.sync_unit_status();

create trigger contracts_sync_unit_status
  after insert or update of status on public.contracts
  for each row execute function public.sync_unit_status();

-- ---------------------------------------------------------------------------
-- Guard: a blacklisted tenant cannot be given a new contract (spec 12)
-- ---------------------------------------------------------------------------

create or replace function public.reject_blacklisted_tenant()
returns trigger
language plpgsql
as $$
declare
  v_status public.tenant_status;
begin
  select status into v_status
    from public.tenants
   where id = new.tenant_id;

  if v_status = 'blacklisted' then
    raise exception
      'Tenant is blacklisted. Clear the blacklist before creating a contract.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger contracts_reject_blacklisted
  before insert on public.contracts
  for each row execute function public.reject_blacklisted_tenant();

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger units_set_updated_at before update on public.units
  for each row execute function public.set_updated_at();
create trigger tenants_set_updated_at before update on public.tenants
  for each row execute function public.set_updated_at();
create trigger contracts_set_updated_at before update on public.contracts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Same shape as locations in 0002: readable by any company member because
-- billing, maintenance and reporting all need to resolve unit and tenant
-- names, with writes gated on the owning module's permission.
-- ---------------------------------------------------------------------------

alter table public.units               enable row level security;
alter table public.unit_photos         enable row level security;
alter table public.tenants             enable row level security;
alter table public.contracts           enable row level security;
alter table public.contract_units      enable row level security;
alter table public.contract_inclusions enable row level security;

-- units ---------------------------------------------------------------------
create policy units_read on public.units
  for select to authenticated
  using (public.is_company_member(company_id));

create policy units_insert on public.units
  for insert to authenticated
  with check (public.has_permission(company_id, 'units', 'edit'));

create policy units_update on public.units
  for update to authenticated
  using (public.has_permission(company_id, 'units', 'edit'))
  with check (public.has_permission(company_id, 'units', 'edit'));

create policy units_delete on public.units
  for delete to authenticated
  using (public.has_permission(company_id, 'units', 'delete'));

-- unit_photos ---------------------------------------------------------------
create policy unit_photos_read on public.unit_photos
  for select to authenticated
  using (exists (
    select 1 from public.units u
     where u.id = unit_photos.unit_id
       and public.is_company_member(u.company_id)
  ));

create policy unit_photos_write on public.unit_photos
  for all to authenticated
  using (exists (
    select 1 from public.units u
     where u.id = unit_photos.unit_id
       and public.has_permission(u.company_id, 'units', 'edit')
  ))
  with check (exists (
    select 1 from public.units u
     where u.id = unit_photos.unit_id
       and public.has_permission(u.company_id, 'units', 'edit')
  ));

-- tenants -------------------------------------------------------------------
create policy tenants_read on public.tenants
  for select to authenticated
  using (public.is_company_member(company_id));

create policy tenants_insert on public.tenants
  for insert to authenticated
  with check (public.has_permission(company_id, 'tenants', 'edit'));

create policy tenants_update on public.tenants
  for update to authenticated
  using (public.has_permission(company_id, 'tenants', 'edit'))
  with check (public.has_permission(company_id, 'tenants', 'edit'));

-- Spec 2: once a tenant is set up, only an admin may delete the record.
-- Grant 'delete' on the tenants module sparingly.
create policy tenants_delete on public.tenants
  for delete to authenticated
  using (public.has_permission(company_id, 'tenants', 'delete'));

-- contracts -----------------------------------------------------------------
create policy contracts_read on public.contracts
  for select to authenticated
  using (public.is_company_member(company_id));

create policy contracts_insert on public.contracts
  for insert to authenticated
  with check (public.has_permission(company_id, 'contracts', 'edit'));

create policy contracts_update on public.contracts
  for update to authenticated
  using (public.has_permission(company_id, 'contracts', 'edit'))
  with check (public.has_permission(company_id, 'contracts', 'edit'));

create policy contracts_delete on public.contracts
  for delete to authenticated
  using (public.has_permission(company_id, 'contracts', 'delete'));

-- contract_units ------------------------------------------------------------
create policy contract_units_read on public.contract_units
  for select to authenticated
  using (exists (
    select 1 from public.contracts c
     where c.id = contract_units.contract_id
       and public.is_company_member(c.company_id)
  ));

create policy contract_units_write on public.contract_units
  for all to authenticated
  using (exists (
    select 1 from public.contracts c
     where c.id = contract_units.contract_id
       and public.has_permission(c.company_id, 'contracts', 'edit')
  ))
  with check (exists (
    select 1 from public.contracts c
     where c.id = contract_units.contract_id
       and public.has_permission(c.company_id, 'contracts', 'edit')
  ));

-- contract_inclusions -------------------------------------------------------
create policy contract_inclusions_read on public.contract_inclusions
  for select to authenticated
  using (exists (
    select 1 from public.contracts c
     where c.id = contract_inclusions.contract_id
       and public.is_company_member(c.company_id)
  ));

create policy contract_inclusions_write on public.contract_inclusions
  for all to authenticated
  using (exists (
    select 1 from public.contracts c
     where c.id = contract_inclusions.contract_id
       and public.has_permission(c.company_id, 'contracts', 'edit')
  ))
  with check (exists (
    select 1 from public.contracts c
     where c.id = contract_inclusions.contract_id
       and public.has_permission(c.company_id, 'contracts', 'edit')
  ));
