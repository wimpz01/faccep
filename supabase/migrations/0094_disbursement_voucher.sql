/**
 * Money going out is a voucher, not a receipt.
 *
 * A refund was numbered from the same counter as collections, so paying a
 * tenant back produced OR-2026-00007 -- an Official Receipt handed to the
 * person who received the money. An OR evidences money coming in. A
 * disbursement needs its own document and its own series, which is what DV is.
 *
 * Collections keep the OR series untouched and existing numbers are not
 * changed. Only refunds move, and only from here on.
 *
 * WHICH FUND IS BEING RETURNED. A refund could always only return the security
 * deposit, because the trigger that recorded the drawdown assumed it. An
 * advance or prepayment is a different fund and is refundable too, so the
 * payment now says which one it returns and the drawdown follows that.
 *
 * This also repairs something the settlement work broke: removing 'refunded'
 * from the fund application form closed the only route an advance refund had.
 * It has one again, through the refund payment, where it belongs -- a refund
 * moves cash and so should never have been a bookkeeping-only entry.
 *
 * A deposit refund still needs its approved settlement. An advance does not:
 * there is nothing to deduct from it and nothing to forfeit, so requiring a
 * settlement would be ceremony with no decision inside it.
 */

alter table public.payments
  add column if not exists fund_kind public.contract_fund_kind;

comment on column public.payments.fund_kind is
  'Which fund a refund returns: the security deposit or the advance. Null on '
  'everything that is not a refund.';

-- Every refund on file today returned a deposit; that was all a refund could be.
update public.payments
   set fund_kind = 'security_deposit'
 where payment_kind = 'refund'
   and fund_kind is null;

/**
 * A refund names the fund it returns, and nothing else carries one.
 */
create or replace function public.guard_refund_fund_kind()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_kind = 'refund' then
    if new.fund_kind is null then
      new.fund_kind := 'security_deposit';
    end if;
  elsif new.fund_kind is not null then
    raise exception
      'Only a refund names a fund; a % does not return one.', new.payment_kind
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payments_guard_fund_kind on public.payments;
create trigger payments_guard_fund_kind
  before insert or update on public.payments
  for each row execute function public.guard_refund_fund_kind();

/**
 * The drawdown follows the fund the refund actually returned.
 */
create or replace function public.apply_refund_to_fund()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_kind <> 'refund' or new.contract_id is null then
    return null;
  end if;

  insert into public.contract_fund_applications
    (company_id, contract_id, fund_kind, event, applied_on, amount, note)
  values (new.company_id, new.contract_id,
          coalesce(new.fund_kind, 'security_deposit'), 'refunded',
          new.payment_date, new.amount,
          'Refunded by ' || new.payment_no);

  return null;
end;
$$;

/**
 * Only a deposit refund answers to a settlement.
 *
 * The advance has nothing to settle -- no deductions, no forfeiture -- so it
 * is bounded by what is left of it, which the fund guard already enforces.
 */
create or replace function public.guard_refund_needs_settlement()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_refundable numeric(14,2);
  v_paid       numeric(14,2);
begin
  if new.payment_kind <> 'refund'
     or new.contract_id is null
     or coalesce(new.fund_kind, 'security_deposit') <> 'security_deposit' then
    return new;
  end if;

  select t.refundable into v_refundable
    from public.deposit_settlement_totals t
   where t.contract_id = new.contract_id
     and t.status = 'approved';

  if v_refundable is null then
    raise exception
      'This deposit has not been settled yet. Settle it first -- record any '
      'deductions or forfeiture and have the settlement approved -- and the '
      'refundable amount will follow from that.'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(p.amount), 0) into v_paid
    from public.payments p
   where p.contract_id = new.contract_id
     and p.payment_kind = 'refund'
     and coalesce(p.fund_kind, 'security_deposit') = 'security_deposit'
     and p.status <> 'voided'
     and p.id is distinct from new.id;

  if v_paid + new.amount > v_refundable then
    raise exception
      'The approved settlement leaves % refundable and % has already been '
      'refunded, so % cannot be paid out.',
      to_char(v_refundable, 'FM999999990.00'),
      to_char(v_paid, 'FM999999990.00'),
      to_char(new.amount, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The DV series
-- ---------------------------------------------------------------------------

/**
 * Numbers a payment: OR for money in, DV for money out.
 *
 * Replaces the generic assign_document_no() on this one table. Both series
 * come from the same counter mechanism, so each is independently sequential
 * and neither can hand out a number twice.
 */
create or replace function public.assign_payment_no()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A number supplied explicitly (seed data, an import) is left alone.
  if new.payment_no is not null and btrim(new.payment_no) <> '' then
    return new;
  end if;

  if new.payment_kind = 'refund' then
    new.payment_no := public.next_document_no(
      new.company_id, 'disbursement_voucher', 'DV',
      extract(year from coalesce(new.payment_date, current_date))::integer, 5);
  else
    new.payment_no := public.next_document_no(
      new.company_id, 'payment', 'OR',
      extract(year from coalesce(new.payment_date, current_date))::integer, 5);
  end if;

  return new;
end;
$$;

comment on function public.assign_payment_no() is
  'OR-<year>-00001 for a collection, DV-<year>-00001 for a refund. Money out '
  'is a disbursement voucher and never an official receipt.';

drop trigger if exists assign_payment_no on public.payments;
create trigger assign_payment_no
  before insert on public.payments
  for each row execute function public.assign_payment_no();

/*
 * Carry over anything already numbered DV so a restored backup continues the
 * series rather than restarting it. Nothing matches today.
 */
insert into public.document_counters (company_id, doc_type, year, last_value)
select company_id, 'disbursement_voucher',
       (regexp_match(payment_no, '^DV-(\d{4})-(\d+)$'))[1]::integer,
       max((regexp_match(payment_no, '^DV-(\d{4})-(\d+)$'))[2]::integer)
  from public.payments
 where payment_no ~ '^DV-\d{4}-\d+$'
 group by company_id, (regexp_match(payment_no, '^DV-(\d{4})-(\d+)$'))[1]::integer
on conflict (company_id, doc_type, year)
  do update set last_value =
       greatest(document_counters.last_value, excluded.last_value);
