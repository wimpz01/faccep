-- A bill records which delivery it settles.
--
-- Until now a supplier invoice pointed at the purchase order but not at the
-- goods receipt, so nothing could answer "what has arrived that we have not
-- been billed for?" -- the gap where a delivery is quietly paid twice, or
-- never accrued at all.

alter table public.supplier_invoices
  add column if not exists receipt_id uuid
    references public.goods_receipts (id) on delete set null;

create index if not exists supplier_invoices_receipt_idx
  on public.supplier_invoices (receipt_id);

comment on column public.supplier_invoices.receipt_id is
  'The delivery this bill settles. Null for bills that stand on their own.';

-- One live bill per delivery. A cancelled bill releases the receipt so it can
-- be billed again, which is the whole point of cancelling it.
create unique index supplier_invoices_receipt_once
  on public.supplier_invoices (receipt_id)
  where receipt_id is not null and status <> 'cancelled';

-- Bills already raised against an order are matched to its delivery where that
-- is unambiguous -- a single receipt on the order. Anything with several
-- receipts is left alone rather than guessed at.
update public.supplier_invoices si
   set receipt_id = g.id
  from public.goods_receipts g
 where si.receipt_id is null
   and si.po_id is not null
   and g.po_id = si.po_id
   and (select count(*) from public.goods_receipts g2 where g2.po_id = si.po_id) = 1
   and not exists (
     select 1 from public.supplier_invoices other
      where other.receipt_id = g.id and other.status <> 'cancelled');

/** Value of a goods receipt, at the price ordered. */
create or replace function public.receipt_value(p_receipt uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(sum(l.quantity * pol.unit_price), 2), 0)
    from public.goods_receipt_lines l
    join public.purchase_order_lines pol on pol.id = l.po_line_id
   where l.receipt_id = p_receipt;
$$;

comment on function public.receipt_value is
  'What a delivery is worth at ordered prices. Drives the not-yet-billed figure.';
