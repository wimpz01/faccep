-- Phase 3 -- billing core: approvals, utility periods, meter readings,
-- invoices, credit memos, payments and postdated checks.

-- ---------------------------------------------------------------------------
-- Generic approval workflow
--
-- Spec 2 requires approval before an invoice cancellation or a payment void
-- takes effect, and the same pattern recurs in purchasing (spec 10) and
-- contractor progress sign-off (spec 8.2). One table serves all of them.
-- ---------------------------------------------------------------------------

create type public.approval_status as enum ('pending', 'approved', 'rejected');

create table public.approval_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  module_key    text not null references public.modules (key),
  entity_table  text not null,
  entity_id     uuid not null,
  action        text not null,            -- cancel | void | approve | release
  reason        text not null,
  status        public.approval_status not null default 'pending',
  requested_by  uuid references public.profiles (id) on delete set null,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  constraint approval_decided_together
    check ((status = 'pending') = (decided_at is null))
);

create index approval_requests_company_status_idx
  on public.approval_requests (company_id, status, requested_at desc);
create index approval_requests_entity_idx
  on public.approval_requests (entity_table, entity_id);

-- At most one open request per entity+action.
create unique index approval_requests_open_unique
  on public.approval_requests (entity_table, entity_id, action)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Utility periods (spec 6)
--
-- One row per location, per utility, per billing period, holding the actual
-- provider bill. The per-unit rate is derived from it rather than typed in.
-- ---------------------------------------------------------------------------

create type public.utility_kind as enum ('water', 'electric');

create table public.utility_periods (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  location_id        uuid not null references public.locations (id) on delete restrict,
  utility            public.utility_kind not null,
  period_start       date not null,
  period_end         date not null,
  -- Straight off the provider's bill for the whole building.
  provider_amount    numeric(14, 2) not null default 0 check (provider_amount >= 0),
  provider_consumption numeric(14, 3) not null default 0 check (provider_consumption >= 0),
  -- Fuel and maintenance for the period, allocated pro-rata by kWh (spec 6).
  genset_expense     numeric(14, 2) not null default 0 check (genset_expense >= 0),
  is_locked          boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint utility_periods_dates check (period_end >= period_start)
);

create unique index utility_periods_unique
  on public.utility_periods (location_id, utility, period_start);
create index utility_periods_company_idx
  on public.utility_periods (company_id, period_start desc);

-- Rate charged per unit of consumption: total pesos / total consumption.
create or replace function public.utility_period_rate(p_period_id uuid)
returns numeric
language sql
stable
as $$
  select case
           when up.provider_consumption > 0
             then up.provider_amount / up.provider_consumption
           else 0
         end
    from public.utility_periods up
   where up.id = p_period_id;
$$;

-- ---------------------------------------------------------------------------
-- Meter readings (spec 6)
-- ---------------------------------------------------------------------------

create table public.meter_readings (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  period_id         uuid not null references public.utility_periods (id) on delete cascade,
  unit_id           uuid not null references public.units (id) on delete restrict,
  previous_reading  numeric(14, 3) not null default 0 check (previous_reading >= 0),
  present_reading   numeric(14, 3) not null default 0 check (present_reading >= 0),
  reading_date      date not null default current_date,
  notes             text,
  -- Consumption is derived, never typed, so it cannot disagree with the meter.
  consumption       numeric(14, 3)
                      generated always as (present_reading - previous_reading) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint meter_readings_not_backwards
    check (present_reading >= previous_reading)
);

create unique index meter_readings_unique on public.meter_readings (period_id, unit_id);
create index meter_readings_company_idx on public.meter_readings (company_id);
create index meter_readings_unit_idx on public.meter_readings (unit_id);

-- Carries the previous reading forward from the last period for this unit and
-- utility, so encoders only type the present reading.
create or replace function public.previous_meter_reading(
  p_unit_id uuid,
  p_utility public.utility_kind,
  p_before  date
)
returns numeric
language sql
stable
as $$
  select coalesce(
    (select mr.present_reading
       from public.meter_readings mr
       join public.utility_periods up on up.id = mr.period_id
      where mr.unit_id = p_unit_id
        and up.utility = p_utility
        and up.period_start < p_before
      order by up.period_start desc
      limit 1),
    0
  );
