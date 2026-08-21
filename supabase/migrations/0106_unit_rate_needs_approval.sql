/**
 * A unit's monthly rate is set and changed only with approval.
 *
 * The rate is the number every lease is priced from, so moving it quietly
 * moves the value of the property. Until now anyone with Edit on units could
 * type a new figure and save it.
 *
 * Now the figure on the unit is the *approved* rate, and nothing else can
 * write to it. Proposing a rate -- whether on a unit being created or one that
 * has been let for years -- raises a row here instead, and the unit only moves
 * when somebody with Approve on units signs it off.
 *
 * The guard is a trigger rather than a rule the forms obey, so it holds
 * whatever writes to the table: the unit form, the CSV import, a script, or a
 * query typed by hand.
 *
 * The table doubles as the rate history. A leasing business needs to know what
 * a unit was priced at and when it moved, and that history is exactly the list
 * of approved changes.
 */

create type public.rate_change_status as enum ('pending', 'approved', 'rejected');

create table public.unit_rate_changes (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  unit_id       uuid not null references public.units (id) on delete cascade,
  -- What the unit stood at when this was proposed, kept so the history reads
  -- without having to reconstruct it from the row before.
  current_rate  numeric(14, 2) not null,
  proposed_rate numeric(14, 2) not null check (proposed_rate >= 0),
  status        public.rate_change_status not null default 'pending',
  reason        text,
  requested_by  uuid references public.profiles (id) on delete set null,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  -- The rate a unit is created with. Its unit has no approved rate yet, which
  -- is what stops it being let before anyone has agreed the price.
  is_initial    boolean not null default false,
  constraint unit_rate_changes_decided_together
    check ((status = 'pending') = (decided_at is null))
);

comment on table public.unit_rate_changes is
  'Proposed changes to a unit monthly rate, and once approved the history of what it has been.';
comment on column public.unit_rate_changes.is_initial is
  'The first rate proposed for a unit. Until it is approved the unit has no agreed price and cannot be let.';

-- One open proposal per unit; a second would race the first.
create unique index unit_rate_changes_one_pending
  on public.unit_rate_changes (unit_id)
  where status = 'pending';

create index unit_rate_changes_unit_idx
  on public.unit_rate_changes (unit_id, requested_at desc);

alter table public.unit_rate_changes enable row level security;

create policy unit_rate_changes_read on public.unit_rate_changes
  for select to authenticated
  using (public.has_permission(company_id, 'units', 'view'));

create policy unit_rate_changes_write on public.unit_rate_changes
  for all to authenticated
  using (public.has_permission(company_id, 'units', 'edit'))
  with check (public.has_permission(company_id, 'units', 'edit'));

-- ---------------------------------------------------------------------------
-- Nothing writes the rate except an approval
-- ---------------------------------------------------------------------------

/**
 * The rate on a unit may only move through apply_unit_rate_change().
 *
 * That function sets a flag for the duration of its own transaction; any other
 * writer finds the flag unset and is refused. Doing it this way rather than by
 * revoking column privileges keeps the rule with the reason for it, and keeps
 * it working for the service role, which bypasses row-level security.
 */
create or replace function public.guard_unit_rate()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    /*
     * A unit starts with no agreed price whatever the writer sent. The figure
     * asked for is set aside here and raised as a proposal after the insert.
     *
     * Captured by the trigger rather than by the caller on purpose: a CSV
     * import or a hand-written insert knows nothing about any of this, and
     * would otherwise have its rate quietly reset to nought with no proposal
     * raised and nothing to show for it.
     */
    if new.monthly_rate is distinct from 0 then
      perform set_config('app.requested_unit_rate', new.monthly_rate::text, true);
      new.monthly_rate := 0;
    else
      perform set_config('app.requested_unit_rate', '', true);
    end if;
    return new;
  end if;

  if new.monthly_rate is distinct from old.monthly_rate
     and coalesce(current_setting('app.applying_rate_change', true), '') <> 'on' then
    raise exception
      'A unit monthly rate is changed by approval, not directly. Propose the new rate on the unit and have it signed off.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger units_guard_rate
  before insert or update on public.units
  for each row execute function public.guard_unit_rate();

