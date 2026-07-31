-- Transactions that do not proceed are cancelled, not deleted.
--
-- A draft that is simply removed leaves no trace of the work, the decision, or
-- the reason. Cancelling keeps the document and its lines exactly as they were
-- and records why it went no further -- the same treatment a released invoice
-- already gets, minus the approval gate, since a draft never reached the
-- ledger in the first place.

-- ---------------------------------------------------------------------------
-- Journal entries: allow draft -> cancelled, and freeze once cancelled
-- ---------------------------------------------------------------------------

create or replace function public.guard_journal_entry()
returns trigger
language plpgsql
as $$
declare
  v_debit  numeric(14, 2);
  v_credit numeric(14, 2);
  v_lines  integer;
  v_closed integer;
begin
  if old.status = 'cancelled' then
    raise exception 'This journal entry is cancelled and can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  -- A cancellation may only be applied to a draft; anything posted is
  -- corrected by reversal instead.
  if new.status = 'cancelled' and old.status <> 'draft' then
    raise exception 'Only a draft journal entry can be cancelled. Reverse a posted entry instead.'
      using errcode = 'check_violation';
  end if;

  if old.status in ('posted', 'reversed')
     and new.status = old.status
     and (new.entry_date is distinct from old.entry_date
       or new.memo      is distinct from old.memo
       or new.entry_no  is distinct from old.entry_no) then
    raise exception 'A posted journal entry cannot be edited. Reverse it instead.'
      using errcode = 'check_violation';
  end if;

  if new.status = 'posted' and old.status = 'draft' then
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      into v_debit, v_credit, v_lines
      from public.journal_lines where entry_id = new.id;

    if v_lines = 0 then
      raise exception 'Add at least two lines before posting.'
        using errcode = 'check_violation';
    end if;

    if v_debit <> v_credit then
      raise exception 'Entry does not balance: debits % vs credits %.', v_debit, v_credit
        using errcode = 'check_violation';
    end if;

    select count(*) into v_closed
      from public.accounting_periods p
     where p.company_id = new.company_id
       and p.status = 'closed'
       and new.entry_date between p.start_date and p.end_date;

    if v_closed > 0 then
      raise exception 'That date falls in a closed accounting period.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Readiness: cancelled documents are settled, so they no longer block
-- ---------------------------------------------------------------------------

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

  return query
    select 'blocker', 'Draft invoices', count(*),
           'Release them, or cancel them if they will not proceed. '
             || coalesce(string_agg(i.invoice_no, ', ' order by i.invoice_no), '')
      from public.invoices i
     where i.company_id = p.company_id
       and i.status = 'draft'
       and i.invoice_date between p.start_date and p.end_date
    having count(*) > 0;

  return query
    select 'blocker', 'Draft journal entries', count(*),
           'Post them, or cancel them if they will not proceed. '
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
           'Release them, or cancel them if they will not proceed — a voucher keeps '
             || 'its own date, so releasing it later would post into the closed period. '
             || coalesce(string_agg(cv.voucher_no, ', ' order by cv.voucher_no), '')
      from public.check_vouchers cv
     where cv.company_id = p.company_id
       and cv.status in ('draft', 'approved')
       and cv.voucher_date between p.start_date and p.end_date
    having count(*) > 0;

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
