-- An invoice records which utility period it billed, and a period billed once
-- cannot be billed again.
--
-- Until now a utility line pointed at the meter reading behind it but not at
-- the period, so the invoice could not say which provider bill it was derived
-- from -- and nothing stopped the same period being charged to tenants twice
-- on a second generation run.

alter table public.invoice_lines
  add column if not exists utility_period_id uuid
    references public.utility_periods (id) on delete set null;

create index if not exists invoice_lines_period_idx
  on public.invoice_lines (utility_period_id);

comment on column public.invoice_lines.utility_period_id is
  'The utility period this line was derived from. Null for non-utility lines.';

-- Lines already raised are matched to their period through the reading they
-- came from, which is the same fact by a longer route.
update public.invoice_lines il
   set utility_period_id = mr.period_id
  from public.meter_readings mr
 where il.meter_reading_id = mr.id
   and il.utility_period_id is null;

/**
 * Whether a period has been charged to tenants.
 *
 * Derived rather than flagged, so cancelling the invoice releases the period
 * with no separate bookkeeping to keep in step.
 */
create or replace function public.period_is_billed(p_period uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.invoice_lines il
      join public.invoices i on i.id = il.invoice_id
     where il.utility_period_id = p_period
       and i.status <> 'cancelled');
$$;

comment on function public.period_is_billed is
  'True once a live invoice line was derived from the period.';

/** The provider bill behind a tenant charge cannot move after the fact. */
create or replace function public.guard_period_billed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period uuid;
begin
  v_period := case
    when tg_table_name = 'utility_periods' then
      case when tg_op = 'DELETE' then old.id else new.id end
    else
      case when tg_op = 'DELETE' then old.period_id else new.period_id end
  end;

  if public.period_is_billed(v_period) then
    raise exception
      'That utility period has already been billed to tenants and is locked. Cancel the invoices raised from it first.'
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
  for each row execute function public.guard_period_billed();

drop trigger if exists meter_readings_guard_billed on public.meter_readings;
create trigger meter_readings_guard_billed
  before insert or update or delete on public.meter_readings
  for each row execute function public.guard_period_billed();
