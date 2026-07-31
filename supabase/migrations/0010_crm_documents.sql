-- Phase 8 -- prospect inquiries and proposals, complaint log, personal
-- calendar, and internal document storage.

create type public.inquiry_status as enum (
  'new',
  'contacted',
  'viewing',
  'proposal_sent',
  'won',
  'lost'
);

create table public.inquiries (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  inquiry_no     text not null,
  company_name   text,
  contact_person text not null,
  mobile_number  text,
  email          text,
  requirement    text,
  unit_id        uuid references public.units (id) on delete set null,
  status         public.inquiry_status not null default 'new',
  source         text,
  -- Drives the follow-up reminder on the dashboard and calendar.
  follow_up_on   date,
  proposed_rent  numeric(14, 2),
  proposed_term_years integer,
  notes          text,
  -- Set when the prospect signs, linking the inquiry to the tenant it became.
  tenant_id      uuid references public.tenants (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index inquiries_no_unique on public.inquiries (company_id, lower(inquiry_no));
create index inquiries_status_idx on public.inquiries (company_id, status);
create index inquiries_follow_up_idx on public.inquiries (company_id, follow_up_on)
  where status not in ('won', 'lost');

create table public.inquiry_notes (
  id         uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  note       text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index inquiry_notes_idx on public.inquiry_notes (inquiry_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Complaints (spec 14)
-- ---------------------------------------------------------------------------

create type public.complaint_status as enum (
  'open',
  'in_progress',
  'resolved',
  'closed'
);

create table public.complaints (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  complaint_no text not null,
  tenant_id    uuid references public.tenants (id) on delete set null,
  unit_id      uuid references public.units (id) on delete set null,
  subject      text not null,
  details      text,
  status       public.complaint_status not null default 'open',
  -- A complaint that turns into work links to the job it raised.
  job_id       uuid references public.maintenance_jobs (id) on delete set null,
  reported_on  date not null default current_date,
  resolved_on  date,
  resolution   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint complaints_resolution_required
    check (status not in ('resolved', 'closed') or resolution is not null)
);

create unique index complaints_no_unique
  on public.complaints (company_id, lower(complaint_no));
create index complaints_status_idx on public.complaints (company_id, status);

create table public.complaint_updates (
  id           uuid primary key default gen_random_uuid(),
  complaint_id uuid not null references public.complaints (id) on delete cascade,
  note         text not null,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index complaint_updates_idx
  on public.complaint_updates (complaint_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Personal calendar (spec 14)
-- ---------------------------------------------------------------------------

create table public.calendar_events (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  details    text,
  event_date date not null,
  event_time time,
  remind_days_before integer not null default 0 check (remind_days_before >= 0),
  is_done    boolean not null default false,
  created_at timestamptz not null default now()
);

create index calendar_events_user_idx
  on public.calendar_events (user_id, event_date);

-- ---------------------------------------------------------------------------
-- Internal documents (spec 14)
-- ---------------------------------------------------------------------------

create type public.document_kind as enum (
  'business_permit',
  'dti_registration',
  'mayors_permit',
  'bir_registration',
  'contract',
  'letter',
  'memo',
  'other'
);

create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  title        text not null,
  doc_kind     public.document_kind not null default 'other',
  storage_path text not null,
  -- Optional links so a document can hang off the record it belongs to.
  tenant_id    uuid references public.tenants (id) on delete set null,
  contract_id  uuid references public.contracts (id) on delete set null,
  issued_on    date,
  expires_on   date,
  notes        text,
  uploaded_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index documents_company_idx on public.documents (company_id, doc_kind);
create index documents_tenant_idx on public.documents (tenant_id);
-- Drives the "permit expiring" reminder.
create index documents_expiry_idx on public.documents (company_id, expires_on)
  where expires_on is not null;

create trigger inquiries_set_updated_at before update on public.inquiries
  for each row execute function public.set_updated_at();
create trigger complaints_set_updated_at before update on public.complaints
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.inquiries         enable row level security;
alter table public.inquiry_notes     enable row level security;
alter table public.complaints        enable row level security;
alter table public.complaint_updates enable row level security;
alter table public.calendar_events   enable row level security;
alter table public.documents         enable row level security;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('inquiries',  'crm.inquiries'),
      ('complaints', 'crm.complaints'),
      ('documents',  'documents')
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

create policy inquiry_notes_read on public.inquiry_notes
  for select to authenticated
  using (exists (select 1 from public.inquiries i
                  where i.id = inquiry_notes.inquiry_id
                    and public.is_company_member(i.company_id)));
create policy inquiry_notes_write on public.inquiry_notes
  for all to authenticated
  using (exists (select 1 from public.inquiries i
                  where i.id = inquiry_notes.inquiry_id
                    and public.has_permission(i.company_id, 'crm.inquiries', 'edit')))
  with check (exists (select 1 from public.inquiries i
                  where i.id = inquiry_notes.inquiry_id
                    and public.has_permission(i.company_id, 'crm.inquiries', 'edit')));

create policy complaint_updates_read on public.complaint_updates
  for select to authenticated
  using (exists (select 1 from public.complaints c
                  where c.id = complaint_updates.complaint_id
                    and public.is_company_member(c.company_id)));
create policy complaint_updates_write on public.complaint_updates
  for all to authenticated
  using (exists (select 1 from public.complaints c
                  where c.id = complaint_updates.complaint_id
                    and public.has_permission(c.company_id, 'crm.complaints', 'edit')))
  with check (exists (select 1 from public.complaints c
                  where c.id = complaint_updates.complaint_id
                    and public.has_permission(c.company_id, 'crm.complaints', 'edit')));

-- The calendar is personal: you only ever see and edit your own entries.
create policy calendar_events_own on public.calendar_events
  for all to authenticated
  using (user_id = auth.uid() and public.is_company_member(company_id))
  with check (user_id = auth.uid() and public.is_company_member(company_id));
