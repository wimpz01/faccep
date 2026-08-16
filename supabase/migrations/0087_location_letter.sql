/**
 * One letter per property, and the system picks it.
 *
 * 0084 gave each location a free-text prefix so its invoices could be told
 * apart. That is now narrowed to a single letter: an invoice number reads
 * A-26-00001, and a letter is what a person can say down a telephone without
 * spelling it. The column keeps its name because its meaning has not changed
 * -- it is still what this location bills under -- only its shape has.
 *
 * Nobody types it. A new location takes the lowest letter not already in use
 * in that company, so deleting the third location and adding another gives the
 * new one C rather than D. Letters stay scarce and stay legible that way, and
 * there is nothing to get wrong at the moment of creation.
 *
 * It remains editable afterwards, because the first guess is only a guess: the
 * unique index is what stops a correction colliding with another property.
 *
 * PAST 26 LOCATIONS this fails, loudly, with an exception naming the problem.
 * A 27th property has no letter left and there is deliberately no AA fallback:
 * silently changing the shape of every number a company issues is worse than
 * refusing to create the location and being asked about it.
 */

-- The old shape allowed BLDGA and MOLO; the new one allows only A.
alter table public.locations
  drop constraint if exists locations_invoice_prefix_shape;

/**
 * The lowest letter this company has not used.
 *
 * Lowest free rather than highest+1, so letters freed by a deleted location
 * come back into use instead of the alphabet marching on.
 */
create or replace function public.next_location_letter(p_company uuid)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_letter text;
begin
  select chr(65 + g)
    into v_letter
    from generate_series(0, 25) as g
   where not exists (
           select 1
             from public.locations l
            where l.company_id = p_company
              and l.invoice_prefix = chr(65 + g))
   order by g
   limit 1;

  if v_letter is null then
    raise exception
      'This company already uses every letter from A to Z, so there is no '
      'letter left for another location. Invoice numbers carry one letter per '
      'property; a wider scheme is needed before a 27th can be added.'
      using errcode = 'check_violation';
  end if;

  return v_letter;
end;
$$;

comment on function public.next_location_letter(uuid) is
  'The lowest A-Z letter not yet taken by a location in this company. Raises '
  'once all 26 are in use rather than inventing a two-letter code.';

/*
 * Existing locations take letters in the order they were created, per company,
 * which is the only ordering that does not depend on a name somebody may
 * later change. A company already past 26 would have nothing to assign, so it
 * is refused here rather than left half done.
 */
do $$
declare
  crowded text;
begin
  select string_agg(company_id::text, ', ')
    into crowded
    from (select company_id from public.locations
           group by company_id having count(*) > 26) c;

  if crowded is not null then
    raise exception
      'Companies % have more than 26 locations, so single-letter invoice '
      'prefixes cannot be assigned. Resolve this before migrating.', crowded;
  end if;
end;
$$;

update public.locations l
   set invoice_prefix = chr((64 + seq.n)::integer)
  from (
    select id,
           row_number() over (partition by company_id order by created_at, id) as n
      from public.locations
  ) seq
 where l.id = seq.id;

alter table public.locations
  add constraint locations_invoice_prefix_shape
    check (invoice_prefix ~ '^[A-Z]$');

comment on column public.locations.invoice_prefix is
  'The single letter this location bills under, e.g. A in A-26-00001. '
  'Assigned automatically as the lowest free letter; editable to correct it.';

/**
 * Fills the letter in on creation, and keeps a typed one tidy.
 *
 * Upper-casing here rather than refusing lower case means entering 'b' is a
 * correction that works, not a constraint violation to decipher.
 */
create or replace function public.assign_location_letter()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.invoice_prefix is null or btrim(new.invoice_prefix) = '' then
    new.invoice_prefix := public.next_location_letter(new.company_id);
  else
    new.invoice_prefix := upper(btrim(new.invoice_prefix));
  end if;
  return new;
end;
$$;

drop trigger if exists locations_assign_letter on public.locations;
create trigger locations_assign_letter
  before insert or update of invoice_prefix on public.locations
  for each row execute function public.assign_location_letter();
