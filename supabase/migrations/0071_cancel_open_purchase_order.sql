/**
 * Cancelling a purchase order that is already with the supplier.
 *
 * Until now only a draft could be cancelled: an order that had gone out had to
 * be taken back to draft first, and one that was part delivered could not be
 * ended at all. That left the commonest case with nowhere to go -- the supplier
 * cannot deliver the rest, and the order sits open for ever, counted as money
 * still committed.
 *
 * Cancelling now works on any order that still has something outstanding. What
 * it means depends on where the order had got to:
 *
 *   draft              nothing ever left the building; the order simply ends.
 *   issued             the commitment is withdrawn. Tell the supplier.
 *   partially_received the undelivered balance is closed. Goods that did
 *                      arrive stay in stock, bills already raised stand, and
 *                      what was received can still be billed -- the three-way
 *                      match is on quantities received, not on the status.
 *
 * A fully received order cannot be cancelled: everything arrived, so there is
 * nothing outstanding to end. Reversing that is a return to the supplier, which
 * is a movement of its own and not a change of mind about the order.
 *
 * These rules live here rather than only in the screen, because an order is
 * reachable from the API with nothing but a session.
 */

create or replace function public.guard_purchase_order_cancel()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if old.status = 'received' then
      raise exception
        '% has been received in full, so there is nothing outstanding to cancel. Send the goods back instead.',
        old.po_no
        using errcode = 'check_violation';
    end if;
  end if;

  -- Cancelled is the end of an order, not a pause. Anything else would let a
  -- cancellation be undone quietly and the committed value reappear.
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    raise exception
      '% was cancelled. Raise a new order rather than reopening this one.',
      old.po_no
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.guard_purchase_order_cancel() is
  'Keeps a cancellation to orders that still have something outstanding, and '
  'keeps a cancelled order cancelled.';

drop trigger if exists guard_purchase_order_cancel on public.purchase_orders;
create trigger guard_purchase_order_cancel
  before update on public.purchase_orders
  for each row execute function public.guard_purchase_order_cancel();

/**
 * Nothing may be received against an order that is cancelled or never went out.
 *
 * apply_goods_receipt() already refuses to move the status of such an order,
 * but it would still roll the quantity onto the line and push the stock into
 * inventory -- goods arriving on an order that, on the face of it, nobody
 * placed. The screen has always said receiving needs an issued order; this is
 * the same sentence, enforced.
 */
create or replace function public.guard_receipt_order_open()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_po_no  text;
  v_status public.purchase_order_status;
begin
  select o.po_no, o.status into v_po_no, v_status
    from public.goods_receipts r
    join public.purchase_orders o on o.id = r.po_id
   where r.id = new.receipt_id;

  if v_status = 'cancelled' then
    raise exception
      '% was cancelled, so nothing more can be received on it.', v_po_no
      using errcode = 'check_violation';
  end if;

  if v_status = 'draft' then
    raise exception
      '% has not been issued to the supplier yet, so nothing can be received on it.',
      v_po_no
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.guard_receipt_order_open() is
  'Refuses a goods receipt against an order that was cancelled or never issued.';

drop trigger if exists guard_receipt_order_open on public.goods_receipt_lines;
create trigger guard_receipt_order_open
  before insert on public.goods_receipt_lines
  for each row execute function public.guard_receipt_order_open();
