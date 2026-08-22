/**
 * Loading a portfolio that already exists.
 *
 * Two rules stand in the way of importing history, and both are right for
 * day-to-day work:
 *
 *   a unit's rate moves only with approval (0106)
 *   a contract may not be priced below its unit's rate (0107)
 *
 * Neither is about history. A lease signed three years ago at a rent that has
 * since been outgrown is a fact, not a decision anyone is making now, and
 * refusing to record it would leave the books incomplete -- which is worse
 * than the thing the rule protects against.
 *
 * So a contract may be written below the floor while an import is running, and
 * only while one is running. The flag is set inside import_contract() and
 * lasts for that transaction alone; nothing else can set it, and no form or
 * ordinary insert can reach it.
 *
 * Rates are not given the same treatment and do not need it. An imported rate
 * goes through the proposal the trigger already raises and is then signed off
 * by the importer, who must hold Approve on units to import a rate at all. The
 * control is kept rather than bypassed: the history shows a rate proposed and
 * approved, with who did it.
 */

create or replace function public.guard_contract_rent()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_contract uuid;
  v_rent     numeric(14, 2);
  v_floor    numeric(14, 2);
  v_unpriced text;
begin
  /*
   * An import is loading what was already agreed, not pricing anything, so the
   * floor does not apply to it. Set only by import_contract(), and only for
   * the duration of its own transaction.
   */
  if coalesce(current_setting('app.importing_contracts', true), '') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'contracts' then
    if tg_op = 'UPDATE' and new.monthly_rent is not distinct from old.monthly_rent then
      return new;
    end if;
    v_contract := new.id;
    v_rent := new.monthly_rent;
  else
    v_contract := coalesce(new.contract_id, old.contract_id);
    select monthly_rent into v_rent from public.contracts where id = v_contract;
  end if;

  select string_agg(u.code, ', ' order by u.code)
    into v_unpriced
    from public.contract_units cu
    join public.units u on u.id = cu.unit_id
   where cu.contract_id = v_contract
     and u.monthly_rate = 0
     and exists (
       select 1 from public.unit_rate_changes rc
        where rc.unit_id = u.id and rc.status = 'pending'
     );

  if v_unpriced is not null then
    raise exception
      'Unit % is waiting on its rate being approved, so it cannot be put on a contract yet.',
      v_unpriced
      using errcode = 'check_violation';
  end if;

  v_floor := public.contract_rent_floor(v_contract);

  if v_floor > 0 and coalesce(v_rent, 0) < v_floor - 0.005 then
    raise exception
      'The rent of % is below the % this unit is rated at. A higher rent is fine; a lower one needs the unit rate changed first, with approval.',
      to_char(coalesce(v_rent, 0), 'FM999,999,990.00'),
      to_char(v_floor, 'FM999,999,990.00')
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$fn$;

/**
 * Writes one contract and the units it covers, as part of an import.
 *
 * Exists so the floor can be stood down for exactly this and nothing else. The
 * flag is set here, the rows are written, and it goes out with the
 * transaction; there is no way to hold it open or reach it from a form.
 *
 * Everything else about a contract still applies -- the number series, the
 * status, the occupancy trigger that marks a unit taken.
 */
create or replace function public.import_contract(
  p_company     uuid,
  p_tenant      uuid,
  p_contract_no text,
  p_status      public.contract_status,
  p_start       date,
  p_end         date,
  p_rent        numeric,
  p_deposit     numeric,
  p_advance     numeric,
  p_due_day     integer,
  p_units       uuid[],
  p_notes       text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_contract uuid;
  v_unit     uuid;
begin
  if not public.has_permission(p_company, 'contracts', 'edit') then
    raise exception 'Importing contracts needs Edit on contracts.'
      using errcode = '42501';
  end if;

  perform set_config('app.importing_contracts', 'on', true);

  insert into public.contracts (
    company_id, tenant_id, contract_no, status, start_date, end_date,
    monthly_rent, security_deposit, advance_payment, rent_due_day, notes)
  values (
    p_company, p_tenant, nullif(btrim(p_contract_no), ''), p_status, p_start, p_end,
    p_rent, coalesce(p_deposit, 0), coalesce(p_advance, 0),
    coalesce(p_due_day, 5), nullif(btrim(p_notes), ''))
  returning id into v_contract;

  foreach v_unit in array coalesce(p_units, '{}'::uuid[]) loop
    insert into public.contract_units (contract_id, unit_id)
    values (v_contract, v_unit);
  end loop;

  perform set_config('app.importing_contracts', '', true);

  return v_contract;
end;
$fn$;

comment on function public.import_contract is
  'Writes a contract and its units while loading history, standing down the rent floor for that transaction only.';
