/**
 * Two faults in how 0119 imported contracts.
 *
 * The first: the floor was stood down and then put back before the work was
 * done. The guard on contract_units is a deferred constraint trigger, so it
 * runs at commit, not at insert -- by which time import_contract() had already
 * cleared its own flag and the floor applied after all. A transaction-local
 * setting goes out with the transaction on its own; clearing it by hand only
 * managed to clear it too early.
 *
 * The second: one contract per call meant one transaction per contract, so a
 * file that failed on line 30 left 29 contracts behind. The form promises that
 * nothing is written unless every row is good, and that promise was not being
 * kept -- the caller was reduced to telling somebody to go and delete what had
 * already landed.
 *
 * Both are fixed by taking the whole file at once. Every contract is written
 * in a single transaction, so the last row failing undoes the first, and the
 * flag lives exactly as long as that transaction does.
 */

drop function if exists public.import_contract(
  uuid, uuid, text, public.contract_status, date, date,
  numeric, numeric, numeric, integer, uuid[], text
);

/**
 * Writes a whole file of contracts, or none of them.
 *
 * Each element of p_rows is one contract:
 *
 *   { tenant, contract_no, status, start, end, rent, deposit,
 *     advance, due_day, notes, units: [uuid, ...] }
 *
 * The rent floor is stood down for the transaction, because these are leases
 * already signed rather than pricing being decided now. Everything else still
 * applies: the numbering series, the occupancy trigger, the period guards.
 */
create or replace function public.import_contracts(
  p_company uuid,
  p_rows    jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row      jsonb;
  v_contract uuid;
  v_unit     jsonb;
  v_made     integer := 0;
begin
  if not public.has_permission(p_company, 'contracts', 'edit') then
    raise exception 'Importing contracts needs Edit on contracts.'
      using errcode = '42501';
  end if;

  /*
   * Set once for the whole transaction and never cleared: it goes out when the
   * transaction ends, which is precisely when the deferred guard has finished
   * with it.
   */
  perform set_config('app.importing_contracts', 'on', true);

  for v_row in select * from jsonb_array_elements(p_rows) loop
    insert into public.contracts (
      company_id, tenant_id, contract_no, status, start_date, end_date,
      monthly_rent, security_deposit, advance_payment, rent_due_day, notes)
    values (
      p_company,
      (v_row ->> 'tenant')::uuid,
      nullif(btrim(coalesce(v_row ->> 'contract_no', '')), ''),
      (v_row ->> 'status')::public.contract_status,
      (v_row ->> 'start')::date,
      (v_row ->> 'end')::date,
      (v_row ->> 'rent')::numeric,
      coalesce((v_row ->> 'deposit')::numeric, 0),
      coalesce((v_row ->> 'advance')::numeric, 0),
      coalesce((v_row ->> 'due_day')::integer, 5),
      nullif(btrim(coalesce(v_row ->> 'notes', '')), ''))
    returning id into v_contract;

    for v_unit in select * from jsonb_array_elements(v_row -> 'units') loop
      insert into public.contract_units (contract_id, unit_id)
      values (v_contract, (v_unit #>> '{}')::uuid);
    end loop;

    v_made := v_made + 1;
  end loop;

  return v_made;
end;
$fn$;

comment on function public.import_contracts(uuid, jsonb) is
  'Writes a whole file of existing leases in one transaction, standing down the rent floor for it. All rows or none.';
