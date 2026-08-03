/**
 * An adjustment line carries its own unit cost.
 *
 * Until now the posting trigger took whatever unit cost happened to be on the
 * item, which is wrong for the case adjustments exist to handle: stock found
 * in the back that was bought at a different price, or an item whose cost was
 * never set and so valued the correction at nothing.
 *
 * The column is nullable on purpose. Left empty, the item's own cost is still
 * used, so nothing that already worked has to change.
 */

alter table public.inventory_adjustment_lines
  add column unit_cost numeric(14,4) check (unit_cost is null or unit_cost >= 0);

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
     -- What was typed on the line wins; the item's cost is the fallback.
     coalesce(new.unit_cost, v_cost, 0),
     'inventory_adjustments', v_head.id,
     coalesce(new.note, v_head.reason), v_head.created_by);

  return null;
end;
$$;
