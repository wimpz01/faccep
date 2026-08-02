-- Returning to draft is refused from every status except a clean issue.
--
-- 0048 handled 'issued' → 'draft' and then fell through to allowing anything
-- it had not named. Receiving moves the order to partially_received or
-- received on its own, so an order with goods already in stock was never
-- matched by the issued branch and was let through -- the exact case the guard
-- existed to stop.
--
-- Anything not explicitly permitted is now refused.

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

  -- Back to draft only from a clean issue, and only before anything arrives.
  if new.status = 'draft' then
    if old.status <> 'issued' then
      raise exception
        'Goods have already been received on this order, so the issue cannot be taken back.'
        using errcode = 'check_violation';
    end if;
    if public.po_has_receipts(new.id) then
      raise exception
        'Goods have already been received on this order, so the issue cannot be taken back.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Everything else -- issuing, and the receiving trigger moving the order
  -- forward -- is left alone.
  return new;
end;
$$;
