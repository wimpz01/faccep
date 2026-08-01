-- Supplier invoices and postdated cheques were the last two transactions
-- without a number of our own.
--
-- Both carry a number that belongs to somebody else: the vendor's invoice
-- number on their document, and the bank's cheque number. Those stay exactly
-- as they are -- typed in, and used to catch the same document being recorded
-- twice. What they gain here is our own system-issued number alongside, the
-- way check_vouchers already carries voucher_no next to the bank's check_no.

alter table public.supplier_invoices add column if not exists bill_no text;
alter table public.postdated_checks  add column if not exists pdc_no  text;

comment on column public.supplier_invoices.invoice_no is
  'The supplier''s own invoice number, for reference and to catch duplicates.';
comment on column public.supplier_invoices.bill_no is
  'Our system-issued number for this bill.';
comment on column public.postdated_checks.check_no is
  'The cheque number printed by the bank, for reference.';
comment on column public.postdated_checks.pdc_no is
  'Our system-issued number for this cheque record.';

-- Give the rows that already exist a number, oldest first, so the sequence
-- reflects the order they were recorded in.
do $$
declare
  row_to_number record;
begin
  for row_to_number in
    select id, company_id from public.supplier_invoices
     where bill_no is null order by created_at
  loop
    update public.supplier_invoices
       set bill_no = public.next_document_no(
             row_to_number.company_id, 'supplier_bill', 'BILL',
             extract(year from current_date)::integer, 4)
     where id = row_to_number.id;
  end loop;

  for row_to_number in
    select id, company_id from public.postdated_checks
     where pdc_no is null order by created_at
  loop
    update public.postdated_checks
       set pdc_no = public.next_document_no(
             row_to_number.company_id, 'postdated_check', 'PDC',
             extract(year from current_date)::integer, 4)
     where id = row_to_number.id;
  end loop;
end;
$$;

alter table public.supplier_invoices alter column bill_no set not null;
alter table public.postdated_checks  alter column pdc_no  set not null;

create unique index if not exists supplier_invoices_bill_no_unique
  on public.supplier_invoices (company_id, lower(bill_no));
create unique index if not exists postdated_checks_pdc_no_unique
  on public.postdated_checks (company_id, lower(pdc_no));

drop trigger if exists assign_supplier_bill_no on public.supplier_invoices;
create trigger assign_supplier_bill_no
  before insert on public.supplier_invoices
  for each row execute function
  public.assign_document_no('bill_no', 'supplier_bill', 'BILL', '4');

drop trigger if exists assign_postdated_check_no on public.postdated_checks;
create trigger assign_postdated_check_no
  before insert on public.postdated_checks
  for each row execute function
  public.assign_document_no('pdc_no', 'postdated_check', 'PDC', '4');
