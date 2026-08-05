/**
 * Gives the movements that were posted before 0058 the entries they never got,
 * and makes the posting logic callable rather than trigger-only.
 *
 * ADJ-2026-0004 moved stock while post_inventory_movement() still returned
 * early for count corrections, so it left no journal entry. The trigger fires
 * on insert alone, so there was no way to ask for the posting again.
 *
 * The logic now lives in a function that takes a movement id. The trigger
 * calls it, and so can a repair. post_journal() already refuses to post the
 * same (source_table, source_id, source_event) twice, so running the backfill
 * again is a no-op rather than a double entry.
 */

create or replace function public.post_inventory_movement_row(p_movement uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m         public.inventory_movements%rowtype;
  s         public.accounting_settings%rowtype;
  v_value   numeric(14, 2);
  v_offset  uuid;
  v_is_adj  boolean;
begin
  select * into m from public.inventory_movements where id = p_movement;
  if not found then
    return;
  end if;

  select * into s from public.accounting_settings where company_id = m.company_id;
  if not found or s.inventory_account_id is null then
    return;
  end if;

  v_value := round(abs(m.quantity) * m.unit_cost, 2);
  if v_value = 0 then
    return;
  end if;

  -- Anything an adjustment document produced is a correction, whatever kind it
  -- carries: stock found during a count is not a purchase, and stock written
  -- off is not a repair.
  v_is_adj := m.movement_kind = 'adjustment'
           or m.reference_table = 'inventory_adjustments';

  if v_is_adj then
    select coalesce(i.adjustment_account_id,
                    s.inventory_adjustment_id,
                    public.account_by_code(m.company_id, '5700'))
      into v_offset
      from public.inventory_items i
     where i.id = m.item_id;

    if v_offset is null then
      return;
    end if;

    if m.quantity > 0 then
      perform public.post_journal(
        m.company_id, m.created_at::date,
        coalesce(m.note, 'Stock adjustment'),
        'inventory_movements', m.id, 'adjustment',
        jsonb_build_array(
          jsonb_build_object('account', s.inventory_account_id,
                             'description', 'Stock found on count',
                             'debit', v_value, 'credit', 0),
          jsonb_build_object('account', v_offset,
                             'description', 'Inventory adjustment',
                             'debit', 0, 'credit', v_value)));
    else
      perform public.post_journal(
        m.company_id, m.created_at::date,
        coalesce(m.note, 'Stock adjustment'),
        'inventory_movements', m.id, 'adjustment',
        jsonb_build_array(
          jsonb_build_object('account', v_offset,
                             'description', 'Inventory adjustment',
                             'debit', v_value, 'credit', 0),
          jsonb_build_object('account', s.inventory_account_id,
                             'description', 'Stock short on count',
                             'debit', 0, 'credit', v_value)));
    end if;
    return;
  end if;

  if m.movement_kind = 'issue' then
    perform public.post_journal(
      m.company_id, m.created_at::date,
      coalesce(m.note, 'Materials issued'),
      'inventory_movements', m.id, 'issue',
      jsonb_build_array(
        jsonb_build_object('account', s.maintenance_expense_id,
                           'description', 'Materials consumed',
                           'debit', v_value, 'credit', 0),
        jsonb_build_object('account', s.inventory_account_id,
                           'description', 'Stock issued',
                           'debit', 0, 'credit', v_value)));
  elsif m.movement_kind = 'return' then
    perform public.post_journal(
      m.company_id, m.created_at::date,
      coalesce(m.note, 'Materials returned'),
      'inventory_movements', m.id, 'return',
      jsonb_build_array(
        jsonb_build_object('account', s.inventory_account_id,
                           'description', 'Stock returned',
                           'debit', v_value, 'credit', 0),
        jsonb_build_object('account', s.maintenance_expense_id,
                           'description', 'Materials returned unused',
                           'debit', 0, 'credit', v_value)));
  end if;
end;
$$;

create or replace function public.post_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.post_inventory_movement_row(new.id);
  return null;
end;
$$;

-- Everything that moved stock but never reached the ledger.
do $$
declare
  r record;
begin
  for r in
    select m.id from public.inventory_movements m
     where not exists (
       select 1 from public.journal_entries je
        where je.source_table = 'inventory_movements' and je.source_id = m.id)
     order by m.created_at
  loop
    perform public.post_inventory_movement_row(r.id);
  end loop;
end $$;
