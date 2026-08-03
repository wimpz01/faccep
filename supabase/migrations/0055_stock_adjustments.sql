/**
 * Stock adjustment becomes a transaction with a number of its own.
 *
 * Until now an adjustment was a bare row in the movement ledger: no reference
 * to quote, no way to group the three items counted in the same stock take,
 * and nothing linking them. It is now a document -- ADJ-2026-0001, issued on
 * save like GR and CV numbers -- carrying as many item lines as the count
 * needed.
 *
 * The lines are what post to the ledger. A trigger writes each one into
 * inventory_movements stamped with the adjustment it came from, so stock on
 * hand still derives from movements alone and nothing has to be kept in step
 * by hand.
 */

create table public.inventory_adjustments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  adjustment_no   text not null,
  adjustment_date date not null default current_date,
  reason          text,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now(),
  unique (company_id, adjustment_no)
);

create table public.inventory_adjustment_lines (
  id            uuid primary key default gen_random_uuid(),
  adjustment_id uuid not null
                  references public.inventory_adjustments (id) on delete cascade,
  item_id       uuid not null references public.inventory_items (id),
  movement_kind public.stock_movement_kind not null,
  -- Signed, exactly as the ledger stores it: in is positive, out is negative.
  quantity      numeric(14,3) not null check (quantity <> 0),
  note          text
);

create index inventory_adjustment_lines_adjustment_idx
  on public.inventory_adjustment_lines (adjustment_id);
create index inventory_adjustments_company_idx
  on public.inventory_adjustments (company_id, adjustment_date desc);

-- ---------------------------------------------------------------------------
-- The number is issued by the database, never chosen by the caller.
-- ---------------------------------------------------------------------------

create or replace function public.assign_adjustment_no()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.adjustment_no is null or new.adjustment_no = '' then
    new.adjustment_no := public.next_document_no(
      new.company_id,
      'stock_adjustment',
      'ADJ',
      extract(year from coalesce(new.adjustment_date, current_date))::integer,
      4
    );
  end if;
  return new;
end;
$$;

create trigger inventory_adjustments_number
  before insert on public.inventory_adjustments
  for each row execute function public.assign_adjustment_no();

-- ---------------------------------------------------------------------------
-- A line has to point the way its kind says it does.
-- ---------------------------------------------------------------------------

create or replace function public.guard_adjustment_line()
returns trigger
language plpgsql
as $$
begin
  if new.movement_kind in ('receipt', 'return') and new.quantity < 0 then
    raise exception 'A % puts stock back, so its quantity cannot be negative.',
      new.movement_kind
      using errcode = 'check_violation';
  end if;

  if new.movement_kind = 'issue' and new.quantity > 0 then
    raise exception 'An issue takes stock out, so its quantity must be negative.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger inventory_adjustment_lines_guard
  before insert or update on public.inventory_adjustment_lines
  for each row execute function public.guard_adjustment_line();

-- ---------------------------------------------------------------------------
-- Posting: the line is the source, the ledger is the consequence.
-- ---------------------------------------------------------------------------

create or replace function public.post_adjustment_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_head public.inventory_adjustments%rowtype;
  v_cost numeric;
begin
  select * into v_head from public.inventory_adjustments where id = new.adjustment_id;
  select unit_cost into v_cost from public.inventory_items where id = new.item_id;

  insert into public.inventory_movements
    (company_id, item_id, movement_kind, quantity, unit_cost,
     reference_table, reference_id, note, created_by)
  values
    (v_head.company_id, new.item_id, new.movement_kind, new.quantity,
     coalesce(v_cost, 0), 'inventory_adjustments', v_head.id,
     coalesce(new.note, v_head.reason), v_head.created_by);

  return null;
end;
$$;

create trigger inventory_adjustment_lines_post
  after insert on public.inventory_adjustment_lines
  for each row execute function public.post_adjustment_line();

-- ---------------------------------------------------------------------------
-- Stock cannot go below nothing, and the database is what says so.
--
-- The check existed only in the server action, which meant it held for the
-- form and not for anything else that writes a movement.
-- ---------------------------------------------------------------------------

create or replace function public.guard_stock_never_negative()
returns trigger
language plpgsql
as $$
declare
  v_on_hand numeric;
  v_name    text;
begin
  select coalesce(sum(quantity), 0) into v_on_hand
    from public.inventory_movements where item_id = new.item_id;

  if v_on_hand < 0 then
    select name into v_name from public.inventory_items where id = new.item_id;
    raise exception
      'That would leave % at % on hand. Stock cannot go below nothing.',
      coalesce(v_name, 'this item'), to_char(v_on_hand, 'FM999999990.###')
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

-- Deferred to the end of the transaction so an adjustment is judged on what it
-- nets out to. Issuing 5 and receiving 10 in one document is fine even though
-- the ledger dips while the lines are still going in.
create constraint trigger inventory_movements_never_negative
  after insert or update on public.inventory_movements
  deferrable initially deferred
  for each row execute function public.guard_stock_never_negative();

-- ---------------------------------------------------------------------------
-- Row-level security, matching the other inventory tables.
-- ---------------------------------------------------------------------------

alter table public.inventory_adjustments      enable row level security;
alter table public.inventory_adjustment_lines enable row level security;

create policy inventory_adjustments_read on public.inventory_adjustments
  for select to authenticated using (public.is_company_member(company_id));

create policy inventory_adjustments_write on public.inventory_adjustments
  for all to authenticated
  using      (public.has_permission(company_id, 'inventory.movements', 'edit'))
  with check (public.has_permission(company_id, 'inventory.movements', 'edit'));

create policy inventory_adjustment_lines_read on public.inventory_adjustment_lines
  for select to authenticated
  using (exists (
    select 1 from public.inventory_adjustments a
     where a.id = adjustment_id and public.is_company_member(a.company_id)));

create policy inventory_adjustment_lines_write on public.inventory_adjustment_lines
  for all to authenticated
  using (exists (
    select 1 from public.inventory_adjustments a
     where a.id = adjustment_id
       and public.has_permission(a.company_id, 'inventory.movements', 'edit')))
  with check (exists (
    select 1 from public.inventory_adjustments a
     where a.id = adjustment_id
       and public.has_permission(a.company_id, 'inventory.movements', 'edit')));
