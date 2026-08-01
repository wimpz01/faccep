-- Scheduled data archives.
--
-- This is NOT a substitute for database backups. Supabase already backs up the
-- Postgres instance, and restoring that is the disaster-recovery path -- it
-- restores schema, triggers, sequences and auth together. What this adds is a
-- portable copy of one company's rows that the operator holds themselves: for
-- migrating to another server, for handing to an auditor, and for keeping a
-- copy somewhere the platform account cannot reach.

create type public.backup_frequency as enum ('daily', 'weekly', 'monthly');
create type public.backup_kind as enum ('manual', 'scheduled');

create table public.backup_settings (
  company_id   uuid primary key references public.companies (id) on delete cascade,
  is_enabled   boolean not null default false,
  frequency    public.backup_frequency not null default 'weekly',
  -- Older archives are dropped past this count, so storage does not grow
  -- without bound.
  retain_count integer not null default 8 check (retain_count between 1 and 60),
  last_run_at  timestamptz,
  last_error   text,
  updated_at   timestamptz not null default now()
);

create table public.backups (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  storage_path text not null,
  kind         public.backup_kind not null default 'manual',
  size_bytes   bigint not null default 0,
  table_count  integer not null default 0,
  row_count    integer not null default 0,
  -- The migration the database was on when taken. A restore into a database on
  -- an older schema is not safe, and this is what says so.
  schema_version text,
  taken_at     timestamptz not null default now(),
  taken_by     uuid references public.profiles (id) on delete set null
);

create index backups_company_idx on public.backups (company_id, taken_at desc);

alter table public.backup_settings enable row level security;
alter table public.backups enable row level security;

-- Backups expose every table, so they are admin-only rather than tied to any
-- one module's permission.
create policy backup_settings_read on public.backup_settings
  for select using (public.is_company_admin(company_id));
create policy backup_settings_write on public.backup_settings
  for all using (public.is_company_admin(company_id))
  with check (public.is_company_admin(company_id));

create policy backups_read on public.backups
  for select using (public.is_company_admin(company_id));
create policy backups_write on public.backups
  for all using (public.is_company_admin(company_id))
  with check (public.is_company_admin(company_id));

-- Archives live behind the same company-scoped path convention as the other
-- buckets: backups/<company_id>/<filename>.json
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('backups', 'backups', false, 209715200, array['application/json'])
on conflict (id) do nothing;

create policy "backups readable by company admins"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'backups'
    and public.is_company_admin(public.safe_uuid((storage.foldername(name))[1]))
  );

create policy "backups writable by company admins"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'backups'
    and public.is_company_admin(public.safe_uuid((storage.foldername(name))[1]))
  );

create policy "backups removable by company admins"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'backups'
    and public.is_company_admin(public.safe_uuid((storage.foldername(name))[1]))
  );

/** Which companies are due an archive, for the scheduled run. */
create or replace function public.companies_due_backup()
returns table (company_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.company_id
    from public.backup_settings s
   where s.is_enabled
     and (
       s.last_run_at is null
       or s.last_run_at < now() - case s.frequency
                                    when 'daily'   then interval '1 day'
                                    when 'weekly'  then interval '7 days'
                                    when 'monthly' then interval '30 days'
                                  end
     );
$$;
