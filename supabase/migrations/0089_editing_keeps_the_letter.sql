/**
 * Clearing the letter on an existing location keeps the one it has.
 *
 * 0087 read a blank letter as "assign one", which is right when a location is
 * being created and wrong when one is being edited: the form submits every
 * field, so saving a change of address with the letter box left empty would
 * have handed the location the lowest free letter -- a different one -- and
 * silently split its invoice series in two. The old numbers would keep their
 * letter and the new ones would carry another, with nothing to say why.
 *
 * A letter is therefore assigned only when there is not already one. Changing
 * it stays possible; losing it by omission does not.
 */

create or replace function public.assign_location_letter()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.invoice_prefix is null or btrim(new.invoice_prefix) = '' then
    if tg_op = 'UPDATE' and old.invoice_prefix is not null then
      new.invoice_prefix := old.invoice_prefix;
    else
      new.invoice_prefix := public.next_location_letter(new.company_id);
    end if;
  else
    new.invoice_prefix := upper(btrim(new.invoice_prefix));
  end if;
  return new;
end;
$$;
