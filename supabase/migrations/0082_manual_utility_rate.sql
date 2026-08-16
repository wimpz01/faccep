/**
 * A rate the building can set, instead of the one the provider's bill implies.
 *
 * The derived rate is the provider's bill divided by the provider's
 * consumption, and charging tenants at exactly that rate guarantees a
 * shortfall: the sub-meters never add up to the main meter. Lifts, corridor
 * lighting, the pumps and plain line loss are all real consumption that no
 * tenant's meter recorded, and at the derived rate the company absorbs every
 * peso of it. On MOLO's June period that is 379.2 kWh and 4,161.54 pesos.
 *
 * So a period may now carry a rate of its own. Set it and tenants are charged
 * at that rate; leave it empty and nothing changes -- the derived rate is still
 * what applies, which is what every existing period will keep doing.
 *
 * It is per period rather than a standing figure because the shortfall moves
 * with the season and the bill. A rate that recovered the loss in June is the
 * wrong rate in December, and a single stored number would quietly go stale.
 *
 * The derived rate is never overwritten. provider_amount and
 * provider_consumption stay exactly as billed, so what the provider charged and
 * what the tenants were charged remain two separate, comparable facts -- which
 * is the whole point of the recovery figure underneath them.
 */

alter table public.utility_periods
  add column if not exists manual_rate numeric(14, 4)
    check (manual_rate is null or manual_rate >= 0);

comment on column public.utility_periods.manual_rate is
  'Rate charged to tenants for this period, overriding the one derived from '
  'the provider bill. Null means charge the derived rate. Set it above the '
  'derived rate to recover system loss and common-area use.';

/**
 * The rate this period actually charges.
 *
 * The manual rate wins when it is set. Everything that bills, reconciles or
 * reports goes through here, so the override cannot apply in one place and be
 * missed in another.
 */
create or replace function public.utility_period_rate(p_period_id uuid)
returns numeric
language sql
stable
as $$
  select coalesce(
           up.manual_rate,
           case
             when up.provider_consumption > 0
               then up.provider_amount / up.provider_consumption
             else 0
           end)
    from public.utility_periods up
   where up.id = p_period_id;
$$;

comment on function public.utility_period_rate(uuid) is
  'What tenants are charged per unit for this period: the manual rate if one '
  'was set, otherwise the provider bill over the provider consumption.';

/**
 * The rate a period is locked with is the rate it was billed at.
 *
 * Locking is what makes a period billable, and once invoices have gone out the
 * rate behind them cannot move -- a tenant's bill would no longer follow from
 * the period it was raised against.
 */
create or replace function public.guard_locked_period_rate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.is_locked
     and new.is_locked
     and new.manual_rate is distinct from old.manual_rate then
    raise exception
      'This period is locked, so the rate it was billed at cannot be changed. Unlock it first.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists utility_periods_guard_rate on public.utility_periods;
create trigger utility_periods_guard_rate
  before update on public.utility_periods
  for each row execute function public.guard_locked_period_rate();
