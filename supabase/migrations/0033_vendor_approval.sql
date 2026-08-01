-- New suppliers are approved before they can be used.
--
-- Anyone with Edit on suppliers could previously create one and immediately
-- raise orders and bills against them, which is the shape of the oldest fraud
-- in purchasing: invent a supplier, bill yourself, pay it. A supplier now
-- starts pending and is unusable until somebody with Approve signs them off.
--
-- This replaces the active / on_hold pair. Holding an approved supplier is
-- gone with it: the standing now describes whether the supplier was ever
-- accepted, not whether we currently feel like buying from them.

create type public.vendor_approval_status as enum (
  'pending',
  'approved',
  'rejected'
);

alter table public.vendors
  alter column status drop default;

alter table public.vendors
  alter column status type public.vendor_approval_status
    using (
      case status::text
        when 'active'  then 'approved'
        when 'on_hold' then 'rejected'
        else 'pending'
      end
    )::public.vendor_approval_status;

alter table public.vendors
  alter column status set default 'pending';

drop type if exists public.vendor_status;

comment on column public.vendors.status is
  'pending = awaiting approval, unusable; approved = may be ordered from and '
  'billed; rejected = declined, kept only so the decision is on record.';

-- The money-hiding risk survives the rename: rejecting a supplier takes them
-- out of the cheque voucher picker, so it must not be possible while they are
-- still owed. Reuses the guard written for the hold.
create or replace function public.guard_vendor_hold()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_count       integer;
  v_outstanding numeric(14, 2);
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    select count(*), coalesce(sum(total - amount_paid), 0)
      into v_count, v_outstanding
      from public.supplier_invoices
     where vendor_id = new.id
       and status <> 'cancelled'
       and total - amount_paid > 0;

    if v_count > 0 then
      raise exception
        '% still has % unpaid bill(s) totalling %. Settle or cancel them before rejecting the supplier.',
        new.name, v_count, to_char(v_outstanding, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create index if not exists vendors_pending_idx
  on public.vendors (company_id) where status = 'pending';
