-- A purchase order can be cancelled, and an issue can be taken back.
--
-- Two different corrections. Cancelling ends the order: nothing more will be
-- bought on it. Taking back the issue returns it to draft so the lines can be
-- fixed and it can go out again -- the supplier was told something wrong.
--
-- Neither is allowed once goods have arrived. Stock is already on the shelves
-- and the receipt has moved inventory; the way back from that is a return, not
-- a cancellation. Nor once a bill has been raised against it.

/** Goods already received against an order. */
create or replace function public.po_has_receipts(p_po uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.goods_receipts where po_id = p_po);
$$;

/** A live supplier invoice raised against an order. */
create or replace function public.po_has_bills(p_po uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.supplier_invoices
     where po_id = p_po and status <> 'cancelled');
$$;

create or replace function public.guard_purchase_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- Cancelling ends the order.
  if new.status = 'cancelled' then
    if public.po_has_receipts(new.id) then
      raise exception
        'Goods have already been received on this order, so it cannot be cancelled. Return the goods to the supplier instead.'
        using errcode = 'check_violation';
    end if;
    if public.po_has_bills(new.id) then
      raise exception
        'A supplier invoice has been raised against this order. Cancel the bill first.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Taking the issue back returns it to draft.
  if old.status = 'issued' and new.status = 'draft' then
    if public.po_has_receipts(new.id) then
      raise exception
        'Goods have already been received on this order, so the issue cannot be taken back.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- A cancelled order is finished with.
  if old.status = 'cancelled' then
    raise exception
      'That purchase order was cancelled. Raise a new one instead.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_orders_guard_status on public.purchase_orders;
create trigger purchase_orders_guard_status
  before update of status on public.purchase_orders
  for each row execute function public.guard_purchase_order_status();

comment on function public.guard_purchase_order_status is
  'Cancelling or un-issuing is refused once goods have arrived or a bill exists.';
