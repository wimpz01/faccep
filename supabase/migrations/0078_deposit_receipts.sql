/**
 * A security deposit becomes a real transaction.
 *
 * Until now the deposit existed twice and agreed with nothing. The contract
 * said what was agreed at signing; the ledger had an account for it that was
 * never touched; and the two were joined by nothing at all. A deposit could be
 * agreed and never collected, and every screen would still say it was held.
 *
 * Three things change.
 *
 * A receipt can now name the contract it belongs to. A payment only ever knew
 * its tenant, and since each unit is its own contract, a tenant with three
 * units had three deposits that no receipt could tell apart.
 *
 * Refunding a deposit now records the drawdown against the contract as part of
 * the same statement that records the receipt. Before, a refund posted to the
 * ledger and left the contract still claiming the money was held -- two
 * records of one fact, disagreeing. A trigger is what makes that impossible,
 * rather than a screen remembering to do both.
 *
 * And what a contract holds is now what was actually received, not what was
 * agreed. contract_fund_status gains deposit_received and advance_received so
 * a fund that was never collected reads as nothing held, with the agreed
 * figure beside it. That figure is what account 2200 says, so the tenant page
 * and the balance sheet answer the same question the same way.
 */

alter table public.payments
  add column if not exists contract_id uuid
    references public.contracts (id) on delete restrict;

comment on column public.payments.contract_id is
  'The contract a deposit or refund belongs to. Required on those kinds, '
  'because each unit is its own contract and each carries its own deposit.';

create index if not exists payments_contract_idx
  on public.payments (contract_id) where contract_id is not null;

/**
 * A deposit or a refund has to say which contract it is for.
 *
 * Ordinary payments and prepayments settle invoices and need no contract: the
 * application says what they paid for.
 */
create or replace function public.guard_payment_contract()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if new.payment_kind in ('deposit', 'refund') then
    if new.contract_id is null then
      raise exception
        'A % has to name the contract it belongs to.',
        new.payment_kind
        using errcode = 'check_violation';
    end if;

    select tenant_id into v_tenant
      from public.contracts where id = new.contract_id;

    if v_tenant is distinct from new.tenant_id then
      raise exception
        'That contract belongs to a different tenant.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists payments_guard_contract on public.payments;
create trigger payments_guard_contract
  before insert or update on public.payments
  for each row execute function public.guard_payment_contract();

/**
 * Refunding a deposit draws it down on the contract, in the same breath.
 *
 * The receipt and the contract record are one fact written twice, so writing
 * the second is not left to whoever remembers. Refunding more than is held is
 * refused by the guard already on contract_fund_applications, which means the
 * receipt fails too rather than posting a refund the contract cannot support.
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
  values (new.company_id, new.contract_id, 'security_deposit', 'refunded',
          new.payment_date, new.amount,
          'Refunded by ' || new.payment_no);

  return null;
end;
$$;

drop trigger if exists payments_refund_draws_fund on public.payments;
create trigger payments_refund_draws_fund
  after insert on public.payments
  for each row execute function public.apply_refund_to_fund();

/**
 * What is held is what came in, less what has been given up.
 *
 * deposit_taken keeps saying what the contract agreed -- that is the number a
 * refund is argued against years later -- while deposit_received says what was
 * actually banked and deposit_remaining is derived from that. A deposit that
 * was agreed and never collected now reads: taken 70,000, received 0, held 0.
 */
-- Dropped rather than replaced: a new column lands in the middle of the list,
-- and "create or replace view" may only append.
drop view if exists public.contract_fund_status;

create view public.contract_fund_status
with (security_invoker = true) as
  select
    c.id         as contract_id,
    c.company_id,
    c.security_deposit                                            as deposit_taken,
    coalesce(r.deposit_in, 0)                                     as deposit_received,
    coalesce(d.drawn, 0)                                          as deposit_drawn,
    coalesce(r.deposit_in, 0) - coalesce(d.drawn, 0)              as deposit_remaining,
    case
      when coalesce(c.security_deposit, 0) = 0    then 'none'
      when coalesce(r.deposit_in, 0) = 0          then 'not_received'
      when coalesce(d.drawn, 0) = 0               then 'held'
      when coalesce(d.drawn, 0) < coalesce(r.deposit_in, 0)
                                                  then 'partially_applied'
      when coalesce(d.refunded, 0) >= coalesce(d.applied, 0)
                                                  then 'refunded'
      else 'fully_applied'
    end                                                           as deposit_status,
    c.advance_payment                                             as advance_taken,
    coalesce(a.drawn, 0)                                          as advance_drawn,
    c.advance_payment - coalesce(a.drawn, 0)                      as advance_remaining,
    case
      when coalesce(c.advance_payment, 0) = 0     then 'none'
      when coalesce(a.drawn, 0) = 0               then 'held'
      when coalesce(a.drawn, 0) < c.advance_payment
                                                  then 'partially_applied'
      when coalesce(a.refunded, 0) >= coalesce(a.applied, 0)
                                                  then 'refunded'
      else 'fully_applied'
    end                                                           as advance_status
  from public.contracts c
  left join (
    select contract_id,
           sum(amount)                                        as drawn,
           sum(amount) filter (where event = 'refunded')      as refunded,
           sum(amount) filter (where event <> 'refunded')     as applied
      from public.contract_fund_applications
     where fund_kind = 'security_deposit'
     group by contract_id
  ) d on d.contract_id = c.id
  left join (
    select contract_id,
           sum(amount)                                        as drawn,
           sum(amount) filter (where event = 'refunded')      as refunded,
           sum(amount) filter (where event <> 'refunded')     as applied
      from public.contract_fund_applications
     where fund_kind = 'advance_payment'
     group by contract_id
  ) a on a.contract_id = c.id
  left join (
    select contract_id, sum(amount) as deposit_in
      from public.payments
     where payment_kind = 'deposit'
       and status <> 'voided'
       and contract_id is not null
     group by contract_id
  ) r on r.contract_id = c.id;

grant select on public.contract_fund_status to authenticated;

/**
 * A drawdown cannot exceed what was received.
 *
 * 0067 measured against the contract's agreed figure, which was the only thing
 * there was. Now that receipts exist, the money actually in hand is the real
 * ceiling -- otherwise a deposit that was never collected could still be
 * refunded, paying out cash the tenant never handed over.
 */
create or replace function public.guard_contract_fund_application()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_held  numeric(14,2);
  v_drawn numeric(14,2);
  v_no    text;
begin
  select c.contract_no into v_no
    from public.contracts c where c.id = new.contract_id;

  if new.fund_kind = 'security_deposit' then
    select coalesce(sum(p.amount), 0) into v_held
      from public.payments p
     where p.contract_id = new.contract_id
       and p.payment_kind = 'deposit'
       and p.status <> 'voided';
  else
    select coalesce(c.advance_payment, 0) into v_held
      from public.contracts c where c.id = new.contract_id;
  end if;

  select coalesce(sum(amount), 0) into v_drawn
    from public.contract_fund_applications
   where contract_id = new.contract_id
     and fund_kind = new.fund_kind
     and id is distinct from new.id;

  if v_drawn + new.amount > v_held then
    raise exception
      'Only % of the % on % is left, so % cannot be taken from it.',
      to_char(v_held - v_drawn, 'FM999999990.00'),
      replace(new.fund_kind::text, '_', ' '),
      v_no,
      to_char(new.amount, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
