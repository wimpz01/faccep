-- Supplier codes and an explicit standing.
--
-- Suppliers were identified only by name and carried a bare is_active flag.
-- A code gives them the same system-issued reference every other record has,
-- and replacing the boolean with a status says *why* a supplier is unavailable
-- rather than only that they are.
--
-- On hold means: still on file, still owed money, still shown on their history
-- -- but not offered when raising something new.

create type public.vendor_status as enum ('active', 'on_hold');

alter table public.vendors
  add column if not exists vendor_no text,
  add column if not exists status public.vendor_status not null default 'active';

-- Carry the old flag across before it goes.
update public.vendors set status = 'on_hold' where is_active = false;

alter table public.vendors drop column if exists is_active;

-- Number the suppliers already on file, oldest first.
do $$
declare
  row_to_number record;
begin
  for row_to_number in
    select id, company_id from public.vendors
     where vendor_no is null order by created_at
  loop
    update public.vendors
       set vendor_no = public.next_document_no(
             row_to_number.company_id, 'vendor', 'VEND',
             extract(year from current_date)::integer, 4)
     where id = row_to_number.id;
  end loop;
end;
$$;

alter table public.vendors alter column vendor_no set not null;

create unique index if not exists vendors_no_unique
  on public.vendors (company_id, lower(vendor_no));
create index if not exists vendors_status_idx
  on public.vendors (company_id, status);

drop trigger if exists assign_vendor_no on public.vendors;
create trigger assign_vendor_no
  before insert on public.vendors
  for each row execute function
  public.assign_document_no('vendor_no', 'vendor', 'VEND', '4');

comment on column public.vendors.vendor_no is
  'System-issued supplier code.';
comment on column public.vendors.status is
  'active = may be used on new orders and bills; on_hold = kept on file only.';
