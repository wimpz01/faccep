/**
 * Settling a security deposit: one document, approved once, that moves both
 * the contract record and the books.
 *
 * Until now a deposit could be drawn down a line at a time from a form, and
 * nothing about that reached the ledger. The money stayed in Security Deposits
 * Payable whatever became of it, so a deposit spent on repairs and a deposit
 * still owed to the tenant looked identical on the balance sheet. There was
 * also no moment at which anyone said "this is the final reckoning" -- two
 * people could each record half of it and neither would see the whole.
 *
 * A settlement is that moment. It lists what is being kept and why, works out
 * what is left to give back, and on approval does three things at once: writes
 * the drawdowns against the contract, posts the journal entry, and releases the
 * refund. Before approval it is a draft and moves nothing.
 *
 * WHAT POSTS, AND WHY (Philippine treatment, per RR 16-2005 s4.108-3(a) and the
 * BIR's position on forfeiture):
 *
 *   Deduction settling an unpaid bill   Dr Security Deposits Payable
 *                                       Cr Accounts Receivable
 *     The rental was already invoiced and already carried its output VAT, so
 *     applying the deposit settles the receivable and raises no further tax.
 *
 *   Deduction for repair or damage      Dr Security Deposits Payable
 *                                       Cr Repairs and Maintenance
 *     Recorded as a recovery against the cost rather than as income, so the
 *     expense account shows what the repair actually cost the company after
 *     the tenant's share. No invoice, so no VAT.
 *
 *   Forfeiture                          Dr Security Deposits Payable
 *                                       Cr Other Income
 *     A forfeited deposit stops being refundable and becomes income in the
 *     period it is forfeited. No invoice is raised, so no output VAT.
 *
 * The refund itself is not posted here. It is a payment, and it posts when the
 * payment is recorded, exactly as it does now.
 */

create type public.deposit_settlement_status as enum (
  'draft',
  'approved',
  'cancelled'
);

create type public.deposit_settlement_line_kind as enum (
  'deduction',   -- kept to cover a bill, a repair or damage
  'forfeiture'   -- kept under the contract's forfeiture terms
);

