/**
 * The short code a location's invoices are numbered under.
 *
 * Kept apart from locations.code deliberately. The code is what staff type and
 * read on screen -- BLDG-A, MOLO -- and it is allowed to carry punctuation and
 * to be renamed when a building does. An invoice number is neither of those
 * things: it goes on a document a tenant keeps, it is quoted back in payment
 * advices and BIR filings, and it must stay stable and unambiguous for years.
 * Folding the two together would mean renaming a location silently renamed
 * every invoice series that follows it.
 *
 * So the prefix is its own field: letters and digits only, no separators,
 * because the number already uses '-' to divide prefix from year from counter
 * and a prefix containing one would read as two fields.
 *
 * Added nullable and filled in before the constraint lands, so an existing
 * database is never briefly in violation of its own rule.
 */

alter table public.locations
  add column if not exists invoice_prefix text;

comment on column public.locations.invoice_prefix is
  'Short uppercase code this location bills under, e.g. MOLO in '
  'MOLO-2026-00001. Distinct from code, which staff may rename freely.';

/*
 * Existing locations take their code with the punctuation stripped, which is
 * the only guess available and a legible one: BLDG-A becomes BLDGA. Anything
 * that would collide gets a numeric suffix rather than failing the migration.
 */
update public.locations l
   set invoice_prefix = sub.candidate
  from (
    select id,
           case
             when row_number() over (
                    partition by company_id,
                      upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
                    order by created_at, id) = 1
               then upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
             else upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
                  || row_number() over (
                       partition by company_id,
                         upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
                       order by created_at, id)::text
           end as candidate
      from public.locations
     where invoice_prefix is null
  ) sub
 where l.id = sub.id
   and l.invoice_prefix is null;

-- A code with no letters or digits at all leaves nothing to derive from.
update public.locations
   set invoice_prefix = 'LOC' || substr(replace(id::text, '-', ''), 1, 5)
 where invoice_prefix is null
    or btrim(invoice_prefix) = '';

alter table public.locations
  alter column invoice_prefix set not null;

alter table public.locations
  drop constraint if exists locations_invoice_prefix_shape;
alter table public.locations
  add constraint locations_invoice_prefix_shape
    check (invoice_prefix ~ '^[A-Z0-9]{2,10}$');

-- Unique per company, for the same reason the code is: two locations sharing a
-- prefix would share a counter and interleave one series across two buildings.
create unique index if not exists locations_company_invoice_prefix_key
  on public.locations (company_id, invoice_prefix);
