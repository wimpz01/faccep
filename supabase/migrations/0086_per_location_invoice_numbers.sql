/**
 * Invoices are numbered per property, each property counting for itself.
 *
 * MOLO-2026-00001, MOLO-2026-00002, BLDGA-2026-00001 -- three invoices, two
 * series. A property's numbering is then its own record: it runs unbroken
 * whatever the other buildings are doing, which is what makes a series
 * legible to a tenant and auditable against one building's file.
 *
 * Nothing already numbered is touched. INV-2026-00001 through 00009 keep their
 * numbers for ever; the company-wide counter is left exactly where it stands so
 * that an invoice raised against no property still continues that series rather
 * than restarting it.
 *
 * CONCURRENCY. The counter is the same document_counters row-lock mechanism
 * from 0024, keyed on doc_type. Making the key 'invoice:<location uuid>' gives
 * each property its own row: two people generating for two properties touch two
 * different rows and never wait on each other, and two people generating for
 * the same property serialise on that row and take consecutive values. No
 * number is issued twice and none is skipped, and the unique index on
 * (company_id, lower(invoice_no)) remains the backstop either way.
 *
 * GAPS. The counter only ever goes up. Cancelling an invoice, or deleting a
 * draft, leaves its number spent -- the series will show a gap and no number is
 * ever reissued. A reused number would mean two different documents answering
 * to one reference, which is worse than a gap in every direction that matters.
 */

create or replace function public.assign_invoice_no()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
begin
  -- A number supplied explicitly (seed data, an import, a migration) stands.
  if new.invoice_no is not null and btrim(new.invoice_no) <> '' then
    return new;
  end if;

  if new.location_id is not null then
    select l.invoice_prefix into v_prefix
      from public.locations l
     where l.id = new.location_id;
  end if;

  if v_prefix is null then
    -- No property, or a property with no prefix: the company-wide series.
    new.invoice_no := public.next_document_no(
      new.company_id, 'invoice', 'INV',
      extract(year from current_date)::integer, 5);
  else
    new.invoice_no := public.next_document_no(
      new.company_id, 'invoice:' || new.location_id::text, v_prefix,
      extract(year from current_date)::integer, 5);
  end if;

  return new;
end;
$$;

comment on function public.assign_invoice_no() is
  'Fills in invoices.invoice_no: <location prefix>-<year>-<00001> per '
  'property, or INV-<year>-<00001> when the invoice names no property.';

-- Replaces the generic trigger 0024 attached to this one table. Every other
-- document type keeps the shared assign_document_no().
drop trigger if exists assign_invoice_no on public.invoices;
create trigger assign_invoice_no
  before insert on public.invoices
  for each row execute function public.assign_invoice_no();

/*
 * Seed each property's counter from anything already numbered under its prefix.
 * Nothing matches today -- every existing invoice is in the INV- series -- but
 * a database restored from a backup taken after this ships would otherwise
 * restart at 1 and collide.
 */
insert into public.document_counters (company_id, doc_type, year, last_value)
select i.company_id,
       'invoice:' || i.location_id::text,
       (regexp_match(i.invoice_no, '^' || l.invoice_prefix || '-(\d{4})-(\d+)$'))[1]::integer,
       max((regexp_match(i.invoice_no, '^' || l.invoice_prefix || '-(\d{4})-(\d+)$'))[2]::integer)
  from public.invoices i
  join public.locations l on l.id = i.location_id
 where i.invoice_no ~ ('^' || l.invoice_prefix || '-\d{4}-\d+$')
 group by i.company_id, i.location_id, l.invoice_prefix,
          (regexp_match(i.invoice_no, '^' || l.invoice_prefix || '-(\d{4})-(\d+)$'))[1]::integer
on conflict (company_id, doc_type, year)
  do update set last_value =
       greatest(document_counters.last_value, excluded.last_value);
