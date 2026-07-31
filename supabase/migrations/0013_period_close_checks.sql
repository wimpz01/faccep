-- Period close readiness.
--
-- A period cannot be closed while unposted documents are dated inside it:
-- closing locks the ledger for those dates, so a draft invoice left behind
-- could never be posted afterwards. Those are hard blockers.
--
-- Outstanding balances are a different matter. An unpaid receivable at
-- month end is ordinary and carries forward, so those are reported as
-- warnings and never prevent a close.

/**
 * Everything standing between a period and its close.
 *
 * severity is 'blocker' or 'warning'. The UI lists both; the trigger below
 * only refuses on blockers.
 */
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

  -- ---- Blockers: unposted documents dated in the period --------------------

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

  -- ---- Warnings: legitimate carry-forward ---------------------------------

  return query
    select 'warning', 'Invoices still unpaid', count(*),
           'Total outstanding ' || to_char(
             coalesce(sum(i.total - i.amount_paid - i.credited_amount), 0),
             'FM999,999,999.00')
             || ' — this carries forward and does not block the close.'
      from public.invoices i
     where i.company_id = p.company_id
       and i.status in ('released', 'partially_paid')
       and i.invoice_date between p.start_date and p.end_date
       and (i.total - i.amount_paid - i.credited_amount) > 0
    having count(*) > 0;

  return query
    select 'warning', 'Supplier invoices unpaid', count(*),
           'Total outstanding ' || to_char(
             coalesce(sum(si.total - si.amount_paid), 0), 'FM999,999,999.00')
             || ' — carries forward as payables.'
      from public.supplier_invoices si
     where si.company_id = p.company_id
       and si.status in ('open', 'partially_paid')
       and si.invoice_date between p.start_date and p.end_date
    having count(*) > 0;

  return query
    select 'warning', 'Cheque vouchers not released', count(*),
           'Prepared but not released, so nothing has hit the ledger yet.'
      from public.check_vouchers cv
     where cv.company_id = p.company_id
       and cv.status in ('draft', 'approved')
       and cv.voucher_date between p.start_date and p.end_date
    having count(*) > 0;

  return query
    select 'warning', 'Utility periods still open', count(*),
           'Readings can still change, which would alter next month''s billing.'
      from public.utility_periods up
     where up.company_id = p.company_id
       and not up.is_locked
       and up.period_start between p.start_date and p.end_date
    having count(*) > 0;

  return query
    select 'warning', 'Purchase orders still open', count(*),
           'Issued but not fully received.'
      from public.purchase_orders po
     where po.company_id = p.company_id
       and po.status in ('issued', 'partially_received')
       and po.order_date between p.start_date and p.end_date
    having count(*) > 0;
end;
$$;

/** Refuses the close while any blocker stands. */
create or replace function public.guard_period_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_summary text;
begin
  if not (new.status = 'closed' and old.status <> 'closed') then
    return new;
  end if;

  select string_agg(kind || ' (' || item_count || ')', '; ' order by kind)
    into v_summary
    from public.period_close_readiness(new.id)
   where severity = 'blocker';

  if v_summary is not null then
    raise exception
      'Cannot close %: there are unposted items dated inside it — %. Clear them first.',
      new.name, v_summary
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger accounting_periods_guard_close
  before update of status on public.accounting_periods
  for each row execute function public.guard_period_close();
