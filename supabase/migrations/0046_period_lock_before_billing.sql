-- Locking a utility period is what makes it billable.
--
-- The sequence is now explicit: open the period, enter the provider bill and
-- the sub-meter readings, lock it, then generate invoices from it. Locking is
-- the moment the figures are declared final -- billing tenants off numbers
-- that can still move is how a building ends up re-billing a month.
--
-- A locked period is frozen. A billed period cannot be unlocked, because the
-- charges have already gone out against it.

/** A period is frozen once it is locked, and once it has been billed. */
create or replace function public.guard_period_frozen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period uuid;
  v_locked boolean;
begin
  if tg_table_name = 'utility_periods' then
    v_period := case when tg_op = 'DELETE' then old.id else new.id end;
    v_locked := case when tg_op = 'DELETE' then old.is_locked else new.is_locked end;
  else
    v_period := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
    select is_locked into v_locked
      from public.utility_periods where id = v_period;
  end if;

  if public.period_is_billed(v_period) then
    raise exception
      'That utility period has already been billed to tenants and is locked. Cancel the invoices raised from it first.'
      using errcode = 'check_violation';
  end if;

  if coalesce(v_locked, false) then
    raise exception
      'That utility period is locked. Unlock it before changing the provider bill or the readings.'
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists utility_periods_guard_billed on public.utility_periods;
create trigger utility_periods_guard_billed
  before update of provider_amount, provider_consumption, genset_expense
  or delete
  on public.utility_periods
  for each row execute function public.guard_period_frozen();

drop trigger if exists meter_readings_guard_billed on public.meter_readings;
create trigger meter_readings_guard_billed
  before insert or update or delete on public.meter_readings
  for each row execute function public.guard_period_frozen();

/** Unlocking is a correction, and a billed period is past correcting. */
create or replace function public.guard_period_unlock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_locked and not new.is_locked and public.period_is_billed(new.id) then
    raise exception
      'That period has been billed to tenants and cannot be unlocked. Cancel the invoices raised from it first.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists utility_periods_guard_unlock on public.utility_periods;
create trigger utility_periods_guard_unlock
  before update of is_locked on public.utility_periods
  for each row execute function public.guard_period_unlock();

-- Periods already billed are locked, so the records agree with the new rule.
update public.utility_periods p
   set is_locked = true
 where not p.is_locked
   and public.period_is_billed(p.id);