/**
 * A unit created with a rate raises that rate as its first proposal.
 *
 * The unit itself is created at once -- there is no sense in holding back the
 * unit record while a price is agreed -- but it carries no approved rate, so
 * it cannot be put on a contract until the figure is signed off.
 *
 * A unit created at nought proposes nothing. Nought is the absence of a rate,
 * not a price anyone needs to agree, and such a unit is lettable at any rent.
 */
create or replace function public.propose_initial_unit_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_asked numeric(14, 2);
begin
  -- What the writer asked for, before the guard reset it to nought.
  v_asked := coalesce(nullif(current_setting('app.requested_unit_rate', true), '')::numeric, 0);

  if v_asked > 0 then
    insert into public.unit_rate_changes (
      company_id, unit_id, current_rate, proposed_rate, reason,
      requested_by, is_initial)
    values (
      new.company_id, new.id, 0, v_asked, 'Rate set when the unit was created',
      auth.uid(), true);
  end if;

  -- Cleared so the next unit in the same transaction does not inherit it.
  perform set_config('app.requested_unit_rate', '', true);
  return null;
end;
$fn$;

create trigger units_propose_initial_rate
  after insert on public.units
  for each row execute function public.propose_initial_unit_rate();

-- ---------------------------------------------------------------------------
-- Proposing and deciding
-- ---------------------------------------------------------------------------

/** Raises a proposal to move a unit's rate. */
create or replace function public.propose_unit_rate(
  p_unit uuid,
  p_rate numeric,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_unit public.units%rowtype;
  v_id   uuid;
begin
  select * into v_unit from public.units where id = p_unit;
  if not found then
    raise exception 'That unit no longer exists.';
  end if;

  if not public.has_permission(v_unit.company_id, 'units', 'edit') then
    raise exception 'Proposing a rate needs Edit on units.'
      using errcode = '42501';
  end if;

  if p_rate is null or p_rate < 0 then
    raise exception 'Enter a rate of nought or more.';
  end if;

  if p_rate = v_unit.monthly_rate then
    raise exception 'That is the rate the unit already carries.';
  end if;

  insert into public.unit_rate_changes (
    company_id, unit_id, current_rate, proposed_rate, reason, requested_by,
    -- A unit that has never had a rate approved is still setting its first.
    is_initial)
  values (
    v_unit.company_id, p_unit, v_unit.monthly_rate, p_rate, p_reason, auth.uid(),
    v_unit.monthly_rate = 0
      and not exists (
        select 1 from public.unit_rate_changes
         where unit_id = p_unit and status = 'approved'
      ))
  returning id into v_id;

  return v_id;
end;
$fn$;

/**
 * Signs off or turns down a proposal.
 *
 * Approving is the only path by which a unit's rate moves; the flag it sets
 * is what the guard above looks for, and it lasts only for this transaction.
 */
create or replace function public.decide_unit_rate_change(
  p_change uuid,
  p_approve boolean,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_change public.unit_rate_changes%rowtype;
begin
  select * into v_change from public.unit_rate_changes where id = p_change;
  if not found then
    raise exception 'That rate change no longer exists.';
  end if;

  if v_change.status <> 'pending' then
    raise exception 'That rate change has already been decided.';
  end if;

  if not public.has_permission(v_change.company_id, 'units', 'approve') then
    raise exception 'Deciding a rate change needs Approve on units.'
      using errcode = '42501';
  end if;

  update public.unit_rate_changes
     set status = case when p_approve then 'approved' else 'rejected' end
                    ::public.rate_change_status,
         decided_by = auth.uid(),
         decided_at = now(),
         decision_note = p_note
   where id = p_change;

  if p_approve then
    perform set_config('app.applying_rate_change', 'on', true);
    update public.units
       set monthly_rate = v_change.proposed_rate
     where id = v_change.unit_id;
    perform set_config('app.applying_rate_change', '', true);
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- The rates already on file
-- ---------------------------------------------------------------------------

/*
 * Every unit that already carries a rate keeps it, recorded as approved on the
 * day this came in. Nothing is re-approved retrospectively -- these figures
 * were agreed under the old arrangement and restating them as pending would
 * make every let unit unlettable overnight.
 */
insert into public.unit_rate_changes (
  company_id, unit_id, current_rate, proposed_rate, status, reason,
  requested_at, decided_at, is_initial)
select u.company_id, u.id, u.monthly_rate, u.monthly_rate, 'approved',
       'Rate in force before rate changes required approval',
       now(), now(), true
  from public.units u
 where u.monthly_rate > 0;
