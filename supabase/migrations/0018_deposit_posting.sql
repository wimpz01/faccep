-- Books a security deposit against the liability it creates.
--
--   deposit received:  DR Cash                        CR Security Deposits Payable
--   deposit refunded:  DR Security Deposits Payable   CR Cash
--
-- Before this, only the refund side existed, so returning a deposit pushed the
-- liability negative against a balance that had never been booked.

create or replace function public.post_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_lines jsonb;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ar_account_id is null then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.status = 'voided' and old.status <> 'voided' then
      perform public.reverse_posting(
        new.company_id, 'payments', new.id, 'receipt',
        coalesce(new.void_reason, 'voided'));
    end if;
    return null;
  end if;

  if new.payment_kind = 'refund' then
    v_lines := jsonb_build_array(
      jsonb_build_object('account', s.security_deposit_id,
                         'description', 'Deposit refunded ' || new.payment_no,
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.cash_account_id,
                         'description', 'Cash paid out',
                         'debit', 0, 'credit', new.amount));

  elsif new.payment_kind = 'deposit' then
    v_lines := jsonb_build_array(
      jsonb_build_object('account', s.cash_account_id,
                         'description', 'Deposit received ' || new.payment_no,
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.security_deposit_id,
                         'description', 'Refundable to tenant',
                         'debit', 0, 'credit', new.amount));

  else
    v_lines := jsonb_build_array(
      jsonb_build_object('account', s.cash_account_id,
                         'description', 'Receipt ' || new.payment_no,
                         'debit', new.amount, 'credit', 0),
      jsonb_build_object('account', s.customer_advances_id,
                         'description', 'Unapplied customer credit',
                         'debit', 0, 'credit', new.amount));
  end if;

  perform public.post_journal(
    new.company_id, new.payment_date,
    'Payment ' || new.payment_no,
    'payments', new.id, 'receipt', v_lines);

  return null;
end;
$$;

/**
 * A deposit is held against the tenant, not against a bill, so it must not be
 * applied to invoices. A refund likewise settles nothing.
 */
create or replace function public.guard_payment_application()
returns trigger
language plpgsql
as $$
declare
  v_kind public.payment_kind;
begin
  select payment_kind into v_kind from public.payments where id = new.payment_id;

  if v_kind in ('deposit', 'refund') then
    raise exception
      'A % cannot be applied to an invoice — it is held against the tenant, not against a bill.',
      v_kind
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger payment_applications_guard_kind
  before insert on public.payment_applications
  for each row execute function public.guard_payment_application();
