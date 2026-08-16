/**
 * Invoice numbers become A-26-00001: property letter, two-digit year, and a
 * five-digit running number that starts again at 1 every January.
 *
 * WHICH DATE DRIVES THE YEAR. The invoice's own invoice_date, not the day the
 * row happened to be inserted. That date is what is printed on the document
 * and what the BIR sales book is ordered and filed by, so a number derived
 * from it always agrees with the paper it appears on. Under the insert date, a
 * December invoice raised on 2 January would print December 2026 and number
 * A-27-00001 -- contradicting its own document, and landing in a different
 * book from the one it belongs to. The same date drives the YY segment and the
 * counter row, so the printed year and the series it came from cannot diverge.
 *
 * Back-dating therefore draws from that earlier year's counter, which is the
 * correct outcome: the invoice belongs to the year it is dated.
 *
 * CONCURRENCY. Each property-year is one row in document_counters, and the
 * number is issued by an upsert that increments in place. The upsert takes a
 * row lock, so two people billing the same property at the same instant
 * serialise and take consecutive numbers rather than both reading the same
 * highest value. Two people billing different properties touch different rows
 * and never wait on each other. The unique index on
 * (company_id, lower(invoice_no)) stays as the last line of defence.
 *
 * GAPS, NOT REUSE. last_value only ever rises. Deleting a draft or cancelling
 * an invoice leaves its number spent for good, so a series may show a gap and
 * will never show one reference on two documents.
 *
 * PAST 99999 in one property-year the number simply widens to A-26-100000. It
 * stays unique and still sorts correctly; only the fixed width is lost.
 * Billing is not blocked over a formatting detail.
 */

/**
 * Issues the next number for one property in the year of a given date.
 *
 * Separate from next_document_no() because that one formats a four-digit year
 * and this one prints two while still counting on the real year -- keeping the
 * counter key unambiguous where the printed form is abbreviated.
 */
create or replace function public.next_invoice_no(
  p_company  uuid,
  p_location uuid,
  p_letter   text,
  p_date     date
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from p_date)::integer;
  v_next integer;
begin
  insert into public.document_counters (company_id, doc_type, year, last_value)
  values (p_company, 'invoice:' || p_location::text, v_year, 1)
  on conflict (company_id, doc_type, year)
    do update set last_value = document_counters.last_value + 1
  returning last_value into v_next;

  return p_letter || '-' || to_char(p_date, 'YY') || '-'
         || lpad(v_next::text, 5, '0');
end;
$$;

comment on function public.next_invoice_no(uuid, uuid, text, date) is
  'Next invoice number for one property in the year of p_date, as '
  'A-26-00001. Counts per property per year and never reissues a number.';

/**
 * Fills invoices.invoice_no in before the row lands.
 *
 * An invoice naming no property keeps the company-wide INV- series, which is
 * what the ten already on file are numbered in. Nothing existing is renumbered.
 */
create or replace function public.assign_invoice_no()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_letter text;
begin
  -- A number supplied explicitly (seed data, an import, a migration) stands.
  if new.invoice_no is not null and btrim(new.invoice_no) <> '' then
    return new;
  end if;

  if new.location_id is not null then
    select l.invoice_prefix into v_letter
      from public.locations l
     where l.id = new.location_id;
  end if;

  if v_letter is null then
    new.invoice_no := public.next_document_no(
      new.company_id, 'invoice', 'INV',
      extract(year from coalesce(new.invoice_date, current_date))::integer, 5);
  else
    new.invoice_no := public.next_invoice_no(
      new.company_id, new.location_id, v_letter,
      coalesce(new.invoice_date, current_date));
  end if;

  return new;
end;
$$;

comment on function public.assign_invoice_no() is
  'Numbers an invoice A-26-00001 from its property and its invoice_date, or '
  'INV-<year>-00001 when it names no property.';

drop trigger if exists assign_invoice_no on public.invoices;
create trigger assign_invoice_no
  before insert on public.invoices
  for each row execute function public.assign_invoice_no();

/*
 * Reseed each property-year counter from anything already numbered in the new
 * shape. Nothing matches today -- every existing invoice is in the INV- series
 * and no property counter has ever been drawn on -- but a database restored
 * from a later backup would otherwise restart at 1 and collide.
 */
insert into public.document_counters (company_id, doc_type, year, last_value)
select i.company_id,
       'invoice:' || i.location_id::text,
       extract(year from i.invoice_date)::integer,
       max((regexp_match(i.invoice_no, '^[A-Z]-\d{2}-(\d+)$'))[1]::integer)
  from public.invoices i
  join public.locations l on l.id = i.location_id
 where i.invoice_no ~ ('^' || l.invoice_prefix || '-\d{2}-\d+$')
 group by i.company_id, i.location_id, extract(year from i.invoice_date)
on conflict (company_id, doc_type, year)
  do update set last_value =
       greatest(document_counters.last_value, excluded.last_value);
