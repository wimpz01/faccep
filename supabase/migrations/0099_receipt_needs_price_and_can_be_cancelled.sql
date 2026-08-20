/**
 * Goods cannot be received against a line with no price, and a receipt taken
 * in error can be undone.
 *
 * Receiving at nought put a real delivery into stock at no cost and left the
 * order worth nothing, which the billing guard then read as "nothing has been
 * received on this order yet" -- refusing the supplier's invoice for a
 * delivery that had plainly arrived. The price is what the receipt is measured
 * in, so it has to exist before the receipt does.
 *
 * If the supplier's figure is not known yet, the order is priced when it is:
 * an order can be repriced right up until something is received. That is the
 * point of the cut-off, and this rule is the other half of it.
 *
 * CANCELLING. A receipt could be raised and never taken back. Nothing undid
 * it, and deleting the rows would have been worse than leaving them: the
 * trigger that applies a receipt only fires on insert, so a delete left the
 * quantity received still counted, the stock still on hand and the order still
 * marked received.
 *
 * So cancelling reverses rather than erases. The quantity comes back off the
 * line, a reversing movement takes the stock out again -- the original stays,
 * because it is what happened -- and the order returns to the state its
 * outstanding quantities describe. The receipt itself is kept and marked, in
 * the same way an invoice is cancelled rather than deleted.
 */

alter table public.goods_receipts
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text;

comment on column public.goods_receipts.cancelled_at is
  'Set when the receipt was taken back. The rows are kept; the quantities and '
  'the stock are reversed.';

/**
 * A line with no price cannot be received.
 */
create or replace function public.guard_receipt_line_priced()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_price numeric(14, 4);
  v_desc  text;
begin
  select unit_price, description into v_price, v_desc
    from public.purchase_order_lines where id = new.po_line_id;

  if coalesce(v_price, 0) <= 0 then
    raise exception
      'The order line "%" has no price, so nothing can be received against it. Price the order first -- an order can be repriced until something is received.',
      coalesce(v_desc, 'on this order')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists goods_receipt_lines_priced on public.goods_receipt_lines;
create trigger goods_receipt_lines_priced
  before insert on public.goods_receipt_lines
  for each row execute function public.guard_receipt_line_priced();

/**
 * Takes a receipt back.
 *
 * Refused once the order has been billed: the bill was measured against what
 * was received, and pulling the receipt out from under it would leave a
 * supplier invoice standing on a delivery the system says never happened.
 */
create or replace function public.cancel_goods_receipt(
  p_receipt uuid,
  p_reason  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r         public.goods_receipts%rowtype;
  line      record;
  v_billed  integer;
  v_outstanding numeric(14, 3);
begin
  select * into r from public.goods_receipts where id = p_receipt;
  if not found then
    raise exception 'That receipt no longer exists.';
  end if;

  if not public.has_permission(r.company_id, 'purchasing.receiving', 'edit') then
    raise exception 'Cancelling a receipt needs the edit right on receiving.'
      using errcode = 'insufficient_privilege';
  end if;

  if r.cancelled_at is not null then
    raise exception 'That receipt has already been cancelled.'
      using errcode = 'check_violation';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why the receipt is being cancelled.'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_billed
    from public.supplier_invoices
   where po_id = r.po_id and status <> 'cancelled';

  if v_billed > 0 then
    raise exception
      'This order has already been billed, so the receipt cannot be taken back. Cancel the supplier invoice first.'
      using errcode = 'check_violation';
  end if;

  for line in
    select grl.*, pol.item_id, pol.unit_price
      from public.goods_receipt_lines grl
      join public.purchase_order_lines pol on pol.id = grl.po_line_id
     where grl.receipt_id = p_receipt
  loop
    update public.purchase_order_lines
       set quantity_received = greatest(quantity_received - line.quantity, 0)
     where id = line.po_line_id;

    -- The original movement stays: it is what happened. This is its reversal.
    if line.item_id is not null then
      insert into public.inventory_movements
        (company_id, item_id, movement_kind, quantity, unit_cost,
         reference_table, reference_id, note)
      values (r.company_id, line.item_id, 'adjustment', -line.quantity,
              line.unit_price, 'goods_receipts', r.id,
              'Reversed ' || r.receipt_no || ': ' || p_reason);
    end if;
  end loop;

  select coalesce(sum(quantity - quantity_received), 0) into v_outstanding
    from public.purchase_order_lines where po_id = r.po_id;

  update public.purchase_orders
     set status = case
                    when v_outstanding <= 0 then 'received'::public.purchase_order_status
                    when exists (select 1 from public.purchase_order_lines
                                  where po_id = r.po_id and quantity_received > 0)
                      then 'partially_received'::public.purchase_order_status
                    else 'issued'::public.purchase_order_status
                  end
   where id = r.po_id
     and status <> 'cancelled';

  update public.goods_receipts
     set cancelled_at = now(),
         cancellation_reason = p_reason
   where id = p_receipt;
end;
$$;

comment on function public.cancel_goods_receipt(uuid, text) is
  'Takes a receipt back: quantities come off the order, a reversing movement '
  'takes the stock out, and the order returns to its outstanding state. '
  'Refused once the order has been billed.';
