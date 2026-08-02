-- The billed-period guard failed with 'record "old" has no field "period_id"'.
--
-- A CASE expression does not defer field resolution on a record: every branch
-- is resolved against the row at hand, so the meter_readings branch was being
-- looked up on utility_periods too. The two shapes need separate statements.

create or replace function public.guard_period_billed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period uuid;
begin
  if tg_table_name = 'utility_periods' then
    if tg_op = 'DELETE' then
      v_period := old.id;
    else
      v_period := new.id;
    end if;
  else
    if tg_op = 'DELETE' then
      v_period := old.period_id;
    else
      v_period := new.period_id;
    end if;
  end if;

  if public.period_is_billed(v_period) then
    raise exception
      'That utility period has already been billed to tenants and is locked. Cancel the invoices raised from it first.'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