$$;

-- ---------------------------------------------------------------------------
-- Invoices (spec 6)
--
-- Once released an invoice is immutable: corrections go through an
-- approval-gated cancellation or a credit memo (spec 2, 6, 11).
-- ---------------------------------------------------------------------------

create type public.invoice_status as enum (
  'draft',
  'released',
  'partially_paid',
  'paid',
  'cancelled'
);

create type public.invoice_line_kind as enum (
  'rent',
  'parking',
  'security_guard',
  'water',
  'electricity',
  'genset',
  'penalty',
  'other'
);

create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  contract_id      uuid references public.contracts (id) on delete restrict,
  invoice_no       text not null,
  status           public.invoice_status not null default 'draft',
  invoice_date     date not null default current_date,
  due_date         date not null,
  period_start     date,
  period_end       date,
  -- VAT only applies to VATable tenants (spec 6); snapshotted here so a later
  -- change to the tenant record cannot rewrite history.
  is_vatable       boolean not null default false,
  vat_rate         numeric(5, 2) not null default 12,
  subtotal         numeric(14, 2) not null default 0,
  vat_amount       numeric(14, 2) not null default 0,
  total            numeric(14, 2) not null default 0,
  amount_paid      numeric(14, 2) not null default 0,
  credited_amount  numeric(14, 2) not null default 0,
  released_at      timestamptz,
  cancelled_at     timestamptz,
  cancellation_reason text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint invoices_dates check (due_date >= invoice_date)
);

create unique index invoices_company_no_key
  on public.invoices (company_id, lower(invoice_no));
create index invoices_company_status_idx on public.invoices (company_id, status);
create index invoices_tenant_idx on public.invoices (tenant_id, invoice_date desc);
create index invoices_due_idx on public.invoices (company_id, due_date)
  where status in ('released', 'partially_paid');

create table public.invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.invoices (id) on delete cascade,
  line_kind    public.invoice_line_kind not null,
  description  text not null,
  quantity     numeric(14, 3) not null default 1,
  unit_price   numeric(14, 4) not null default 0,
  amount       numeric(14, 2) not null default 0,
  is_vatable   boolean not null default false,
  sort_order   integer not null default 0,
  -- Set when the line came from a meter reading, for traceability.
  meter_reading_id uuid references public.meter_readings (id) on delete set null
);

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id, sort_order);

/**
 * Recomputes subtotal, VAT and total from the lines.
 *
 * VAT is charged only on lines flagged vatable, and only when the invoice
 * itself is vatable, so a non-VAT tenant never picks up VAT from a line.
 */
create or replace function public.recalculate_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal   numeric(14, 2);
  v_vat_base   numeric(14, 2);
  v_is_vatable boolean;
  v_vat_rate   numeric(5, 2);
begin
  select i.is_vatable, i.vat_rate into v_is_vatable, v_vat_rate
    from public.invoices i where i.id = p_invoice_id;

  select coalesce(sum(amount), 0),
         coalesce(sum(amount) filter (where is_vatable), 0)
    into v_subtotal, v_vat_base
    from public.invoice_lines
   where invoice_id = p_invoice_id;

  update public.invoices
     set subtotal   = v_subtotal,
         vat_amount = case when v_is_vatable
                           then round(v_vat_base * v_vat_rate / 100, 2)
                           else 0 end,
         total      = v_subtotal + case when v_is_vatable
                                        then round(v_vat_base * v_vat_rate / 100, 2)
                                        else 0 end
   where id = p_invoice_id;
end;
$$;

create or replace function public.invoice_lines_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.recalculate_invoice(coalesce(new.invoice_id, old.invoice_id));
  return null;
end;
$$;

create trigger invoice_lines_recalculate
  after insert or update or delete on public.invoice_lines
  for each row execute function public.invoice_lines_touch();

