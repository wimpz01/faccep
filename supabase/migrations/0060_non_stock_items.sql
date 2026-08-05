/**
 * Non-stock items: the things bought that never sit on a shelf.
 *
 * Security services, hauling, professional fees. A purchase line could already
 * be marked non-stock and pointed at an expense account, but the account had
 * to be chosen by hand on every line -- so the same service was charged to
 * three different accounts depending on who typed it, and the description was
 * re-keyed each time.
 *
 * A non-stock item is set up once with its description and the account it is
 * charged to, and both come along whenever it is bought.
 *
 * Kept in its own table rather than as a flag on inventory_items, because
 * everything that makes a stock item a stock item -- quantity on hand, reorder
 * level, unit cost, the movement ledger -- means nothing here, and a flag
 * would have left half the columns permanently empty and permanently
 * meaningless.
 */

create table public.non_stock_items (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  code               text not null,
  name               text not null,
  description        text,
  unit_of_measure    text not null default 'lot',
  default_cost       numeric(14,4) not null default 0 check (default_cost >= 0),
  expense_account_id uuid not null references public.chart_of_accounts (id),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, code)
);

-- Lower-cased, so the same service cannot be set up twice under two spellings.
-- An expression needs an index rather than a table constraint.
create unique index non_stock_items_name_key
  on public.non_stock_items (company_id, lower(name));

create index non_stock_items_company_idx
  on public.non_stock_items (company_id) where is_active;

comment on table public.non_stock_items is
  'Bought but never stocked. Carries the expense account it is charged to.';

-- The code is issued by the database, in the same style as every other one.
create or replace function public.assign_non_stock_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.code is null or new.code = '' then
    new.code := public.next_document_no(
      new.company_id, 'non_stock_item', 'NS',
      extract(year from current_date)::integer, 4);
  end if;
  return new;
end;
$$;

create trigger non_stock_items_code
  before insert on public.non_stock_items
  for each row execute function public.assign_non_stock_code();

create trigger non_stock_items_set_updated_at
  before update on public.non_stock_items
  for each row execute function public.set_updated_at();

-- A purchase line may name one, which is what carries the account across.
alter table public.purchase_order_lines
  add column if not exists non_stock_item_id uuid
    references public.non_stock_items (id) on delete set null;

alter table public.purchase_request_lines
  add column if not exists non_stock_item_id uuid
    references public.non_stock_items (id) on delete set null;

/**
 * Keeps the line's account in step with the item it names.
 *
 * The account still lives on the line -- what a purchase was charged to must
 * not change because somebody edited a setup record months later -- but it is
 * filled in from the item rather than chosen again by hand.
 */
create or replace function public.apply_non_stock_account()
returns trigger
language plpgsql
as $$
begin
  if new.non_stock_item_id is not null and new.expense_account_id is null then
    select expense_account_id into new.expense_account_id
      from public.non_stock_items where id = new.non_stock_item_id;
  end if;
  return new;
end;
$$;

create trigger purchase_order_lines_non_stock_account
  before insert or update on public.purchase_order_lines
  for each row execute function public.apply_non_stock_account();

create trigger purchase_request_lines_non_stock_account
  before insert or update on public.purchase_request_lines
  for each row execute function public.apply_non_stock_account();

-- ---------------------------------------------------------------------------
-- Row-level security, matching the inventory tables.
-- ---------------------------------------------------------------------------

alter table public.non_stock_items enable row level security;

create policy non_stock_items_read on public.non_stock_items
  for select to authenticated using (public.is_company_member(company_id));

create policy non_stock_items_write on public.non_stock_items
  for all to authenticated
  using      (public.has_permission(company_id, 'inventory.items', 'edit'))
  with check (public.has_permission(company_id, 'inventory.items', 'edit'));
