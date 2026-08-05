/**
 * A stock item carries its own account, defaulting to 1200 Inventory -
 * Supplies.
 *
 * Non-stock items name the expense account they are charged to; stock items
 * now name the asset account they are held in, so both kinds are set up the
 * same way. Almost every item belongs in 1200, which is why that is the
 * default rather than a question -- but a company holding, say, fuel or spare
 * parts in their own accounts can now say so per item.
 *
 * Left null, the company's inventory account is used, exactly as before.
 */

alter table public.inventory_items
  add column if not exists inventory_account_id uuid
    references public.chart_of_accounts (id) on delete set null;

comment on column public.inventory_items.inventory_account_id is
  'Where this item is held. Falls back to the company inventory account (1200).';

-- Existing items are held where they have always been held.
update public.inventory_items i
   set inventory_account_id = coalesce(
         (select s.inventory_account_id from public.accounting_settings s
           where s.company_id = i.company_id),
         public.account_by_code(i.company_id, '1200'))
 where i.inventory_account_id is null;

/**
 * Posting follows the item first, then the company.
 *
 * Only the inventory side changes here -- which account the stock sits in.
 * Where a correction is charged is still the adjustment account.
 */
create or replace function public.post_inventory_movement_row(p_movement uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m          public.inventory_movements%rowtype;
  s          public.accounting_settings%rowtype;
  v_value    numeric(14, 2);
  v_stock    uuid;
  v_offset   uuid;
  v_is_adj   boolean;
begin
  select * into m from public.inventory_movements where id = p_movement;
  if not found then
    return;
  end if;

  select * into s from public.accounting_settings where company_id = m.company_id;
  if not found then
    return;
  end if;

  select coalesce(i.inventory_account_id, s.inventory_account_id,
                  public.account_by_code(m.company_id, '1200'))
    into v_stock
    from public.inventory_items i
   where i.id = m.item_id;

  if v_stock is null then
    return;
  end if;

  v_value := round(abs(m.quantity) * m.unit_cost, 2);
  if v_value = 0 then
    return;
  end if;

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
          jsonb_build_object('account', v_stock,
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
          jsonb_build_object('account', v_stock,
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
        jsonb_build_object('account', v_stock,
                           'description', 'Stock issued',
                           'debit', 0, 'credit', v_value)));
  elsif m.movement_kind = 'return' then
    perform public.post_journal(
      m.company_id, m.created_at::date,
      coalesce(m.note, 'Materials returned'),
      'inventory_movements', m.id, 'return',
      jsonb_build_array(
        jsonb_build_object('account', v_stock,
                           'description', 'Stock returned',
                           'debit', v_value, 'credit', 0),
        jsonb_build_object('account', s.maintenance_expense_id,
                           'description', 'Materials returned unused',
                           'debit', 0, 'credit', v_value)));
  end if;
end;
$$;
