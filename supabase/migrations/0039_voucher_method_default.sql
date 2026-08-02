-- Infer the payment method rather than demanding it.
--
-- 0038 raised when a plain payment arrived without a method, which broke every
-- existing caller that reasonably did not care -- a voucher is a payment by
-- cash unless something says otherwise, and a cheque number says otherwise.
-- Only a prepayment keeps a hard requirement, because "postdated cheque" is
-- the whole meaning of that kind.

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

    -- A cheque number means it went out by cheque; otherwise assume cash.
    if new.payment_method is null then
      new.payment_method := case
        when new.check_no is not null then 'check'::public.voucher_payment_method
        else 'cash'::public.voucher_payment_method
      end;
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
