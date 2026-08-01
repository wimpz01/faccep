-- Stock codes are issued by the system.
--
-- SKU was free text and optional, so items could share a code or have none at
-- all. It now comes from the same counter every other document uses, which also
-- gives an item a stable handle for the import file to match on.

alter table public.inventory_items
  add column if not exists sku_generated boolean not null default false;

-- Number anything without a code, oldest first. Codes already typed in are left
-- alone -- they may be printed on a shelf label.
do $$
declare
  row_to_number record;
begin
  for row_to_number in
    select id, company_id from public.inventory_items
     where sku is null or btrim(sku) = ''
     order by created_at
  loop
    update public.inventory_items
       set sku = public.next_document_no(
             row_to_number.company_id, 'inventory_item', 'SKU',
             extract(year from current_date)::integer, 4),
           sku_generated = true
     where id = row_to_number.id;
  end loop;
end;
$$;

alter table public.inventory_items alter column sku set not null;

create unique index if not exists inventory_items_sku_unique
  on public.inventory_items (company_id, lower(sku));

drop trigger if exists assign_inventory_item_no on public.inventory_items;
create trigger assign_inventory_item_no
  before insert on public.inventory_items
  for each row execute function
  public.assign_document_no('sku', 'inventory_item', 'SKU', '4');

comment on column public.inventory_items.sku is
  'Stock code. Issued by the system unless one was supplied on import.';
comment on column public.inventory_items.sku_generated is
  'True when the code came from the counter rather than being typed or imported.';
