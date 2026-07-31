-- Phase 5 -- repair & maintenance, inventory, purchasing and payables.
--
-- Maintenance and Purchasing are deliberately separate modules (spec 2): a
-- material request raised in Maintenance hands off to Purchasing as its own
-- record with its own approval, rather than granting the requester access.

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------

create table public.inventory_categories (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create unique index inventory_categories_unique
  on public.inventory_categories (company_id, lower(name));

create table public.inventory_items (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  category_id    uuid references public.inventory_categories (id) on delete set null,
  sku            text,
  name           text not null,
  unit_of_measure text not null default 'pc',
  reorder_level  numeric(14, 3) not null default 0,
  unit_cost      numeric(14, 4) not null default 0,
  -- Maintained by the movement trigger; never written directly.
  quantity_on_hand numeric(14, 3) not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index inventory_items_unique
  on public.inventory_items (company_id, lower(name));
create index inventory_items_category_idx on public.inventory_items (category_id);

create type public.stock_movement_kind as enum (
  'receipt',     -- purchased goods received
  'issue',       -- issued to a maintenance job
  'return',      -- unused material handed back (spec 9)
  'adjustment'   -- stock count correction
);

create table public.inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  item_id         uuid not null references public.inventory_items (id) on delete restrict,
  movement_kind   public.stock_movement_kind not null,
  -- Signed: positive adds to stock, negative removes. The sign is set by the
  -- application from the movement kind so the ledger always sums to the balance.
  quantity        numeric(14, 3) not null check (quantity <> 0),
  unit_cost       numeric(14, 4) not null default 0,
  reference_table text,
  reference_id    uuid,
  note            text,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index inventory_movements_item_idx
  on public.inventory_movements (item_id, created_at desc);
create index inventory_movements_company_idx
  on public.inventory_movements (company_id, created_at desc);

/** Keeps quantity_on_hand equal to the sum of the movement ledger. */
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item uuid;
begin
  v_item := case when tg_op = 'DELETE' then old.item_id else new.item_id end;

  update public.inventory_items i
     set quantity_on_hand = coalesce((
           select sum(m.quantity) from public.inventory_movements m
            where m.item_id = v_item
         ), 0)
   where i.id = v_item;

  return null;
end;
$$;

create trigger inventory_movements_apply
  after insert or update or delete on public.inventory_movements
  for each row execute function public.apply_stock_movement();

-- Tools are tracked apart from consumables (spec 9).
create type public.tool_status as enum ('available', 'borrowed', 'maintenance', 'retired');

create table public.tools (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name       text not null,
  serial_no  text,
  condition  text,
  status     public.tool_status not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tools_company_idx on public.tools (company_id, status);

create table public.tool_loans (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  tool_id        uuid not null references public.tools (id) on delete restrict,
  borrower_name  text not null,
  borrowed_at    date not null default current_date,
  expected_return date,
  returned_at    date,
  condition_out  text,
  condition_in   text,
  note           text,
  created_at     timestamptz not null default now()
);

create index tool_loans_tool_idx on public.tool_loans (tool_id, borrowed_at desc);
-- A tool can only be out on one loan at a time.
create unique index tool_loans_open_unique
  on public.tool_loans (tool_id) where returned_at is null;

/** Flips tool status as loans open and close. */
create or replace function public.sync_tool_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tool uuid;
begin
  v_tool := case when tg_op = 'DELETE' then old.tool_id else new.tool_id end;

  update public.tools t
     set status = case
                    when exists (
                      select 1 from public.tool_loans l
                       where l.tool_id = v_tool and l.returned_at is null
                    ) then 'borrowed'::public.tool_status
                    else 'available'::public.tool_status
                  end
   where t.id = v_tool
     and t.status <> 'retired'
     and t.status <> 'maintenance';

  return null;
end;
$$;

create trigger tool_loans_sync
  after insert or update or delete on public.tool_loans
  for each row execute function public.sync_tool_status();

-- ---------------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------------

create table public.vendors (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  name           text not null,
  tin            text,
  address        text,
  contact_person text,
  contact_number text,
  email          text,
  payment_terms  text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index vendors_unique on public.vendors (company_id, lower(name));

-- ---------------------------------------------------------------------------
-- Maintenance
-- ---------------------------------------------------------------------------

create type public.maintenance_status as enum (
  'reported',
  'approved',
  'assigned',
  'in_progress',
  'completed',
  'inspected',
  'closed',
  'cancelled'
);

create type public.maintenance_kind as enum ('in_house', 'contracted');

create table public.maintenance_schedules (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  location_id   uuid references public.locations (id) on delete cascade,
  title         text not null,
  description   text,
  -- e.g. "every April" -> frequency monthly interval 12, month_of_year 4.
  month_of_year integer check (month_of_year between 1 and 12),
  day_of_month  integer check (day_of_month between 1 and 28),
  interval_months integer not null default 12 check (interval_months > 0),
  assigned_to   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index maintenance_schedules_company_idx
  on public.maintenance_schedules (company_id, is_active);

create table public.maintenance_jobs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  location_id   uuid references public.locations (id) on delete set null,
  unit_id       uuid references public.units (id) on delete set null,
  schedule_id   uuid references public.maintenance_schedules (id) on delete set null,
  job_no        text not null,
  title         text not null,
  description   text,
  job_kind      public.maintenance_kind not null default 'in_house',
  status        public.maintenance_status not null default 'reported',
  vendor_id     uuid references public.vendors (id) on delete set null,
  assigned_to   text,
  reported_at   date not null default current_date,
  scheduled_for date,
  completed_at  date,
  inspected_at  date,
  closed_at     date,
  contract_amount numeric(14, 2) not null default 0 check (contract_amount >= 0),
  actual_cost   numeric(14, 2) not null default 0 check (actual_cost >= 0),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index maintenance_jobs_no_unique
  on public.maintenance_jobs (company_id, lower(job_no));
create index maintenance_jobs_status_idx
  on public.maintenance_jobs (company_id, status);

create type public.job_photo_stage as enum ('before', 'after', 'inspection');

create table public.maintenance_job_photos (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.maintenance_jobs (id) on delete cascade,
  stage        public.job_photo_stage not null,
  storage_path text not null,
  caption      text,
  created_at   timestamptz not null default now()
);

create index maintenance_job_photos_job_idx
  on public.maintenance_job_photos (job_id, stage);

/**
 * Before/after photos are required to move a job past Completed (spec 8.2).
 */
create or replace function public.guard_job_photos()
returns trigger
language plpgsql
as $$
declare
  v_before integer;
  v_after  integer;
begin
  if new.status in ('completed', 'inspected', 'closed')
     and old.status not in ('completed', 'inspected', 'closed') then
    select count(*) filter (where stage = 'before'),
           count(*) filter (where stage = 'after')
      into v_before, v_after
      from public.maintenance_job_photos
     where job_id = new.id;

    if v_before = 0 or v_after = 0 then
      raise exception
        'Attach at least one before photo and one after photo before completing this job.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger maintenance_jobs_guard_photos
  before update of status on public.maintenance_jobs
  for each row execute function public.guard_job_photos();

/**
 * Percent-complete sign-off gating each contractor payment tranche (spec 8.2).
 * Payables will not release a tranche without an approved row here.
 */
create table public.maintenance_progress (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  job_id           uuid not null references public.maintenance_jobs (id) on delete cascade,
  percent_complete numeric(5, 2) not null
                     check (percent_complete > 0 and percent_complete <= 100),
  tranche_amount   numeric(14, 2) not null check (tranche_amount >= 0),
  note             text,
  status           public.approval_status not null default 'pending',
  certified_by     uuid references public.profiles (id) on delete set null,
  approved_by      uuid references public.profiles (id) on delete set null,
  approved_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index maintenance_progress_job_idx
  on public.maintenance_progress (job_id, created_at);

-- ---------------------------------------------------------------------------
-- Material requests (spec 8.2, 9)
-- ---------------------------------------------------------------------------

create type public.material_request_status as enum (
  'draft',
  'approved',
  'issued',
  'closed'
);

create table public.material_requests (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  job_id      uuid references public.maintenance_jobs (id) on delete set null,
  request_no  text not null,
  status      public.material_request_status not null default 'draft',
  requested_by uuid references public.profiles (id) on delete set null,
  issued_at   timestamptz,
  closed_at   timestamptz,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index material_requests_no_unique
  on public.material_requests (company_id, lower(request_no));
create index material_requests_job_idx on public.material_requests (job_id);

-- Doubles as the checklist of what was issued versus what was actually used
-- (spec 9), which is what surfaces the leftovers.
create table public.material_request_lines (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references public.material_requests (id) on delete cascade,
  item_id            uuid not null references public.inventory_items (id) on delete restrict,
  quantity_requested numeric(14, 3) not null check (quantity_requested > 0),
  quantity_issued    numeric(14, 3) not null default 0 check (quantity_issued >= 0),
  quantity_used      numeric(14, 3) not null default 0 check (quantity_used >= 0),
  quantity_returned  numeric(14, 3) not null default 0 check (quantity_returned >= 0),
  constraint material_lines_used_within_issued
    check (quantity_used + quantity_returned <= quantity_issued),
  unique (request_id, item_id)
);

-- ---------------------------------------------------------------------------
-- Purchasing (spec 10)
-- ---------------------------------------------------------------------------

create type public.purchase_request_status as enum (
  'draft',
  'pending',
  'approved',
  'rejected',
  'ordered'
);

create table public.purchase_requests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  request_no   text not null,
  job_id       uuid references public.maintenance_jobs (id) on delete set null,
  status       public.purchase_request_status not null default 'draft',
  needed_by    date,
  justification text,
  requested_by uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index purchase_requests_no_unique
  on public.purchase_requests (company_id, lower(request_no));

create table public.purchase_request_lines (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.purchase_requests (id) on delete cascade,
  item_id         uuid references public.inventory_items (id) on delete set null,
  description     text not null,
  quantity        numeric(14, 3) not null check (quantity > 0),
  estimated_price numeric(14, 4) not null default 0
);

create type public.purchase_order_status as enum (
  'draft',
  'issued',
  'partially_received',
  'received',
  'closed',
  'cancelled'
);

create table public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete restrict,
  request_id   uuid references public.purchase_requests (id) on delete set null,
  po_no        text not null,
  status       public.purchase_order_status not null default 'draft',
  order_date   date not null default current_date,
  expected_date date,
  total        numeric(14, 2) not null default 0,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index purchase_orders_no_unique
  on public.purchase_orders (company_id, lower(po_no));
create index purchase_orders_vendor_idx on public.purchase_orders (vendor_id);

create table public.purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  po_id             uuid not null references public.purchase_orders (id) on delete cascade,
  item_id           uuid references public.inventory_items (id) on delete set null,
  description       text not null,
  quantity          numeric(14, 3) not null check (quantity > 0),
  unit_price        numeric(14, 4) not null default 0,
  amount            numeric(14, 2) not null default 0,
  quantity_received numeric(14, 3) not null default 0 check (quantity_received >= 0)
);

create index purchase_order_lines_po_idx on public.purchase_order_lines (po_id);

/** Keeps the purchase order total equal to the sum of its lines. */
create or replace function public.recalculate_purchase_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po uuid;
begin
  v_po := case when tg_op = 'DELETE' then old.po_id else new.po_id end;

  update public.purchase_orders
     set total = coalesce((
           select sum(amount) from public.purchase_order_lines where po_id = v_po
         ), 0)
   where id = v_po;

  return null;
end;
$$;

create trigger purchase_order_lines_total
  after insert or update or delete on public.purchase_order_lines
  for each row execute function public.recalculate_purchase_order();

create table public.goods_receipts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  po_id         uuid not null references public.purchase_orders (id) on delete restrict,
  receipt_no    text not null,
  received_date date not null default current_date,
  received_by   uuid references public.profiles (id) on delete set null,
  notes         text,
  created_at    timestamptz not null default now()
);

create unique index goods_receipts_no_unique
  on public.goods_receipts (company_id, lower(receipt_no));

create table public.goods_receipt_lines (
  id         uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.goods_receipts (id) on delete cascade,
  po_line_id uuid not null references public.purchase_order_lines (id) on delete restrict,
  quantity   numeric(14, 3) not null check (quantity > 0)
);

/**
 * Receiving rolls the quantity up onto the PO line, moves the PO status, and
 * pushes stock into inventory for lines tied to an item.
 */
create or replace function public.apply_goods_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po_line  public.purchase_order_lines%rowtype;
  v_receipt  public.goods_receipts%rowtype;
  v_outstanding numeric(14, 3);
begin
  select * into v_po_line from public.purchase_order_lines where id = new.po_line_id;
  select * into v_receipt from public.goods_receipts where id = new.receipt_id;

  update public.purchase_order_lines
     set quantity_received = quantity_received + new.quantity
   where id = new.po_line_id;

  if v_po_line.item_id is not null then
    insert into public.inventory_movements
      (company_id, item_id, movement_kind, quantity, unit_cost,
       reference_table, reference_id, note)
    values (v_receipt.company_id, v_po_line.item_id, 'receipt', new.quantity,
            v_po_line.unit_price, 'goods_receipts', v_receipt.id,
            'Received on ' || v_receipt.receipt_no);
  end if;

  select coalesce(sum(quantity - quantity_received), 0) into v_outstanding
    from public.purchase_order_lines where po_id = v_po_line.po_id;

  update public.purchase_orders
     set status = case
                    when v_outstanding <= 0 then 'received'::public.purchase_order_status
                    else 'partially_received'::public.purchase_order_status
                  end
   where id = v_po_line.po_id
     and status in ('issued', 'partially_received');

  return null;
end;
$$;

create trigger goods_receipt_lines_apply
  after insert on public.goods_receipt_lines
  for each row execute function public.apply_goods_receipt();

-- ---------------------------------------------------------------------------
-- Payables (spec 10)
-- ---------------------------------------------------------------------------

create type public.supplier_invoice_status as enum (
  'open',
  'partially_paid',
  'paid',
  'cancelled'
);

create table public.supplier_invoices (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete restrict,
  po_id        uuid references public.purchase_orders (id) on delete set null,
  job_id       uuid references public.maintenance_jobs (id) on delete set null,
  invoice_no   text not null,
  invoice_date date not null default current_date,
  due_date     date not null default current_date,
  amount       numeric(14, 2) not null default 0,
  vat_amount   numeric(14, 2) not null default 0,
  -- Creditable withholding tax, the basis of BIR 2307 (spec 11).
  withholding_tax numeric(14, 2) not null default 0,
  total        numeric(14, 2) not null default 0,
  amount_paid  numeric(14, 2) not null default 0,
  status       public.supplier_invoice_status not null default 'open',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index supplier_invoices_unique
  on public.supplier_invoices (company_id, vendor_id, lower(invoice_no));
create index supplier_invoices_status_idx
  on public.supplier_invoices (company_id, status, due_date);

create type public.voucher_status as enum ('draft', 'approved', 'released', 'cancelled');

create table public.check_vouchers (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete restrict,
  voucher_no   text not null,
  voucher_date date not null default current_date,
  amount       numeric(14, 2) not null check (amount > 0),
  check_no     text,
  bank         text,
  status       public.voucher_status not null default 'draft',
  released_at  timestamptz,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index check_vouchers_no_unique
  on public.check_vouchers (company_id, lower(voucher_no));

create table public.voucher_lines (
  id                 uuid primary key default gen_random_uuid(),
  voucher_id         uuid not null references public.check_vouchers (id) on delete cascade,
  supplier_invoice_id uuid not null references public.supplier_invoices (id) on delete restrict,
  amount             numeric(14, 2) not null check (amount > 0),
  unique (voucher_id, supplier_invoice_id)
);

/** Rolls released vouchers onto the supplier invoice balance. */
create or replace function public.recalculate_supplier_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice uuid;
  v_paid    numeric(14, 2);
  v_total   numeric(14, 2);
begin
  v_invoice := case when tg_op = 'DELETE' then old.supplier_invoice_id
                    else new.supplier_invoice_id end;

  select coalesce(sum(vl.amount), 0) into v_paid
    from public.voucher_lines vl
    join public.check_vouchers cv on cv.id = vl.voucher_id
   where vl.supplier_invoice_id = v_invoice
     and cv.status = 'released';

  select total into v_total from public.supplier_invoices where id = v_invoice;

  update public.supplier_invoices
     set amount_paid = v_paid,
         status = case
                    when status = 'cancelled' then 'cancelled'::public.supplier_invoice_status
                    when v_paid >= v_total then 'paid'::public.supplier_invoice_status
                    when v_paid > 0 then 'partially_paid'::public.supplier_invoice_status
                    else 'open'::public.supplier_invoice_status
                  end
   where id = v_invoice;

  return null;
end;
$$;

create trigger voucher_lines_settle
  after insert or update or delete on public.voucher_lines
  for each row execute function public.recalculate_supplier_invoice();

/** Releasing or cancelling a voucher re-settles every invoice it touches. */
create or replace function public.voucher_status_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice uuid;
begin
  for v_invoice in
    select supplier_invoice_id from public.voucher_lines where voucher_id = new.id
  loop
    perform public.recalculate_supplier_invoice_for(v_invoice);
  end loop;
  return null;
end;
$$;

/** Callable form of the settlement recalculation. */
create or replace function public.recalculate_supplier_invoice_for(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid  numeric(14, 2);
  v_total numeric(14, 2);
begin
  select coalesce(sum(vl.amount), 0) into v_paid
    from public.voucher_lines vl
    join public.check_vouchers cv on cv.id = vl.voucher_id
   where vl.supplier_invoice_id = p_invoice
     and cv.status = 'released';

  select total into v_total from public.supplier_invoices where id = p_invoice;

  update public.supplier_invoices
     set amount_paid = v_paid,
         status = case
                    when status = 'cancelled' then 'cancelled'::public.supplier_invoice_status
                    when v_paid >= v_total then 'paid'::public.supplier_invoice_status
                    when v_paid > 0 then 'partially_paid'::public.supplier_invoice_status
                    else 'open'::public.supplier_invoice_status
                  end
   where id = p_invoice;
end;
$$;

create trigger check_vouchers_status
  after update of status on public.check_vouchers
  for each row execute function public.voucher_status_changed();

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create trigger inventory_items_set_updated_at before update on public.inventory_items
  for each row execute function public.set_updated_at();
create trigger tools_set_updated_at before update on public.tools
  for each row execute function public.set_updated_at();
create trigger vendors_set_updated_at before update on public.vendors
  for each row execute function public.set_updated_at();
create trigger maintenance_schedules_set_updated_at before update on public.maintenance_schedules
  for each row execute function public.set_updated_at();
create trigger maintenance_jobs_set_updated_at before update on public.maintenance_jobs
  for each row execute function public.set_updated_at();
create trigger material_requests_set_updated_at before update on public.material_requests
  for each row execute function public.set_updated_at();
create trigger purchase_requests_set_updated_at before update on public.purchase_requests
  for each row execute function public.set_updated_at();
create trigger purchase_orders_set_updated_at before update on public.purchase_orders
  for each row execute function public.set_updated_at();
create trigger supplier_invoices_set_updated_at before update on public.supplier_invoices
  for each row execute function public.set_updated_at();
create trigger check_vouchers_set_updated_at before update on public.check_vouchers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.inventory_categories   enable row level security;
alter table public.inventory_items        enable row level security;
alter table public.inventory_movements    enable row level security;
alter table public.tools                  enable row level security;
alter table public.tool_loans             enable row level security;
alter table public.vendors                enable row level security;
alter table public.maintenance_schedules  enable row level security;
alter table public.maintenance_jobs       enable row level security;
alter table public.maintenance_job_photos enable row level security;
alter table public.maintenance_progress   enable row level security;
alter table public.material_requests      enable row level security;
alter table public.material_request_lines enable row level security;
alter table public.purchase_requests      enable row level security;
alter table public.purchase_request_lines enable row level security;
alter table public.purchase_orders        enable row level security;
alter table public.purchase_order_lines   enable row level security;
alter table public.goods_receipts         enable row level security;
alter table public.goods_receipt_lines    enable row level security;
alter table public.supplier_invoices      enable row level security;
alter table public.check_vouchers         enable row level security;
alter table public.voucher_lines          enable row level security;

-- Company-scoped tables follow the same shape: readable by members, writable
-- with the owning module's edit right.
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('inventory_categories',  'inventory.items'),
      ('inventory_items',       'inventory.items'),
      ('inventory_movements',   'inventory.movements'),
      ('tools',                 'inventory.tools'),
      ('tool_loans',            'inventory.tools'),
      ('vendors',               'purchasing.vendors'),
      ('maintenance_schedules', 'maintenance.scheduled'),
      ('maintenance_jobs',      'maintenance.repairs'),
      ('maintenance_progress',  'maintenance.progress_signoff'),
      ('material_requests',     'maintenance.material_requests'),
      ('purchase_requests',     'purchasing.requests'),
      ('purchase_orders',       'purchasing.orders'),
      ('goods_receipts',        'purchasing.receiving'),
      ('supplier_invoices',     'payables.invoices'),
      ('check_vouchers',        'payables.vouchers')
    ) as v(table_name, module_key)
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (public.is_company_member(company_id))',
      t.table_name || '_read', t.table_name);

    execute format(
      'create policy %I on public.%I for all to authenticated
         using (public.has_permission(company_id, %L, ''edit''))
         with check (public.has_permission(company_id, %L, ''edit''))',
      t.table_name || '_write', t.table_name, t.module_key, t.module_key);
  end loop;
end;
$$;

-- Child tables authorise through their parent.
create policy maintenance_job_photos_read on public.maintenance_job_photos
  for select to authenticated
  using (exists (select 1 from public.maintenance_jobs j
                  where j.id = maintenance_job_photos.job_id
                    and public.is_company_member(j.company_id)));
create policy maintenance_job_photos_write on public.maintenance_job_photos
  for all to authenticated
  using (exists (select 1 from public.maintenance_jobs j
                  where j.id = maintenance_job_photos.job_id
                    and public.has_permission(j.company_id, 'maintenance.repairs', 'edit')))
  with check (exists (select 1 from public.maintenance_jobs j
                  where j.id = maintenance_job_photos.job_id
                    and public.has_permission(j.company_id, 'maintenance.repairs', 'edit')));

create policy material_request_lines_read on public.material_request_lines
  for select to authenticated
  using (exists (select 1 from public.material_requests r
                  where r.id = material_request_lines.request_id
                    and public.is_company_member(r.company_id)));
create policy material_request_lines_write on public.material_request_lines
  for all to authenticated
  using (exists (select 1 from public.material_requests r
                  where r.id = material_request_lines.request_id
                    and public.has_permission(r.company_id, 'maintenance.material_requests', 'edit')))
  with check (exists (select 1 from public.material_requests r
                  where r.id = material_request_lines.request_id
                    and public.has_permission(r.company_id, 'maintenance.material_requests', 'edit')));

create policy purchase_request_lines_read on public.purchase_request_lines
  for select to authenticated
  using (exists (select 1 from public.purchase_requests r
                  where r.id = purchase_request_lines.request_id
                    and public.is_company_member(r.company_id)));
create policy purchase_request_lines_write on public.purchase_request_lines
  for all to authenticated
  using (exists (select 1 from public.purchase_requests r
                  where r.id = purchase_request_lines.request_id
                    and public.has_permission(r.company_id, 'purchasing.requests', 'edit')))
  with check (exists (select 1 from public.purchase_requests r
                  where r.id = purchase_request_lines.request_id
                    and public.has_permission(r.company_id, 'purchasing.requests', 'edit')));

create policy purchase_order_lines_read on public.purchase_order_lines
  for select to authenticated
  using (exists (select 1 from public.purchase_orders o
                  where o.id = purchase_order_lines.po_id
                    and public.is_company_member(o.company_id)));
create policy purchase_order_lines_write on public.purchase_order_lines
  for all to authenticated
  using (exists (select 1 from public.purchase_orders o
                  where o.id = purchase_order_lines.po_id
                    and public.has_permission(o.company_id, 'purchasing.orders', 'edit')))
  with check (exists (select 1 from public.purchase_orders o
                  where o.id = purchase_order_lines.po_id
                    and public.has_permission(o.company_id, 'purchasing.orders', 'edit')));

create policy goods_receipt_lines_read on public.goods_receipt_lines
  for select to authenticated
  using (exists (select 1 from public.goods_receipts g
                  where g.id = goods_receipt_lines.receipt_id
                    and public.is_company_member(g.company_id)));
create policy goods_receipt_lines_write on public.goods_receipt_lines
  for all to authenticated
  using (exists (select 1 from public.goods_receipts g
                  where g.id = goods_receipt_lines.receipt_id
                    and public.has_permission(g.company_id, 'purchasing.receiving', 'edit')))
  with check (exists (select 1 from public.goods_receipts g
                  where g.id = goods_receipt_lines.receipt_id
                    and public.has_permission(g.company_id, 'purchasing.receiving', 'edit')));

create policy voucher_lines_read on public.voucher_lines
  for select to authenticated
  using (exists (select 1 from public.check_vouchers v
                  where v.id = voucher_lines.voucher_id
                    and public.is_company_member(v.company_id)));
create policy voucher_lines_write on public.voucher_lines
  for all to authenticated
  using (exists (select 1 from public.check_vouchers v
                  where v.id = voucher_lines.voucher_id
                    and public.has_permission(v.company_id, 'payables.vouchers', 'edit')))
  with check (exists (select 1 from public.check_vouchers v
                  where v.id = voucher_lines.voucher_id
                    and public.has_permission(v.company_id, 'payables.vouchers', 'edit')));