-- A released invoice is frozen. Only the settlement columns and the
-- cancellation columns may move afterwards.
create or replace function public.guard_released_invoice()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'cancelled' then
    raise exception 'This invoice is cancelled and can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  if old.status in ('released', 'partially_paid', 'paid') then
    if new.invoice_no    is distinct from old.invoice_no
    or new.tenant_id     is distinct from old.tenant_id
    or new.contract_id   is distinct from old.contract_id
    or new.invoice_date  is distinct from old.invoice_date
    or new.due_date      is distinct from old.due_date
    or new.period_start  is distinct from old.period_start
    or new.period_end    is distinct from old.period_end
    or new.is_vatable    is distinct from old.is_vatable
    or new.vat_rate      is distinct from old.vat_rate
    or new.subtotal      is distinct from old.subtotal
    or new.vat_amount    is distinct from old.vat_amount
    or new.total         is distinct from old.total then
      raise exception
        'A released invoice cannot be edited. Cancel it with approval, or issue a credit memo.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger invoices_guard_released
  before update on public.invoices
  for each row execute function public.guard_released_invoice();

-- Lines of a released invoice are frozen too, or the guard above is pointless.
create or replace function public.guard_released_invoice_lines()
returns trigger
language plpgsql
as $$
declare
  v_status public.invoice_status;
begin
  select status into v_status
    from public.invoices
   where id = coalesce(new.invoice_id, old.invoice_id);

  if v_status <> 'draft' then
    raise exception 'Cannot change the lines of an invoice that is no longer a draft.'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger invoice_lines_guard
  before insert or update or delete on public.invoice_lines
  for each row execute function public.guard_released_invoice_lines();

-- ---------------------------------------------------------------------------
-- Credit memos (spec 2, 6)
-- ---------------------------------------------------------------------------

create table public.credit_memos (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  invoice_id  uuid not null references public.invoices (id) on delete restrict,
  memo_no     text not null,
  memo_date   date not null default current_date,
  amount      numeric(14, 2) not null check (amount > 0),
  reason      text not null,
  created_at  timestamptz not null default now()
);

create unique index credit_memos_company_no_key
  on public.credit_memos (company_id, lower(memo_no));
create index credit_memos_invoice_idx on public.credit_memos (invoice_id);

-- ---------------------------------------------------------------------------
-- Payments (spec 7)
-- ---------------------------------------------------------------------------

create type public.payment_kind as enum ('payment', 'prepayment', 'refund');
create type public.payment_mode as enum ('cash', 'gcash', 'check', 'bank_transfer');
create type public.payment_status as enum ('posted', 'voided');

create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  tenant_id      uuid not null references public.tenants (id) on delete restrict,
  payment_no     text not null,
  payment_kind   public.payment_kind not null default 'payment',
  payment_mode   public.payment_mode not null default 'cash',
  payment_date   date not null default current_date,
  amount         numeric(14, 2) not null check (amount > 0),
  reference      text,
  notes          text,
  status         public.payment_status not null default 'posted',
  voided_at      timestamptz,
  void_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index payments_company_no_key
  on public.payments (company_id, lower(payment_no));
create index payments_company_date_idx on public.payments (company_id, payment_date desc);
create index payments_tenant_idx on public.payments (tenant_id, payment_date desc);

-- Which invoices a payment settles. A prepayment simply has no applications.
create table public.payment_applications (
  id         uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  amount     numeric(14, 2) not null check (amount > 0),
  unique (payment_id, invoice_id)
);

create index payment_applications_invoice_idx
  on public.payment_applications (invoice_id);

-- A posted payment is immutable apart from its void columns (spec 7).
create or replace function public.guard_posted_payment()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'voided' then
    raise exception 'This payment is voided and can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  if new.amount       is distinct from old.amount
  or new.tenant_id    is distinct from old.tenant_id
  or new.payment_no   is distinct from old.payment_no
  or new.payment_date is distinct from old.payment_date
  or new.payment_kind is distinct from old.payment_kind then
    raise exception
      'A posted payment cannot be edited. Void it with approval and record a new one.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger payments_guard_posted
  before update on public.payments
  for each row execute function public.guard_posted_payment();

