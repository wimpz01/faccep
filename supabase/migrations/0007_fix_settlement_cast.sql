-- recalculate_invoice_settlement assigned bare text literals to a column of
-- type invoice_status. Postgres will not infer that cast inside a CASE, so
-- every payment application and credit memo failed at the trigger.

create or replace function public.recalculate_invoice_settlement(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid     numeric(14, 2);
  v_credited numeric(14, 2);
  v_total    numeric(14, 2);
  v_status   public.invoice_status;
begin
  select i.total, i.status into v_total, v_status
    from public.invoices i where i.id = p_invoice_id;

  if v_status is null or v_status = 'cancelled' then
    return;
  end if;

  select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_applications pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = p_invoice_id
     and p.status = 'posted';

  select coalesce(sum(cm.amount), 0) into v_credited
    from public.credit_memos cm
   where cm.invoice_id = p_invoice_id;

  update public.invoices
     set amount_paid     = v_paid,
         credited_amount = v_credited,
         status = case
                    when status = 'draft' then 'draft'::public.invoice_status
                    when v_paid + v_credited >= v_total
                      then 'paid'::public.invoice_status
                    when v_paid + v_credited > 0
                      then 'partially_paid'::public.invoice_status
                    else 'released'::public.invoice_status
                  end
   where id = p_invoice_id;
end;
$$;
