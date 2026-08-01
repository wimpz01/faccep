-- A supplier you still owe cannot be put on hold.
--
-- On hold takes a supplier out of every picker, including the one used to
-- prepare a cheque voucher. Holding somebody with unpaid bills would therefore
-- hide the debt and leave no way to settle it from the app -- the money would
-- still be owed but the supplier would have vanished from the workflow.
--
-- Deleting is already refused: purchase_orders, supplier_invoices and
-- check_vouchers all reference vendors ON DELETE RESTRICT, so a supplier with
-- any purchasing history cannot be removed at all. This only closes the hold.

create or replace function public.guard_vendor_hold()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_count       integer;
  v_outstanding numeric(14, 2);
begin
  if new.status = 'on_hold' and old.status is distinct from 'on_hold' then
    select count(*), coalesce(sum(total - amount_paid), 0)
      into v_count, v_outstanding
      from public.supplier_invoices
     where vendor_id = new.id
       and status <> 'cancelled'
       and total - amount_paid > 0;

    if v_count > 0 then
      raise exception
        '% still has % unpaid bill(s) totalling %. Settle or cancel them before putting the supplier on hold.',
        new.name, v_count, to_char(v_outstanding, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_vendor_hold on public.vendors;
create trigger guard_vendor_hold
  before update on public.vendors
  for each row execute function public.guard_vendor_hold();
