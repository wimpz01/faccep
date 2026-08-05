/**
 * An adjustment can be saved before it is posted, and its type belongs to the
 * document rather than to each line.
 *
 * Two changes that have to happen together:
 *
 * The type moves onto the header. A stock take is a count correction and a
 * found pallet is a receipt; mixing both under one number described neither,
 * so one document now carries one kind and every line follows it.
 *
 * Posting stops being a side effect of adding a line. Lines used to write
 * straight to the ledger as they were inserted, which left no moment at which
 * a document existed but had not yet moved stock -- exactly the moment
 * "save and think about it" needs. A draft now holds its lines and touches
 * nothing; posting is what writes the ledger, all lines at once.
 */

alter table public.inventory_adjustments
  add column status text not null default 'draft'
    check (status in ('draft', 'posted')),
  add column movement_kind public.stock_movement_kind not null default 'adjustment',
  add column posted_at timestamptz;

-- The kind now lives on the document, so the line no longer keeps its own.
drop trigger if exists inventory_adjustment_lines_post on public.inventory_adjustment_lines;
drop function if exists public.post_adjustment_line();
alter table public.inventory_adjustment_lines drop column movement_kind;

-- ---------------------------------------------------------------------------
-- A line has to face the way the document's kind says it does, and it can
-- only be touched while the document is still a draft.
-- ---------------------------------------------------------------------------

create or replace function public.guard_adjustment_line()
returns trigger
language plpgsql
as $$
declare
  v_row  public.inventory_adjustment_lines%rowtype;
  v_head public.inventory_adjustments%rowtype;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select * into v_head from public.inventory_adjustments
   where id = v_row.adjustment_id;

  if v_head.status <> 'draft' then
    raise exception
      'Adjustment % is already posted, so its lines can no longer be changed.',
      v_head.adjustment_no
      using errcode = 'check_violation';
  end if;

  if tg_op <> 'DELETE' then
    if v_head.movement_kind in ('receipt', 'return') and new.quantity < 0 then
      raise exception 'A % puts stock back, so its quantity cannot be negative.',
        v_head.movement_kind
        using errcode = 'check_violation';
    end if;

    if v_head.movement_kind = 'issue' and new.quantity > 0 then
      raise exception 'An issue takes stock out, so its quantity must be negative.'
        using errcode = 'check_violation';
    end if;
  end if;

  return v_row;
end;
$$;

drop trigger if exists inventory_adjustment_lines_guard on public.inventory_adjustment_lines;
create trigger inventory_adjustment_lines_guard
  before insert or update or delete on public.inventory_adjustment_lines
  for each row execute function public.guard_adjustment_line();

-- ---------------------------------------------------------------------------
-- Posting is what writes the ledger, and it happens once.
-- ---------------------------------------------------------------------------

create or replace function public.post_adjustment_document()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lines integer;
begin
  if old.status = 'posted' and new.status <> 'posted' then
    raise exception
      'A posted adjustment cannot be taken back. Post a correcting one instead.'
      using errcode = 'check_violation';
  end if;

  if new.status = 'posted' and old.status = 'draft' then
    select count(*) into v_lines
      from public.inventory_adjustment_lines where adjustment_id = new.id;

    if v_lines = 0 then
      raise exception 'Add at least one item line before posting %.',
        new.adjustment_no
        using errcode = 'check_violation';
    end if;

    insert into public.inventory_movements
      (company_id, item_id, movement_kind, quantity, unit_cost,
       reference_table, reference_id, note, created_by)
    select new.company_id, l.item_id, new.movement_kind, l.quantity,
           -- What was typed on the line wins; the item's cost is the fallback.
           coalesce(l.unit_cost, i.unit_cost, 0),
           'inventory_adjustments', new.id,
           coalesce(l.note, new.reason), new.created_by
      from public.inventory_adjustment_lines l
      join public.inventory_items i on i.id = l.item_id
     where l.adjustment_id = new.id;

    new.posted_at := now();
  end if;

  return new;
end;
$$;

create trigger inventory_adjustments_post
  before update on public.inventory_adjustments
  for each row execute function public.post_adjustment_document();
