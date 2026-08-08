/**
 * What has become of a tenant's deposit and advance.
 *
 * The contract says how much was taken -- security_deposit and
 * advance_payment -- and nothing said what happened to it afterwards. So a
 * deposit that had been half applied to arrears, or an advance already
 * consumed by the first month, still read as the full amount held.
 *
 * Each time either fund is drawn on it is recorded here, and what remains is
 * derived from the record rather than typed. Nothing overwrites the contract:
 * the amount taken at signing stays exactly as it was, which is what makes a
 * refund at move-out arguable years later.
 *
 * Rent escalation deliberately gets no table. Base rent, rate and start date
 * already determine every year's rent, and billing computes it from them --
 * storing a second copy is how the schedule and the invoices come to disagree.
 */

create type public.contract_fund_kind as enum (
  'security_deposit',
  'advance_payment'
);

create type public.contract_fund_event as enum (
  'applied',    -- set against a bill or arrears
  'refunded',   -- returned to the tenant
  'forfeited'   -- kept, typically on a breach
);

create table public.contract_fund_applications (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  contract_id uuid not null references public.contracts (id) on delete cascade,
  fund_kind   public.contract_fund_kind  not null,
  event       public.contract_fund_event not null default 'applied',
  applied_on  date not null default current_date,
  amount      numeric(14,2) not null check (amount > 0),
  -- The bill it was set against, where it was set against one.
  invoice_id  uuid references public.invoices (id) on delete set null,
  note        text,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now()
);

create index contract_fund_applications_contract_idx
  on public.contract_fund_applications (contract_id, fund_kind);

comment on table public.contract_fund_applications is
  'Every drawdown on a deposit or advance. What remains is derived from these, '
  'never stored, so the contract keeps saying what was taken at signing.';

/**
 * A fund cannot give up more than was taken.
 *
 * Checked against the contract rather than a running balance, so it holds no
 * matter what order the rows arrive in.
 */
create or replace function public.guard_contract_fund_application()
returns trigger
language plpgsql
as $$
declare
  v_held  numeric(14,2);
  v_drawn numeric(14,2);
  v_no    text;
begin
  select case when new.fund_kind = 'security_deposit'
              then c.security_deposit else c.advance_payment end,
         c.contract_no
    into v_held, v_no
    from public.contracts c where c.id = new.contract_id;

  select coalesce(sum(amount), 0) into v_drawn
    from public.contract_fund_applications
   where contract_id = new.contract_id
     and fund_kind = new.fund_kind
     and id is distinct from new.id;

  if v_drawn + new.amount > coalesce(v_held, 0) then
    raise exception
      'Only % of the % on % is left, so % cannot be taken from it.',
      to_char(coalesce(v_held, 0) - v_drawn, 'FM999999990.00'),
      replace(new.fund_kind::text, '_', ' '),
      v_no,
      to_char(new.amount, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger contract_fund_applications_guard
  before insert or update on public.contract_fund_applications
  for each row execute function public.guard_contract_fund_application();

/**
 * What each contract still holds, and what state each fund is in.
 *
 * security_invoker so row-level security still decides who sees it.
 */
create or replace view public.contract_fund_status
with (security_invoker = true) as
  select
    c.id         as contract_id,
    c.company_id,
    c.security_deposit                                            as deposit_taken,
    coalesce(d.drawn, 0)                                          as deposit_drawn,
    c.security_deposit - coalesce(d.drawn, 0)                     as deposit_remaining,
    case
      when coalesce(c.security_deposit, 0) = 0    then 'none'
      when coalesce(d.drawn, 0) = 0               then 'held'
      when coalesce(d.drawn, 0) < c.security_deposit
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
  ) a on a.contract_id = c.id;

grant select on public.contract_fund_status to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security, matching contracts.
-- ---------------------------------------------------------------------------

alter table public.contract_fund_applications enable row level security;

create policy contract_fund_applications_read on public.contract_fund_applications
  for select to authenticated using (public.is_company_member(company_id));

create policy contract_fund_applications_write on public.contract_fund_applications
  for all to authenticated
  using      (public.has_permission(company_id, 'contracts', 'edit'))
  with check (public.has_permission(company_id, 'contracts', 'edit'));
