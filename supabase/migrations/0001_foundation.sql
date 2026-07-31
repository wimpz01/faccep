-- Faccep Property Management System
-- Phase 1 foundation: multi-company tenancy, users, admin-defined roles,
-- granular permission matrix, and audit trail.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Module registry
--
-- Every permission-checkable transaction/module in the system has a row here.
-- Roles are scored against these keys. Seeded in 0003_seed_modules.sql.
-- ---------------------------------------------------------------------------

create table public.modules (
  key             text primary key,
  label           text not null,
  module_group    text not null,
  description     text,
  sort_order      integer not null default 0,
  supports_approve boolean not null default false,
  supports_void    boolean not null default false
);

comment on table public.modules is
  'Registry of permission-checkable modules/transactions. Referenced by role_permissions and user_permissions.';

-- ---------------------------------------------------------------------------
-- Companies and locations
--
-- A location belongs to exactly one company (spec 15).
-- ---------------------------------------------------------------------------

create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  legal_name  text,
  tin         text,
  address     text,
  contact_person text,
  contact_number text,
  email       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index companies_name_key on public.companies (lower(name));

create type public.property_type as enum (
  'commercial_building',
  'office',
  'warehouse',
  'vacant_lot',
  'apartment'
);

create table public.locations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete restrict,
  code          text not null,
  name          text not null,
  property_type public.property_type not null default 'commercial_building',
  address       text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index locations_company_code_key
  on public.locations (company_id, lower(code));
create index locations_company_id_idx on public.locations (company_id);

-- ---------------------------------------------------------------------------
-- Profiles
--
-- Mirrors auth.users. Users are created by an Admin only -- there is no public
-- signup (spec 2: "Only Admin can create users").
-- ---------------------------------------------------------------------------

create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  full_name      text not null default '',
  email          text not null,
  mobile_number  text,
  -- Install-level owner. Bypasses every permission check in every company.
  is_super_admin boolean not null default false,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index profiles_email_idx on public.profiles (lower(email));

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Roles
--
-- Roles are entirely admin-defined (spec 2: there is no fixed role list).
-- They are scoped per company so each company can build its own org structure.
-- ---------------------------------------------------------------------------

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index roles_company_name_key on public.roles (company_id, lower(name));
create index roles_company_id_idx on public.roles (company_id);

-- The permission matrix: (role, module) -> {view, edit, delete, approve, void}
--
-- `void` is deliberately its own flag rather than folded into delete: a void
-- keeps the record and reverses its effect, and it additionally requires
-- approval before taking effect (spec 2, spec 7).
create table public.role_permissions (
  role_id     uuid not null references public.roles (id) on delete cascade,
  module_key  text not null references public.modules (key) on delete cascade,
  can_view    boolean not null default false,
  can_edit    boolean not null default false,
  can_delete  boolean not null default false,
  can_approve boolean not null default false,
  can_void    boolean not null default false,
  primary key (role_id, module_key)
);

-- ---------------------------------------------------------------------------
-- Company membership
--
-- A user's access can span one or more companies (spec 15), so membership is
-- its own row per company, each carrying that company's role.
-- ---------------------------------------------------------------------------

create table public.company_users (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  role_id          uuid references public.roles (id) on delete set null,
  -- Full access within this company, including user/role administration.
  is_company_admin boolean not null default false,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_users_user_id_idx on public.company_users (user_id);
create index company_users_company_id_idx on public.company_users (company_id);

-- Per-user overrides layered on top of the role matrix (spec 2:
-- "Individual users can also get overrides on top of their role").
-- NULL means "inherit from role" -- only non-null values override.
create table public.user_permissions (
  company_user_id uuid not null references public.company_users (id) on delete cascade,
  module_key      text not null references public.modules (key) on delete cascade,
  can_view        boolean,
  can_edit        boolean,
  can_delete      boolean,
  can_approve     boolean,
  can_void        boolean,
  primary key (company_user_id, module_key)
);

-- ---------------------------------------------------------------------------
-- Audit trail (spec 15)
--
-- Append-only. No update/delete policy is ever granted on this table.
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id           bigserial primary key,
  company_id   uuid references public.companies (id) on delete set null,
  actor_id     uuid references public.profiles (id) on delete set null,
  actor_email  text,
  action       text not null,          -- create | update | delete | void | approve | login | ...
  module_key   text,
  entity_table text,
  entity_id    text,
  summary      text,
  before_data  jsonb,
  after_data   jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_company_created_idx
  on public.audit_log (company_id, created_at desc);
create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);
create index audit_log_entity_idx on public.audit_log (entity_table, entity_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger companies_set_updated_at before update on public.companies
  for each row execute function public.set_updated_at();
create trigger locations_set_updated_at before update on public.locations
  for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger roles_set_updated_at before update on public.roles
  for each row execute function public.set_updated_at();
create trigger company_users_set_updated_at before update on public.company_users
  for each row execute function public.set_updated_at();
