-- What a cheque voucher is for.
--
-- Vouchers were all the same thing: money going out today. Four cases actually
-- occur, and they behave differently enough that lumping them together loses
-- information the cashier needs.
--
--   payment    -- settled on the day, by cash, a dated cheque or online
--   prepayment -- a postdated cheque handed over now, payable later
--   void       -- a payment that did not proceed, reversed
--   refund     -- the supplier could not supply and sent the money back
--
-- void and refund are separate documents that point at the voucher they undo,
-- rather than edits to it. A released payment is a fact; what happened next is
-- another fact, and the trail has to show both.

create type public.voucher_kind as enum (
  'payment',
  'prepayment',
  'void',
  'refund'
);

create type public.voucher_payment_method as enum ('cash', 'check', 'online');

alter table public.check_vouchers
  add column if not exists voucher_kind public.voucher_kind not null default 'payment',
  add column if not exists payment_method public.voucher_payment_method,
  -- The date written on the cheque. For a prepayment it is in the future,
  -- which is what makes the cheque postdated.
  add column if not exists check_date date,
  add column if not exists reverses_voucher_id uuid
    references public.check_vouchers (id) on delete restrict,
  add column if not exists cleared_at date;

comment on column public.check_vouchers.voucher_kind is
  'payment = settled today; prepayment = postdated cheque; void = reversal of '
  'a payment that did not proceed; refund = supplier returned the money.';
comment on column public.check_vouchers.check_date is
  'Date on the cheque. Future on a prepayment.';
comment on column public.check_vouchers.cleared_at is
  'When a postdated cheque was actually honoured by the bank.';

create index if not exists check_vouchers_kind_idx
  on public.check_vouchers (company_id, voucher_kind, status);
create index if not exists check_vouchers_maturity_idx
  on public.check_vouchers (company_id, check_date)
  where voucher_kind = 'prepayment' and cleared_at is null;

-- Everything already on file was a plain payment.
update public.check_vouchers
   set payment_method = case when check_no is not null then 'check'::public.voucher_payment_method
                             else 'cash'::public.voucher_payment_method end
 where voucher_kind = 'payment' and payment_method is null;

/**
 * The shape each kind has to have.
 *
 * Enforced here rather than in the form so a voucher cannot be left in a state
 * the rest of the system does not expect -- a prepayment with no date to mature
 * on, or a void that reverses nothing.
 */
create or replace function public.guard_voucher_kind()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_original public.check_vouchers%rowtype;
begin
  if new.voucher_kind in ('payment', 'prepayment') then
    if new.reverses_voucher_id is not null then
      raise exception 'A % voucher does not reverse anything.', new.voucher_kind
        using errcode = 'check_violation';
    end if;
    if new.payment_method is null then
      raise exception 'Say how this % is being paid.', new.voucher_kind
        using errcode = 'check_violation';
    end if;
  end if;

  if new.voucher_kind = 'prepayment' then
    if new.payment_method <> 'check' then
      raise exception 'A prepayment is a postdated cheque, so the method must be a cheque.'
        using errcode = 'check_violation';
    end if;
    if new.check_date is null then
      raise exception 'A postdated cheque needs the date written on it.'
        using errcode = 'check_violation';
    end if;
    -- Dated today or earlier is not postdated; that is an ordinary payment.
    if new.check_date <= new.voucher_date then
      raise exception 'A prepayment cheque must be dated after %, or it is an ordinary payment.',
        to_char(new.voucher_date, 'DD Mon YYYY')
        using errcode = 'check_violation';
    end if;
  end if;

  if new.voucher_kind in ('void', 'refund') then
    if new.reverses_voucher_id is null then
      raise exception 'A % has to say which voucher it undoes.', new.voucher_kind
        using errcode = 'check_violation';
    end if;

    select * into v_original from public.check_vouchers
     where id = new.reverses_voucher_id;

    if not found then
      raise exception 'The voucher being undone was not found.'
        using errcode = 'check_violation';
    end if;
    if v_original.voucher_kind in ('void', 'refund') then
      raise exception 'Cannot undo a % voucher.', v_original.voucher_kind
        using errcode = 'check_violation';
    end if;
    if new.amount > v_original.amount then
      raise exception 'Cannot return more than the % of voucher %.',
        to_char(v_original.amount, 'FM999,999,990.00'), v_original.voucher_no
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_voucher_kind on public.check_vouchers;
create trigger guard_voucher_kind
  before insert or update on public.check_vouchers
  for each row execute function public.guard_voucher_kind();
