/**
 * The property an invoice belongs to, carried on the invoice itself.
 *
 * It could be reached by joining contract -> contract_units -> units, but that
 * answers "where is this contract's unit now", not "what was billed". Move a
 * unit between locations or re-let it and every invoice ever raised would
 * silently change property, which is exactly the sort of retrospective edit the
 * rest of the billing rules exist to prevent. So it is written once, when the
 * invoice is created, and never derived again.
 *
 * This follows the same reasoning as 0030, which carried the property down the
 * purchasing chain for the same reason.
 *
 * Nullable, because an invoice raised by hand against no contract has no
 * property to inherit, and because that is what lets such an invoice keep the
 * company-wide INV- series in 0086.
 */

alter table public.invoices
  add column if not exists location_id uuid
    references public.locations (id) on delete restrict;

comment on column public.invoices.location_id is
  'The property billed, fixed when the invoice was raised. Null means the '
  'invoice was not raised against a property and numbers in the INV- series.';

create index if not exists invoices_location_idx
  on public.invoices (company_id, location_id);

/*
 * Everything already on file inherits from its contract's units. A contract
 * whose units span two properties has no single answer, so it is left null
 * rather than given an arbitrary one: the having clause admits only contracts
 * with exactly one distinct property, and the array then holds just that one.
 */
/*
 * A released or cancelled invoice is frozen, and rightly so -- but this is
 * recording where it was always billed, not changing what was billed. The
 * guard is lifted for the length of the backfill and put straight back; the
 * columns it protects are untouched throughout.
 */
alter table public.invoices disable trigger invoices_guard_released;

update public.invoices i
   set location_id = sub.location_id
  from (
    select c.id as contract_id,
           (array_agg(distinct u.location_id))[1] as location_id
      from public.contracts c
      join public.contract_units cu on cu.contract_id = c.id
      join public.units u on u.id = cu.unit_id
     group by c.id
    having count(distinct u.location_id) = 1
  ) sub
 where i.contract_id = sub.contract_id
   and i.location_id is null;

alter table public.invoices enable trigger invoices_guard_released;

/*
 * The guard freezes a released invoice's figures, and the property it was
 * billed against belongs in that set: it is part of what the document says.
 * Adding it here rather than leaving it editable means the backfill above is
 * the only time it could ever move.
 */
create or replace function public.guard_released_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'cancelled' then
    raise exception 'This invoice is cancelled and can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  if old.status in ('released', 'partially_paid', 'paid') then
    if new.invoice_no    is distinct from old.invoice_no
    or new.tenant_id     is distinct from old.tenant_id
    or new.contract_id   is distinct from old.contract_id
    or new.location_id   is distinct from old.location_id
    or new.invoice_date  is distinct from old.invoice_date
    or new.due_date      is distinct from old.due_date
    or new.period_start  is distinct from old.period_start
    or new.period_end    is distinct from old.period_end
    or new.is_vatable    is distinct from old.is_vatable
    or new.vat_rate      is distinct from old.vat_rate
    or new.subtotal      is distinct from old.subtotal
    or new.vat_amount    is distinct from old.vat_amount
    or new.total         is distinct from old.total then
      raise exception
        'A released invoice cannot be edited. Cancel it with approval, or issue a credit memo.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;