/**
 * Rolls applied payments and credit memos up onto the invoice and moves its
 * status. Applications belonging to a voided payment are ignored, so voiding
 * reopens the balance automatically.
 */
create or replace function public.recalculate_invoice_settlement(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid     numeric(14, 2);
  v_credited numeric(14, 2);
  v_total    numeric(14, 2);
  v_status   public.invoice_status;
begin
  select i.total, i.status into v_total, v_status
    from public.invoices i where i.id = p_invoice_id;

  if v_status = 'cancelled' then
    return;
  end if;

  select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_applications pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = p_invoice_id
     and p.status = 'posted';

  select coalesce(sum(cm.amount), 0) into v_credited
    from public.credit_memos cm
   where cm.invoice_id = p_invoice_id;

  update public.invoices
     set amount_paid     = v_paid,
         credited_amount = v_credited,
         status = case
                    when status = 'draft' then 'draft'
                    when v_paid + v_credited >= v_total then 'paid'
                    when v_paid + v_credited > 0 then 'partially_paid'
                    else 'released'
                  end
   where id = p_invoice_id;
end;
$$;

create or replace function public.settlement_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice uuid;
begin
  if tg_table_name = 'payment_applications' then
    v_invoice := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
    perform public.recalculate_invoice_settlement(v_invoice);
  elsif tg_table_name = 'credit_memos' then
    v_invoice := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
    perform public.recalculate_invoice_settlement(v_invoice);
  else
    -- payments: a void or repost changes every invoice it touched.
    for v_invoice in
      select pa.invoice_id from public.payment_applications pa
       where pa.payment_id = new.id
    loop
      perform public.recalculate_invoice_settlement(v_invoice);
    end loop;
  end if;

  return null;
end;
$$;

create trigger payment_applications_settle
  after insert or update or delete on public.payment_applications
  for each row execute function public.settlement_touch();

create trigger credit_memos_settle
  after insert or update or delete on public.credit_memos
  for each row execute function public.settlement_touch();

create trigger payments_settle
  after update of status on public.payments
  for each row execute function public.settlement_touch();

-- ---------------------------------------------------------------------------
-- Postdated checks (spec 7, 14)
-- ---------------------------------------------------------------------------

create type public.pdc_status as enum (
  'pending',
  'matured',
  'deposited',
  'cleared',
  'bounced',
  'cancelled'
);

create table public.postdated_checks (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  tenant_id     uuid not null references public.tenants (id) on delete restrict,
  payment_id    uuid references public.payments (id) on delete set null,
  check_no      text not null,
  bank          text not null,
  amount        numeric(14, 2) not null check (amount > 0),
  maturity_date date not null,
  status        public.pdc_status not null default 'pending',
  deposited_at  date,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index postdated_checks_unique
  on public.postdated_checks (company_id, lower(bank), lower(check_no));
create index postdated_checks_maturity_idx
  on public.postdated_checks (company_id, maturity_date)
  where status in ('pending', 'matured');

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger utility_periods_set_updated_at before update on public.utility_periods
  for each row execute function public.set_updated_at();
create trigger meter_readings_set_updated_at before update on public.meter_readings
  for each row execute function public.set_updated_at();
create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();
create trigger payments_set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();
create trigger postdated_checks_set_updated_at before update on public.postdated_checks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.approval_requests    enable row level security;
alter table public.utility_periods      enable row level security;
alter table public.meter_readings       enable row level security;
alter table public.invoices             enable row level security;
alter table public.invoice_lines        enable row level security;
alter table public.credit_memos         enable row level security;
alter table public.payments             enable row level security;
alter table public.payment_applications enable row level security;
alter table public.postdated_checks     enable row level security;

-- Approvals: anyone in the company can see and raise one; only a user with
-- Approve on the request's own module may decide it.
create policy approval_requests_read on public.approval_requests
  for select to authenticated
  using (public.is_company_member(company_id));

create policy approval_requests_insert on public.approval_requests
  for insert to authenticated
  with check (public.is_company_member(company_id) and requested_by = auth.uid());

create policy approval_requests_decide on public.approval_requests
  for update to authenticated
  using (public.has_permission(company_id, module_key, 'approve'))
  with check (public.has_permission(company_id, module_key, 'approve'));

-- Helper so each policy below reads the same way.
create policy utility_periods_read on public.utility_periods
  for select to authenticated using (public.is_company_member(company_id));
create policy utility_periods_write on public.utility_periods
  for all to authenticated
  using (public.has_permission(company_id, 'billing.utility_rates', 'edit'))
  with check (public.has_permission(company_id, 'billing.utility_rates', 'edit'));

create policy meter_readings_read on public.meter_readings
  for select to authenticated using (public.is_company_member(company_id));
create policy meter_readings_write on public.meter_readings
  for all to authenticated
  using (public.has_permission(company_id, 'billing.meter_readings', 'edit'))
  with check (public.has_permission(company_id, 'billing.meter_readings', 'edit'));

create policy invoices_read on public.invoices
  for select to authenticated using (public.is_company_member(company_id));
create policy invoices_insert on public.invoices
  for insert to authenticated
  with check (public.has_permission(company_id, 'billing.invoices', 'edit'));
create policy invoices_update on public.invoices
  for update to authenticated
  using (public.has_permission(company_id, 'billing.invoices', 'edit'))
  with check (public.has_permission(company_id, 'billing.invoices', 'edit'));
create policy invoices_delete on public.invoices
  for delete to authenticated
  using (public.has_permission(company_id, 'billing.invoices', 'delete'));

create policy invoice_lines_read on public.invoice_lines
  for select to authenticated
  using (exists (select 1 from public.invoices i
                  where i.id = invoice_lines.invoice_id
                    and public.is_company_member(i.company_id)));
create policy invoice_lines_write on public.invoice_lines
  for all to authenticated
  using (exists (select 1 from public.invoices i
                  where i.id = invoice_lines.invoice_id
                    and public.has_permission(i.company_id, 'billing.invoices', 'edit')))
  with check (exists (select 1 from public.invoices i
                  where i.id = invoice_lines.invoice_id
                    and public.has_permission(i.company_id, 'billing.invoices', 'edit')));

create policy credit_memos_read on public.credit_memos
  for select to authenticated using (public.is_company_member(company_id));
create policy credit_memos_write on public.credit_memos
  for all to authenticated
  using (public.has_permission(company_id, 'billing.credit_memos', 'edit'))
  with check (public.has_permission(company_id, 'billing.credit_memos', 'edit'));

create policy payments_read on public.payments
  for select to authenticated using (public.is_company_member(company_id));
create policy payments_insert on public.payments
  for insert to authenticated
  with check (public.has_permission(company_id, 'payments', 'edit'));
-- Update covers only the void columns; the guard trigger blocks the rest.
create policy payments_update on public.payments
  for update to authenticated
  using (public.has_permission(company_id, 'payments', 'edit')
      or public.has_permission(company_id, 'payments', 'void'))
  with check (public.has_permission(company_id, 'payments', 'edit')
           or public.has_permission(company_id, 'payments', 'void'));

create policy payment_applications_read on public.payment_applications
  for select to authenticated
  using (exists (select 1 from public.payments p
                  where p.id = payment_applications.payment_id
                    and public.is_company_member(p.company_id)));
create policy payment_applications_write on public.payment_applications
  for all to authenticated
  using (exists (select 1 from public.payments p
                  where p.id = payment_applications.payment_id
                    and public.has_permission(p.company_id, 'payments', 'edit')))
  with check (exists (select 1 from public.payments p
                  where p.id = payment_applications.payment_id
                    and public.has_permission(p.company_id, 'payments', 'edit')));

create policy postdated_checks_read on public.postdated_checks
  for select to authenticated using (public.is_company_member(company_id));
create policy postdated_checks_write on public.postdated_checks
  for all to authenticated
  using (public.has_permission(company_id, 'payments.pdc', 'edit'))
  with check (public.has_permission(company_id, 'payments.pdc', 'edit'));
