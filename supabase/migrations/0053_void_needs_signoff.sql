/**
 * Voiding a payment needs sign-off, and the database is what enforces it.
 *
 * The row-level policy on payments lets anyone with 'edit' update the row,
 * because 'edit' is what records a payment in the first place. The guard
 * trigger then blocks the columns that must never move on a posted payment --
 * amount, tenant, number, date, kind -- but 'voided' is a status change, and
 * status was not among them. So a Cashier, who holds edit precisely so they
 * can take payments, could void one outright through the API. The approval
 * queue was the only thing standing in the way, and it stood in the way only
 * in the user interface.
 *
 * Voiding now requires Void or Approve on payments. Approve is accepted
 * because applying an approved void is exactly what the approver is for.
 *
 * The check is skipped when there is no signed-in user: the service role and
 * the maintenance scripts connect as postgres, where row-level security does
 * not apply either, and has_permission() has no auth.uid() to resolve.
 */
create or replace function public.guard_posted_payment()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'voided' then
    raise exception 'This payment is voided and can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  if new.amount       is distinct from old.amount
  or new.tenant_id    is distinct from old.tenant_id
  or new.payment_no   is distinct from old.payment_no
  or new.payment_date is distinct from old.payment_date
  or new.payment_kind is distinct from old.payment_kind then
    raise exception
      'A posted payment cannot be edited. Void it with approval and record a new one.'
      using errcode = 'check_violation';
  end if;

  if new.status = 'voided'
     and auth.uid() is not null
     and not (public.has_permission(new.company_id, 'payments', 'void')
           or public.has_permission(new.company_id, 'payments', 'approve')) then
    raise exception
      'Voiding a payment needs sign-off. Request the void and have somebody with Approve decide it.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
