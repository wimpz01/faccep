/**
 * What a split receipt has to hold together.
 *
 * Separate from 0110 because a new enum value cannot be used in the same
 * transaction that adds it.
 *
 * The cheque part is stored and the cash part is what is left, rather than
 * storing both: two figures that must add to a third are two chances for them
 * not to. The one held is the cheque, because that is the figure written on
 * something and the one reconciliation has to find.
 */

alter table public.payments
  add column if not exists cheque_amount numeric(14, 2)
    check (cheque_amount is null or cheque_amount > 0);

comment on column public.payments.cheque_amount is
  'On a cash-and-cheque receipt, the cheque part. The rest of the amount is cash. Null on every other mode.';

/**
 * A split receipt is cash plus a cheque that is money today.
 *
 * Four things have to hold, and all of them are cheap to get wrong on a form:
 * the breakdown belongs only to a split; the cheque cannot be the whole
 * receipt (that is simply a cheque payment); it cannot be the whole receipt in
 * reverse either; and the cheque must not be dated ahead.
 */
create or replace function public.guard_split_payment()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.payment_mode = 'cash_check' then
    if new.cheque_amount is null then
      raise exception
        'Enter how much of the % was paid by cheque. The rest is taken as cash.',
        to_char(new.amount, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;

    if new.cheque_amount >= new.amount then
      raise exception
        'The cheque part must be less than the % total -- record it as a cheque payment if there is no cash with it.',
        to_char(new.amount, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;

    if new.check_date is null or new.check_bank is null then
      raise exception 'A cheque needs its bank and the date written on it.'
        using errcode = 'check_violation';
    end if;

    /*
     * The reason a split cannot carry a postdated cheque: the receipt would
     * count money that has not arrived. Such a cheque goes to the postdated
     * register on its own, and the cash is its own receipt.
     */
    if new.check_date > new.payment_date then
      raise exception
        'That cheque is dated ahead, so it cannot be receipted with cash. Record the postdated cheque on its own and the cash separately.'
        using errcode = 'check_violation';
    end if;
  elsif new.cheque_amount is not null then
    raise exception
      'A cheque part only belongs on a cash-and-cheque receipt.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger payments_guard_split
  before insert or update on public.payments
  for each row execute function public.guard_split_payment();
