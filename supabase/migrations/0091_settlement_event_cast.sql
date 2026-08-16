/**
 * The settlement's event needs an explicit cast.
 *
 * A CASE over a text literal yields text, and contract_fund_applications.event
 * is an enum, so the insert in 0090 was rejected outright. The approval could
 * never have run; this is the same function with the cast in place.
 */

create or replace function public.approve_deposit_settlement(p_settlement uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.deposit_settlements%rowtype;
  cfg      public.accounting_settings%rowtype;
  v_held   numeric(14,2);
  v_kept   numeric(14,2);
  v_lines  jsonb := '[]'::jsonb;
  line     record;
begin
  select * into s from public.deposit_settlements where id = p_settlement;
  if not found then
    raise exception 'That settlement no longer exists.';
  end if;

  if not public.has_permission(s.company_id, 'contracts', 'approve') then
    raise exception
      'Approving a deposit settlement needs the approve right on contracts.'
      using errcode = 'insufficient_privilege';
  end if;

  if s.status <> 'draft' then
    raise exception 'This settlement has already been %.', s.status
      using errcode = 'check_violation';
  end if;

  select coalesce(f.deposit_remaining, 0) into v_held
    from public.contract_fund_status f
   where f.contract_id = s.contract_id;

  if coalesce(v_held, 0) <= 0 then
    raise exception
      'There is no deposit left on this contract to settle.'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_kept
    from public.deposit_settlement_lines where settlement_id = s.id;

  if v_kept > v_held then
    raise exception
      'The settlement keeps % but only % of the deposit is held.',
      to_char(v_kept, 'FM999999990.00'), to_char(v_held, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  select * into cfg from public.accounting_settings where company_id = s.company_id;
  if cfg.security_deposit_id is null then
    raise exception
      'No Security Deposits Payable account is set for this company.'
      using errcode = 'check_violation';
  end if;

  for line in
    select * from public.deposit_settlement_lines
     where settlement_id = s.id order by created_at
  loop
    insert into public.contract_fund_applications
      (company_id, contract_id, fund_kind, event, applied_on, amount,
       invoice_id, note, created_by)
    values (s.company_id, s.contract_id, 'security_deposit',
            (case line.kind
               when 'forfeiture' then 'forfeited'
               else 'applied'
             end)::public.contract_fund_event,
            s.settled_on, line.amount, line.invoice_id,
            line.description, auth.uid());

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', cfg.security_deposit_id,
                         'description', line.description,
                         'debit', line.amount, 'credit', 0),
      jsonb_build_object(
        'account',
        case
          when line.kind = 'forfeiture' then cfg.other_income_id
          when line.invoice_id is not null then cfg.ar_account_id
          else cfg.maintenance_expense_id
        end,
        'description', line.description,
        'debit', 0, 'credit', line.amount));
  end loop;

  if jsonb_array_length(v_lines) > 0 then
    perform public.post_journal(
      s.company_id, s.settled_on,
      'Deposit settlement on ' ||
        (select contract_no from public.contracts where id = s.contract_id),
      'deposit_settlements', s.id, 'settlement', v_lines);
  end if;

  update public.deposit_settlements
     set status       = 'approved',
         deposit_held = v_held,
         approved_by  = auth.uid(),
         approved_at  = now()
   where id = s.id;
end;
$$;
