/**
 * Posting a bill on request works for the service role too.
 *
 * The check called has_permission(), which resolves against auth.uid(). A
 * maintenance script or the service role has no signed-in user, so it came
 * back false and the posting was refused -- the same trap the negative-stock
 * guard avoids by skipping when there is nobody to check.
 *
 * The rule is unchanged for real users: recording a bill still needs Edit on
 * payables.invoices.
 */
create or replace function public.post_supplier_invoice_now(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from public.supplier_invoices i
     where i.id = p_invoice
       and public.has_permission(i.company_id, 'payables.invoices', 'edit')) then
    raise exception 'Not allowed to post this bill.' using errcode = '42501';
  end if;

  perform public.post_supplier_invoice_row(p_invoice);
end;
$$;
