/**
 * An approver has to be able to apply what they approved.
 *
 * Every table the approval queue writes to gated its writes on 'edit'. The
 * Manager role approves 26 modules and holds edit on none of them, so signing
 * off did nothing: the update matched no row, PostgREST reported no error
 * (a row filtered out by RLS is not an error), and the request was marked
 * approved while the invoice stayed open and the payment stayed posted.
 *
 * These are additional permissive policies, so they OR with the existing
 * ones rather than replacing them. They cover UPDATE only -- approving never
 * inserts or deletes -- and the guard triggers still decide which columns may
 * actually change, exactly as they do for the edit and void paths.
 */

create policy invoices_approve_update on public.invoices
  for update to authenticated
  using      (public.has_permission(company_id, 'billing.invoices', 'approve'))
  with check (public.has_permission(company_id, 'billing.invoices', 'approve'));

create policy payments_approve_update on public.payments
  for update to authenticated
  using      (public.has_permission(company_id, 'payments', 'approve'))
  with check (public.has_permission(company_id, 'payments', 'approve'));

create policy check_vouchers_approve_update on public.check_vouchers
  for update to authenticated
  using      (public.has_permission(company_id, 'payables.vouchers', 'approve'))
  with check (public.has_permission(company_id, 'payables.vouchers', 'approve'));

create policy postdated_checks_approve_update on public.postdated_checks
  for update to authenticated
  using      (public.has_permission(company_id, 'payments.pdc', 'approve'))
  with check (public.has_permission(company_id, 'payments.pdc', 'approve'));

create policy purchase_requests_approve_update on public.purchase_requests
  for update to authenticated
  using      (public.has_permission(company_id, 'purchasing.requests', 'approve'))
  with check (public.has_permission(company_id, 'purchasing.requests', 'approve'));

create policy vendors_approve_update on public.vendors
  for update to authenticated
  using      (public.has_permission(company_id, 'purchasing.vendors', 'approve'))
  with check (public.has_permission(company_id, 'purchasing.vendors', 'approve'));
