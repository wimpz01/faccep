/**
 * Cancelling an order that still has something outstanding.
 *
 * 0048 and 0049 narrowed cancelling to a draft: an order already with the
 * supplier had to be taken back to draft first, and one that was part
 * delivered could not be ended at all. That left the commonest case with
 * nowhere to go. A supplier delivers half an order and tells you the rest is
 * not coming; the balance sits open for ever, still counted as money
 * committed, and the only way out was to keep receiving goods that will never
 * arrive.
 *
 * Cancelling now ends any order that still owes something, and what it means
 * depends on where the order had got to:
 *
 *   draft               nothing ever left the building; the order simply ends.
 *   issued              the commitment is withdrawn. Tell the supplier.
 *   partially_received  the undelivered balance is closed. Goods that did
 *                       arrive stay in stock, bills already raised stand, and
 *                       what was received can still be billed.
 *   received            refused. Everything arrived, so nothing is
 *                       outstanding. Undoing that is a return to the supplier,
 *                       a movement of its own, not a change of mind.
 *
 * The receipt and bill checks 0049 applied to a cancellation are gone, and
 * deliberately. Neither was reachable on a draft, and on a part-delivered
 * order both described exactly the situation this is meant to resolve --
 * refusing to close a balance because goods arrived against the part that was
 * honoured. What was received is not touched by cancelling the rest: the
 * three-way match is on quantities received, so those goods remain billable.
 *
 * Taking back an issue is unchanged and still refused once anything arrives.
 * 0071 added a second cancel trigger beside this one; it is removed here so
 * there is one guard on this table and one place to read the rules.
 */

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
    if old.status = 'received' then
      raise exception
        'Everything ordered has been received, so there is nothing outstanding to cancel. Return the goods to the supplier instead.'
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

  -- issued and the two received states are reached by issuing and receiving,
  -- which are the app's own paths. Anything else is refused rather than
  -- guessed at.
  if new.status in ('issued', 'partially_received', 'received') then
    return new;
  end if;

  raise exception
    'A purchase order cannot go from % to %.', old.status, new.status
    using errcode = 'check_violation';
end;
$$;

comment on function public.guard_purchase_order_status() is
  'The only legal moves for a purchase order: cancel anything still '
  'outstanding, take back a clean issue, and never reopen a cancellation.';

-- One guard on this table. 0071 put a second one beside it while the rule it
-- was meant to change turned out to live here.
drop trigger if exists guard_purchase_order_cancel on public.purchase_orders;
drop function if exists public.guard_purchase_order_cancel();
