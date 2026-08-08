/**
 * An escalation is decided, not assumed.
 *
 * Rent rose on every anniversary because the contract said so, and there was
 * nowhere to record that a rise had been held -- a decision landlords make
 * often enough, for a tenant having a hard year or a term still being
 * argued over. Overwriting the base rent would have hidden the decision and
 * broken every past invoice's arithmetic.
 *
 * Each anniversary now gets a row: pending until somebody decides it, then
 * applied at the contract's rate or waived at nothing. Rent is worked out by
 * walking those decisions, so waiving 2027 means the rent stays where it is
 * and the next rise starts from there -- the year that was given away is
 * never charged later.
 *
 * The rows are generated, never typed. What can be edited is the decision.
 */

create type public.escalation_decision as enum ('pending', 'applied', 'waived');

create table public.contract_escalations (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  contract_id    uuid not null references public.contracts (id) on delete cascade,
  /** The anniversary this rise falls on. */
  effective_date date not null,
  decision       public.escalation_decision not null default 'pending',
  /** What was actually applied: the contract's rate, or nothing when waived. */
  rate_percent   numeric(6,3) not null default 0 check (rate_percent >= 0),
  reason         text,
  decided_by     uuid references public.profiles (id),
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  unique (contract_id, effective_date)
);

create index contract_escalations_pending_idx
  on public.contract_escalations (company_id, effective_date)
  where decision = 'pending';

comment on table public.contract_escalations is
  'One row per contract anniversary. Rent is computed by walking these, so a '
  'waived year is never charged later.';

/**
 * Fills in the anniversaries a contract will see, leaving each undecided.
 *
 * Safe to run repeatedly: existing rows keep whatever was decided.
 */
create or replace function public.sync_contract_escalations(p_contract uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.contracts%rowtype;
  v_date date;
  v_index integer := 1;
begin
  select * into c from public.contracts where id = p_contract;
  if not found or coalesce(c.escalation_rate, 0) <= 0 then
    return;
  end if;

  loop
    v_date := (c.start_date + make_interval(years => v_index))::date;
    exit when v_date > c.end_date or v_index > 30;

    insert into public.contract_escalations
      (company_id, contract_id, effective_date, rate_percent)
    values (c.company_id, p_contract, v_date, c.escalation_rate)
    on conflict (contract_id, effective_date) do nothing;

    v_index := v_index + 1;
  end loop;
end;
$$;

create or replace function public.contracts_sync_escalations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_contract_escalations(new.id);
  return null;
end;
$$;

create trigger contracts_escalation_schedule
  after insert or update of start_date, end_date, escalation_rate
  on public.contracts
  for each row execute function public.contracts_sync_escalations();

/**
 * The rent a contract charges on a given day.
 *
 * Walks the anniversaries that have already passed, compounding each by
 * whatever was decided for it. An undecided anniversary counts at the
 * contract's own rate, so nothing changes for a contract nobody has ruled on;
 * a waived one contributes nothing and never comes back.
 *
 * This is the single source billing and every screen read from.
 */
create or replace function public.contract_rent_on(p_contract uuid, p_on date)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c        public.contracts%rowtype;
  v_rent   numeric;
  r        record;
begin
  select * into c from public.contracts where id = p_contract;
  if not found then
    return 0;
  end if;

  v_rent := coalesce(c.monthly_rent, 0);

  for r in
    select e.effective_date, e.decision, e.rate_percent
      from public.contract_escalations e
     where e.contract_id = p_contract
       and e.effective_date <= p_on
     order by e.effective_date
  loop
    if r.decision = 'waived' then
      continue;
    end if;
    -- Undecided anniversaries still rise: the contract says so until
    -- somebody says otherwise.
    v_rent := v_rent * (1 + coalesce(
      case when r.decision = 'applied' then r.rate_percent else c.escalation_rate end,
      0) / 100);
  end loop;

  return round(v_rent, 2);
end;
$$;

grant execute on function public.contract_rent_on(uuid, date) to authenticated;

-- Every contract that already exists gets its anniversaries.
do $$
declare r record;
begin
  for r in select id from public.contracts loop
    perform public.sync_contract_escalations(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security, matching contracts.
-- ---------------------------------------------------------------------------

alter table public.contract_escalations enable row level security;

create policy contract_escalations_read on public.contract_escalations
  for select to authenticated using (public.is_company_member(company_id));

create policy contract_escalations_write on public.contract_escalations
  for all to authenticated
  using      (public.has_permission(company_id, 'contracts', 'edit'))
  with check (public.has_permission(company_id, 'contracts', 'edit'));
