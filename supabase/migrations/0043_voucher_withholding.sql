-- Withholding tax can be taken when the supplier is paid, not only when the
-- bill is recorded.
--
-- BIR expanded withholding is withheld upon payment. Taking it at invoice time
-- suits a bill you already know is subject to it, but a cheque is often cut
-- for invoices booked gross -- and the cashier is the one who decides to avail
-- of it. The voucher can now carry the deduction itself.
--
-- The supplier's payable is still settled in full: they receive cash for the
-- net and BIR Form 2307 for the rest.

alter table public.check_vouchers
  add column if not exists withholding_tax numeric(14, 2) not null default 0
    check (withholding_tax >= 0);

comment on column public.check_vouchers.withholding_tax is
  'Creditable tax withheld on payment. Cash paid is amount less this.';

/**
 * Withholding is only lawful against a VAT-registered supplier, and never
 * exceeds what is being paid.
 */
create or replace function public.guard_voucher_withholding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vatable boolean;
begin
  if new.withholding_tax = 0 then
    return new;
  end if;

  if new.withholding_tax > new.amount then
    raise exception
      'Withholding of % cannot exceed the % being paid.',
      to_char(new.withholding_tax, 'FM999,999,990.00'),
      to_char(new.amount, 'FM999,999,990.00')
      using errcode = 'check_violation';
  end if;

  select is_vatable into v_vatable
    from public.vendors where id = new.vendor_id;

  if not coalesce(v_vatable, false) then
    raise exception
      'Nothing is withheld from a supplier that is not VAT-registered.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists check_vouchers_guard_withholding on public.check_vouchers;
create trigger check_vouchers_guard_withholding
  before insert or update of withholding_tax, amount, vendor_id
  on public.check_vouchers
  for each row execute function public.guard_voucher_withholding();

/**
 *   DR Accounts Payable            the whole balance settled
 *     CR Withholding Tax Payable   held back for the BIR
 *     CR Cash                      what the supplier actually receives
 */
create or replace function public.post_voucher_release()
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
  if not found or s.ap_account_id is null then
    return null;
  end if;

  if new.status = 'cancelled' and old.status = 'released' then
    perform public.reverse_posting(
      new.company_id, 'check_vouchers', new.id, 'release', 'voucher cancelled');
    return null;
  end if;

  if not (new.status = 'released' and old.status <> 'released') then
    return null;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account', s.ap_account_id,
                       'description', 'Settlement of supplier balances',
                       'debit', new.amount, 'credit', 0));

  if new.withholding_tax > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.withholding_tax_id,
      'description', 'Creditable tax withheld on payment',
      'debit', 0, 'credit', new.withholding_tax));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', s.cash_account_id,
    'description', coalesce('Cheque ' || new.check_no, 'Cash paid'),
    'debit', 0, 'credit', round(new.amount - new.withholding_tax, 2)));

  perform public.post_journal(
    new.company_id, new.voucher_date,
    'Voucher ' || new.voucher_no,
    'check_vouchers', new.id, 'release', v_lines);

  return null;
end;
$$;