create table public.deposit_settlements (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  contract_id  uuid not null references public.contracts (id) on delete restrict,
  status       public.deposit_settlement_status not null default 'draft',
  settled_on   date not null default current_date,
  -- What was held when the settlement was approved, kept so the document still
  -- reads correctly years later however the contract record changes.
  deposit_held numeric(14,2) not null default 0,
  notes        text,
  prepared_by  uuid references public.profiles (id),
  approved_by  uuid references public.profiles (id),
  approved_at  timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.deposit_settlements is
  'The final reckoning on one contract''s security deposit: what is kept, what '
  'is refundable, approved once. Nothing moves until it is approved.';

-- One live settlement per contract. A cancelled one is history and does not
-- stand in the way of doing it again.
create unique index deposit_settlements_one_live
  on public.deposit_settlements (contract_id)
  where status <> 'cancelled';

create index deposit_settlements_company_idx
  on public.deposit_settlements (company_id, status);

create table public.deposit_settlement_lines (
  id            uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.deposit_settlements (id)
                  on delete cascade,
  kind          public.deposit_settlement_line_kind not null default 'deduction',
  description   text not null,
  amount        numeric(14,2) not null check (amount > 0),
  -- Names the bill this deduction settles, where it settles one. That is what
  -- decides whether the credit goes to receivables or to the repair cost.
  invoice_id    uuid references public.invoices (id) on delete restrict,
  created_at    timestamptz not null default now(),
  constraint deposit_settlement_lines_forfeiture_has_no_invoice
    check (kind = 'deduction' or invoice_id is null)
);

create index deposit_settlement_lines_settlement_idx
  on public.deposit_settlement_lines (settlement_id);

-- ---------------------------------------------------------------------------
-- What a settlement adds up to
-- ---------------------------------------------------------------------------

create view public.deposit_settlement_totals
with (security_invoker = true) as
  select
    s.id                                                as settlement_id,
    s.contract_id,
    s.company_id,
    s.status,
    coalesce(sum(l.amount) filter (where l.kind = 'deduction'), 0)  as deductions,
    coalesce(sum(l.amount) filter (where l.kind = 'forfeiture'), 0) as forfeited,
    coalesce(sum(l.amount), 0)                                      as kept,
    s.deposit_held - coalesce(sum(l.amount), 0)                     as refundable
  from public.deposit_settlements s
  left join public.deposit_settlement_lines l on l.settlement_id = s.id
 group by s.id;

grant select on public.deposit_settlement_totals to authenticated;

-- ---------------------------------------------------------------------------
-- A draft is editable; an approved settlement is not
-- ---------------------------------------------------------------------------

create or replace function public.guard_settlement_frozen()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status public.deposit_settlement_status;
begin
  select status into v_status
    from public.deposit_settlements
   where id = coalesce(new.settlement_id, old.settlement_id);

  if v_status <> 'draft' then
    raise exception
      'This settlement has been approved, so its lines can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger deposit_settlement_lines_frozen
  before insert or update or delete on public.deposit_settlement_lines
  for each row execute function public.guard_settlement_frozen();

-- ---------------------------------------------------------------------------
-- Approval: writes the drawdowns, posts the entry, releases the refund
-- ---------------------------------------------------------------------------

/**
 * Approving a settlement is the only thing that moves money.
 *
 * SECURITY DEFINER because it writes the ledger, which no signed-in user may
 * touch directly. The permission is checked here rather than trusted from the
 * caller: has_permission() already lets a company admin through everything, so
 * granting 'approve' on contracts is what nominates anyone else.
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

  -- What is genuinely left: received, less anything already drawn down.
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

  /*
   * One drawdown per line against the contract, and one journal line pair.
   * The contract record and the ledger are written from the same loop so they
   * cannot disagree about what was kept.
   */
  for line in
    select * from public.deposit_settlement_lines
     where settlement_id = s.id order by created_at
  loop
    insert into public.contract_fund_applications
      (company_id, contract_id, fund_kind, event, applied_on, amount,
       invoice_id, note, created_by)
    values (s.company_id, s.contract_id, 'security_deposit',
            case line.kind when 'forfeiture' then 'forfeited' else 'applied' end,
            s.settled_on, line.amount, line.invoice_id,
            line.description, s.approved_by);

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

comment on function public.approve_deposit_settlement(uuid) is
  'Approves a draft settlement: writes the deposit drawdowns, posts the '
  'journal entry, and lets the refund be paid. Needs contracts approve.';

-- ---------------------------------------------------------------------------
-- A refund now comes out of an approved settlement
-- ---------------------------------------------------------------------------

/**
 * Refunding without settling is what this whole document exists to prevent.
 *
 * The amount is checked against what the settlement says is refundable rather
 * than against the raw balance, so money earmarked for repairs cannot be paid
 * back to the tenant by someone who did not read the file.
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
  if new.payment_kind <> 'refund' or new.contract_id is null then
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

drop trigger if exists payments_refund_needs_settlement on public.payments;
create trigger payments_refund_needs_settlement
  before insert on public.payments
  for each row execute function public.guard_refund_needs_settlement();

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

alter table public.deposit_settlements      enable row level security;
alter table public.deposit_settlement_lines enable row level security;

create policy deposit_settlements_read on public.deposit_settlements
  for select to authenticated
  using (public.has_permission(company_id, 'contracts', 'view'));

create policy deposit_settlements_write on public.deposit_settlements
  for all to authenticated
  using (public.has_permission(company_id, 'contracts', 'edit'))
  with check (public.has_permission(company_id, 'contracts', 'edit'));

create policy deposit_settlement_lines_read on public.deposit_settlement_lines
  for select to authenticated
  using (exists (select 1 from public.deposit_settlements s
                  where s.id = settlement_id
                    and public.has_permission(s.company_id, 'contracts', 'view')));

create policy deposit_settlement_lines_write on public.deposit_settlement_lines
  for all to authenticated
  using (exists (select 1 from public.deposit_settlements s
                  where s.id = settlement_id
                    and public.has_permission(s.company_id, 'contracts', 'edit')))
  with check (exists (select 1 from public.deposit_settlements s
                       where s.id = settlement_id
                         and public.has_permission(s.company_id, 'contracts', 'edit')));
