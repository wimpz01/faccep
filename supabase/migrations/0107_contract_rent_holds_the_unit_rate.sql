/**
 * A contract may not be priced below the rate agreed for its units.
 *
 * The unit's monthly rate is the floor the property is let at. Above it is a
 * commercial decision; below it gives the rate away, which is the whole reason
 * moving that rate now takes approval. Without this the approval could be
 * sidestepped by leaving the rate alone and simply signing a cheaper lease.
 *
 * Three things this deliberately does not do.
 *
 * It does not touch a contract already signed. The check runs when the rent or
 * the units change, so a contract that predates this rule keeps its terms and
 * can still be edited in every other respect. One such contract exists today
 * -- CT-2026-0003, let at 18,500 against a unit rated 20,000 -- and it is left
 * exactly as it stands.
 *
 * It does not reach back when a unit's rate is raised. A landlord raising the
 * asking price does not thereby break the leases already running at the old
 * one; those move at renewal, on their own terms.
 *
 * It does not bind a unit with no rate. Nought is the absence of a price
 * rather than a price of nothing, so such a unit accepts any rent -- which is
 * what keeps the units carrying no rate today lettable.
 */

/**
 * The floor for a contract: the rates of the units it covers, added up.
 *
 * A contract over several units is one rent for the lot, so the figure it has
 * to clear is the total of what those units are rated at.
 */
create or replace function public.contract_rent_floor(p_contract uuid)
returns numeric
language sql
stable
set search_path = public
as $fn$
  select coalesce(sum(u.monthly_rate), 0)
    from public.contract_units cu
    join public.units u on u.id = cu.unit_id
   where cu.contract_id = p_contract;
$fn$;

comment on function public.contract_rent_floor(uuid) is
  'Total of the approved rates of the units on a contract. The least the contract may be let for.';

/**
 * Refuses a rent below the floor, and a unit whose price nobody has agreed.
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
  if tg_table_name = 'contracts' then
    /*
     * Only when the money or the term changes. A contract signed before this
     * rule keeps its terms, and editing its notes must not fail because of a
     * price agreed long ago.
     */
    if tg_op = 'UPDATE' and new.monthly_rent is not distinct from old.monthly_rent then
      return new;
    end if;
    v_contract := new.id;
    v_rent := new.monthly_rent;
  else
    v_contract := coalesce(new.contract_id, old.contract_id);
    select monthly_rent into v_rent from public.contracts where id = v_contract;
  end if;

  /*
   * A unit whose rate has been proposed but never approved has no agreed price
   * to hold the contract to, so it cannot be let yet. A unit simply carrying
   * nought is a different thing and is allowed.
   */
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

/*
 * On the contract for the rent, and on the link table for the units, since
 * either can put a contract below its floor. The link trigger is deferred to
 * the end of the statement so that a contract and its units may be written in
 * one go without the check firing before the rent is there to read.
 */
create constraint trigger contract_units_hold_rate
  after insert or update or delete on public.contract_units
  deferrable initially deferred
  for each row execute function public.guard_contract_rent();

create trigger contracts_hold_unit_rate
  before insert or update of monthly_rent on public.contracts
  for each row execute function public.guard_contract_rent();
