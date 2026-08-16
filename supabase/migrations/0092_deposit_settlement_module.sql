/**
 * Settling a deposit gets its own permission, separate from the lease.
 *
 * 0090 hung the settlement off the contracts module, which meant that letting
 * a billing clerk record an 8,000 repair deduction also let them change the
 * rent, the escalation rate and the term on every lease in the company. That
 * is far more authority than the task needs, and the permission system is
 * per-module precisely so it does not have to be granted that way.
 *
 * So: contracts.deposits. Preparing a settlement is edit on it; approving one
 * is approve on it; seeing what is being refunded is view. The lease terms stay
 * behind the contracts module where they belong.
 *
 * Who gets what follows the segregation the work actually has -- the person
 * handling the cash is not the person deciding how much of it to keep:
 *
 *   Billing   prepares the settlement          view + edit
 *   Manager   approves it                      view + approve
 *   Cashier   pays out the approved refund     view
 *
 * Admins pass everything already, so nothing is granted to them here.
 */

insert into public.modules
  (key, label, module_group, description, sort_order, supports_approve, supports_void)
values
  ('contracts.deposits', 'Deposit Settlement', 'Tenants',
   'Settling a security deposit: deductions, forfeiture, and approving the '
   'refundable balance.',
   455, true, false)
on conflict (key) do update
  set label            = excluded.label,
      module_group     = excluded.module_group,
      description      = excluded.description,
      supports_approve = excluded.supports_approve;

/*
 * Existing roles keep working rather than silently losing the ability. Anyone
 * who could already edit contracts can prepare a settlement, and anyone who
 * could approve a contract can approve one -- which is exactly what they could
 * do yesterday. Narrowing from there is now a decision the company can make
 * per role instead of a consequence of how this was built.
 */
insert into public.role_permissions
  (role_id, module_key, can_view, can_edit, can_delete, can_approve, can_void)
select rp.role_id, 'contracts.deposits',
       rp.can_view, rp.can_edit, false, rp.can_approve, false
  from public.role_permissions rp
 where rp.module_key = 'contracts'
on conflict (role_id, module_key) do nothing;

-- A cashier pays the refund out, so she has to be able to see what was agreed.
update public.role_permissions rp
   set can_view = true
  from public.roles r
 where r.id = rp.role_id
   and rp.module_key = 'contracts.deposits'
   and lower(r.name) like '%cashier%';

-- ---------------------------------------------------------------------------
-- Point the settlement at its own module
-- ---------------------------------------------------------------------------

drop policy if exists deposit_settlements_read       on public.deposit_settlements;
drop policy if exists deposit_settlements_write      on public.deposit_settlements;
drop policy if exists deposit_settlement_lines_read  on public.deposit_settlement_lines;
drop policy if exists deposit_settlement_lines_write on public.deposit_settlement_lines;

create policy deposit_settlements_read on public.deposit_settlements
  for select to authenticated
  using (public.has_permission(company_id, 'contracts.deposits', 'view'));

create policy deposit_settlements_write on public.deposit_settlements
  for all to authenticated
  using (public.has_permission(company_id, 'contracts.deposits', 'edit'))
  with check (public.has_permission(company_id, 'contracts.deposits', 'edit'));

create policy deposit_settlement_lines_read on public.deposit_settlement_lines
  for select to authenticated
  using (exists (select 1 from public.deposit_settlements s
                  where s.id = settlement_id
                    and public.has_permission(s.company_id,
                          'contracts.deposits', 'view')));

create policy deposit_settlement_lines_write on public.deposit_settlement_lines
  for all to authenticated
  using (exists (select 1 from public.deposit_settlements s
                  where s.id = settlement_id
                    and public.has_permission(s.company_id,
                          'contracts.deposits', 'edit')))
  with check (exists (select 1 from public.deposit_settlements s
                       where s.id = settlement_id
                         and public.has_permission(s.company_id,
                               'contracts.deposits', 'edit')));

/**
 * Approval now answers to the deposit module rather than to the lease.
 *
 * Only the permission check changes; what approval does is unchanged from 0091.
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

  if not public.has_permission(s.company_id, 'contracts.deposits', 'approve') then
    raise exception
      'Approving a deposit settlement needs the approve right on Deposit Settlement.'
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
