-- Three-way match: a bill raised against a purchase order cannot exceed what
-- has actually been received on it.
--
-- Ordering, receiving and billing are three separate facts. Without this, a
-- supplier invoice for goods that never arrived posts to payables and gets
-- paid -- exactly the informal purchasing the system is meant to replace.

/** Value received on a purchase order, at the ordered unit price. */
create or replace function public.po_received_value(p_po uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(sum(quantity_received * unit_price), 2), 0)
    from public.purchase_order_lines
   where po_id = p_po;
$$;

/** Net value already billed against a purchase order. */
create or replace function public.po_billed_value(p_po uuid, p_exclude uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(sum(amount), 2), 0)
    from public.supplier_invoices
   where po_id = p_po
     and status <> 'cancelled'
     and (p_exclude is null or id <> p_exclude);
$$;

create or replace function public.guard_bill_against_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_received numeric(14, 2);
  v_billed   numeric(14, 2);
begin
  if new.po_id is null then
    return new;
  end if;

  v_received := public.po_received_value(new.po_id);
  v_billed   := public.po_billed_value(new.po_id, new.id);

  if v_received = 0 then
    raise exception
      'Nothing has been received on this order yet, so it cannot be billed.'
      using errcode = 'check_violation';
  end if;

  if round(v_billed + new.amount, 2) > v_received then
    raise exception
      'Billing %.2f would exceed what has been received. Received %.2f, already billed %.2f, so %.2f is still billable.',
      new.amount, v_received, v_billed, v_received - v_billed
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger supplier_invoices_match_receipt
  before insert or update of amount, po_id on public.supplier_invoices
  for each row execute function public.guard_bill_against_receipt();
