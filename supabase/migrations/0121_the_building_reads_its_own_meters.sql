/**
 * Meters that belong to the building rather than to a tenant.
 *
 * A location has meters of its own -- the water pump, the hallway lights --
 * and it may have solar feeding in. Neither could be recorded: a meter reading
 * must name a unit, and none of these are in one.
 *
 * The consequence was a gap nobody could explain. On BLDG-A in June the
 * provider billed 5,100 kWh and the tenant sub-meters accounted for 2,760, so
 * 46% of the bill sat in a single unlabelled difference that mixed the pump
 * and the lights in with genuine line loss. The only way to recover it was to
 * inflate the rate by hand until the money came out right, which works and
 * explains nothing.
 *
 * Two kinds, because they sit on opposite sides of the sum:
 *
 *   consumption   the building drawing power or water -- pump, lights, lifts
 *   supply        something feeding in that the provider did not bill -- solar
 *
 * Which makes the balance whole:
 *
 *   provider + supply  =  tenants + building consumption + loss
 *
 * Nothing here bills anybody. It records what was read so the figures can be
 * seen, and the rate stays a decision made by a person who can now see what
 * they are deciding about.
 */

create type public.house_meter_direction as enum ('consumption', 'supply');

create table public.house_meters (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  utility     public.utility_kind not null,
  direction   public.house_meter_direction not null default 'consumption',
  label       text not null,
  serial      text,
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.house_meters is
  'Meters belonging to a location rather than a unit: common-area draw, and supply such as solar feeding in.';
comment on column public.house_meters.direction is
  'consumption is the building using it; supply is something feeding in that the provider did not bill.';

create index house_meters_location_idx
  on public.house_meters (location_id, utility, label);

-- One label per utility per location, so two rows cannot both be "Hallway".
create unique index house_meters_label_unique
  on public.house_meters (location_id, utility, lower(label));

alter table public.house_meters enable row level security;

create policy house_meters_read on public.house_meters
  for select to authenticated
  using (public.has_permission(company_id, 'billing.meter_readings', 'view'));

create policy house_meters_write on public.house_meters
  for all to authenticated
  using (public.has_permission(company_id, 'billing.meter_readings', 'edit'))
  with check (public.has_permission(company_id, 'billing.meter_readings', 'edit'));

create trigger house_meters_touch
  before update on public.house_meters
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- What each read over a period
-- ---------------------------------------------------------------------------

create table public.house_meter_readings (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  period_id        uuid not null references public.utility_periods (id) on delete cascade,
  house_meter_id   uuid not null references public.house_meters (id) on delete cascade,
  previous_reading numeric(14, 3) not null default 0 check (previous_reading >= 0),
  present_reading  numeric(14, 3) not null default 0 check (present_reading >= 0),
  reading_date     date not null default current_date,
  notes            text,
  -- Derived, never typed, so it cannot disagree with the meter. The same rule
  -- the tenant readings follow.
  consumption      numeric(14, 3)
                     generated always as (present_reading - previous_reading) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint house_meter_readings_not_backwards
    check (present_reading >= previous_reading)
);

comment on table public.house_meter_readings is
  'A house meter read over one utility period. Explains the gap between the provider bill and the tenant sub-meters.';

create unique index house_meter_readings_unique
  on public.house_meter_readings (period_id, house_meter_id);
create index house_meter_readings_company_idx
  on public.house_meter_readings (company_id);

alter table public.house_meter_readings enable row level security;

create policy house_meter_readings_read on public.house_meter_readings
  for select to authenticated
  using (public.has_permission(company_id, 'billing.meter_readings', 'view'));

create policy house_meter_readings_write on public.house_meter_readings
  for all to authenticated
  using (public.has_permission(company_id, 'billing.meter_readings', 'edit'))
  with check (public.has_permission(company_id, 'billing.meter_readings', 'edit'));

create trigger house_meter_readings_touch
  before update on public.house_meter_readings
  for each row execute function public.set_updated_at();

/*
 * A reading belongs to the period's own location, and to a meter of the same
 * utility. Reading the hallway's water meter into an electricity period would
 * balance to nonsense, and nothing else would catch it.
 */
create or replace function public.guard_house_meter_reading()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_period public.utility_periods%rowtype;
  v_meter  public.house_meters%rowtype;
begin
  select * into v_period from public.utility_periods where id = new.period_id;
  select * into v_meter from public.house_meters where id = new.house_meter_id;

  if v_period.location_id is distinct from v_meter.location_id then
    raise exception 'That meter belongs to another property.'
      using errcode = 'check_violation';
  end if;

  if v_period.utility is distinct from v_meter.utility then
    raise exception 'That is a % meter, and this period is for %.',
      v_meter.utility, v_period.utility
      using errcode = 'check_violation';
  end if;

  if v_period.is_locked then
    raise exception 'This period is locked, so its readings cannot be changed.'
      using errcode = 'check_violation';
  end if;

  new.company_id := v_period.company_id;
  return new;
end;
$fn$;

create trigger house_meter_readings_guard
  before insert or update on public.house_meter_readings
  for each row execute function public.guard_house_meter_reading();

-- ---------------------------------------------------------------------------
-- The balance, in one place
-- ---------------------------------------------------------------------------

/**
 * Where a period's units went.
 *
 *   provider + supply  =  tenants + building + loss
 *
 * Returned as one row per period so every screen that shows this reads the
 * same numbers. Loss is what is left once everything measured is accounted
 * for -- the honest remainder, not a plug.
 */
create or replace function public.utility_balance(p_period uuid)
returns table (
  provider_consumption numeric,
  supply_total         numeric,
  tenant_total         numeric,
  building_total       numeric,
  loss                 numeric
)
language sql
stable
set search_path = public
as $fn$
  select
    up.provider_consumption,
    coalesce(s.supplied, 0)  as supply_total,
    coalesce(t.tenanted, 0)  as tenant_total,
    coalesce(h.used, 0)      as building_total,
    round(
      (up.provider_consumption + coalesce(s.supplied, 0))
      - (coalesce(t.tenanted, 0) + coalesce(h.used, 0)),
      3
    ) as loss
  from public.utility_periods up
  left join lateral (
    select sum(mr.consumption) as tenanted
      from public.meter_readings mr where mr.period_id = up.id
  ) t on true
  left join lateral (
    select sum(hr.consumption) as used
      from public.house_meter_readings hr
      join public.house_meters hm on hm.id = hr.house_meter_id
     where hr.period_id = up.id and hm.direction = 'consumption'
  ) h on true
  left join lateral (
    select sum(hr.consumption) as supplied
      from public.house_meter_readings hr
      join public.house_meters hm on hm.id = hr.house_meter_id
     where hr.period_id = up.id and hm.direction = 'supply'
  ) s on true
  where up.id = p_period;
$fn$;

comment on function public.utility_balance(uuid) is
  'A period reconciled: provider plus supply against tenants plus building, with the remainder as loss.';
