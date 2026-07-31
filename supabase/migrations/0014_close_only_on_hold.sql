-- Period close readiness, narrowed to transactions genuinely on hold.
--
-- Removed: unpaid invoices and unpaid supplier invoices. A released invoice is
-- a finished transaction whether or not the money has arrived; the receivable
-- carries forward and has no bearing on whether the period can close. Listing
-- it was noise.
--
-- Promoted to blocker: cheque vouchers prepared but not released. A voucher
-- keeps its own date, so releasing it after the period closes would try to
-- post into a closed period and fail -- the same stranding problem a draft
-- invoice causes.

create or replace function public.period_close_readiness(p_period uuid)
returns table (
  severity    text,
  kind        text,
  item_count  bigint,
  detail      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  p public.accounting_periods%rowtype;
begin
  select * into p from public.accounting_periods where id = p_period;
  if not found then
    return;
  end if;

  -- ---- Blockers: on hold, and dated inside the period ---------------------

  return query
    select 'blocker', 'Draft invoices', count(*),
           'Release or delete them — a draft dated in a closed period can never be posted. '
             || coalesce(string_agg(i.invoice_no, ', ' order by i.invoice_no), '')
      from public.invoices i
     where i.company_id = p.company_id
       and i.status = 'draft'
       and i.invoice_date between p.start_date and p.end_date
    having count(*) > 0;

  return query
    select 'blocker', 'Draft journal entries', count(*),
           'Post or delete them. '
             || coalesce(string_agg(e.entry_no, ', ' order by e.entry_no), '')
      from public.journal_entries e
     where e.company_id = p.company_id
       and e.status = 'draft'
       and e.entry_date between p.start_date and p.end_date
    having count(*) > 0;

  return query
    select 'blocker', 'Approvals still pending', count(*),
           'Decide them first — approving after the close would need to post into it.'
      from public.approval_requests a
     where a.company_id = p.company_id
       and a.status = 'pending'
       and (
         exists (select 1 from public.invoices i
                  where i.id = a.entity_id
                    and a.entity_table = 'invoices'
                    and i.invoice_date between p.start_date and p.end_date)
         or exists (select 1 from public.payments pay
                     where pay.id = a.entity_id
                       and a.entity_table = 'payments'
                       and pay.payment_date between p.start_date and p.end_date)
       )
    having count(*) > 0;

  return query
    select 'blocker', 'Cheque vouchers not released', count(*),
           'Release or cancel them — a voucher keeps its own date, so releasing it '
             || 'later would try to post into the closed period. '
             || coalesce(string_agg(cv.voucher_no, ', ' order by cv.voucher_no), '')
      from public.check_vouchers cv
     where cv.company_id = p.company_id
       and cv.status in ('draft', 'approved')
       and cv.voucher_date between p.start_date and p.end_date
    having count(*) > 0;

  -- ---- Notes: open operationally, but nothing gets stranded ---------------

  return query
    select 'warning', 'Utility periods still open', count(*),
           'Readings can still change, which would alter the next billing run.'
      from public.utility_periods up
     where up.company_id = p.company_id
       and not up.is_locked
       and up.period_start between p.start_date and p.end_date
    having count(*) > 0;

  return query
    select 'warning', 'Purchase orders still open', count(*),
           'Issued but not fully received. Goods arriving later are dated on receipt, '
             || 'so this does not block the close.'
      from public.purchase_orders po
     where po.company_id = p.company_id
       and po.status in ('issued', 'partially_received')
       and po.order_date between p.start_date and p.end_date
    having count(*) > 0;
end;
$$;
