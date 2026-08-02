-- Cancelling belongs to a draft, not to an order already with the supplier.
--
-- 0047 allowed an issued order to be cancelled outright. That skips a step the
-- buyer owes the supplier: an order that has gone out is taken back first --
-- the issue is withdrawn, it returns to draft -- and only then cancelled. The
-- two corrections stay distinct, and the audit trail shows both.
--
--   draft   → cancelled        end it before it ever went out
--   issued  → draft            take back the issue, nothing received
--   issued  → cancelled        refused; take the issue back first

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

  if old.status = 'cancelled' then
    raise exception
      'That purchase order was cancelled. Raise a new one instead.'
      using errcode = 'check_violation';
  end if;

  if new.status = 'cancelled' then
    if old.status <> 'draft' then
      raise exception
        'Only a draft can be cancelled. Take back the issue first, then cancel it.'
        using errcode = 'check_violation';
    end if;
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

  -- Taking the issue back returns it to draft, and only before anything
  -- arrives: a receipt has already moved stock.
  if old.status = 'issued' and new.status = 'draft' then
    if public.po_has_receipts(new.id) then
      raise exception
        'Goods have already been received on this order, so the issue cannot be taken back.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  return new;
end;
$$;

comment on function public.guard_purchase_order_status is
  'Cancel a draft; take back an issue before anything is received. Never both at once.';
