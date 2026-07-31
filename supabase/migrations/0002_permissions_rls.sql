-- Permission resolution functions + row level security.
--
-- Two layers guard every request:
--   1. Company tenancy      -- a hard boundary enforced here in RLS.
--   2. Granular permissions -- (module, action) resolved by has_permission(),
--      used both by RLS policies and by the app's requirePermission() helper.
--
-- All helpers are SECURITY DEFINER so that policies which consult
-- company_users / role_permissions do not recurse into their own RLS.

-- ---------------------------------------------------------------------------
-- Resolution helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_super_admin and p.is_active
       from public.profiles p
      where p.id = auth.uid()),
    false
  );
$$;

create or replace function public.is_company_member(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
      or exists (
           select 1
             from public.company_users cu
             join public.profiles p on p.id = cu.user_id
            where cu.company_id = p_company
              and cu.user_id = auth.uid()
              and cu.is_active
              and p.is_active
         );
$$;

create or replace function public.is_company_admin(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
      or exists (
           select 1
             from public.company_users cu
             join public.profiles p on p.id = cu.user_id
            where cu.company_id = p_company
              and cu.user_id = auth.uid()
              and cu.is_active
              and cu.is_company_admin
              and p.is_active
         );
$$;

-- Resolves one (module, action) permission for the current user in one company.
--
-- Precedence: super admin > company admin > per-user override > role > deny.
-- A user override column that is NULL means "inherit from the role"; only a
-- non-null value overrides, so an override can both grant and revoke.
create or replace function public.has_permission(
  p_company uuid,
  p_module  text,
  p_action  text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cu       public.company_users%rowtype;
  v_override boolean;
  v_role     boolean;
begin
  if p_company is null or p_module is null or p_action is null then
    return false;
  end if;

  if p_action not in ('view', 'edit', 'delete', 'approve', 'void') then
    raise exception 'unknown permission action: %', p_action;
  end if;

  if public.is_super_admin() then
    return true;
  end if;

  select cu.* into v_cu
    from public.company_users cu
    join public.profiles p on p.id = cu.user_id
   where cu.company_id = p_company
     and cu.user_id = auth.uid()
     and cu.is_active
     and p.is_active;

  if not found then
    return false;
  end if;

  if v_cu.is_company_admin then
    return true;
  end if;

  select case p_action
           when 'view'    then up.can_view
           when 'edit'    then up.can_edit
           when 'delete'  then up.can_delete
           when 'approve' then up.can_approve
           when 'void'    then up.can_void
         end
    into v_override
    from public.user_permissions up
   where up.company_user_id = v_cu.id
     and up.module_key = p_module;

  if v_override is not null then
    return v_override;
  end if;

  if v_cu.role_id is null then
    return false;
  end if;

  select case p_action
           when 'view'    then rp.can_view
           when 'edit'    then rp.can_edit
           when 'delete'  then rp.can_delete
           when 'approve' then rp.can_approve
           when 'void'    then rp.can_void
         end
    into v_role
    from public.role_permissions rp
   where rp.role_id = v_cu.role_id
     and rp.module_key = p_module;

  return coalesce(v_role, false);
end;
$$;

-- Returns the whole resolved matrix for the current user in one company.
-- The app loads this once per request and caches it, rather than issuing one
-- has_permission() round trip per module.
create or replace function public.my_permissions(p_company uuid)
returns table (
  module_key  text,
  can_view    boolean,
  can_edit    boolean,
  can_delete  boolean,
  can_approve boolean,
  can_void    boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cu     public.company_users%rowtype;
  v_is_all boolean := false;
begin
  if public.is_super_admin() then
    v_is_all := true;
  else
    select cu.* into v_cu
      from public.company_users cu
      join public.profiles p on p.id = cu.user_id
     where cu.company_id = p_company
       and cu.user_id = auth.uid()
       and cu.is_active
       and p.is_active;

    if not found then
      return;
    end if;

    v_is_all := v_cu.is_company_admin;
  end if;

  if v_is_all then
    return query
      select m.key, true, true, true, m.supports_approve, m.supports_void
        from public.modules m;
    return;
  end if;

  return query
    select m.key,
           coalesce(up.can_view,    rp.can_view,    false),
           coalesce(up.can_edit,    rp.can_edit,    false),
           coalesce(up.can_delete,  rp.can_delete,  false),
           coalesce(up.can_approve, rp.can_approve, false),
           coalesce(up.can_void,    rp.can_void,    false)
      from public.modules m
      left join public.role_permissions rp
             on rp.module_key = m.key and rp.role_id = v_cu.role_id
      left join public.user_permissions up
             on up.module_key = m.key and up.company_user_id = v_cu.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.modules          enable row level security;
alter table public.companies        enable row level security;
alter table public.locations        enable row level security;
alter table public.profiles         enable row level security;
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;
alter table public.company_users    enable row level security;
alter table public.user_permissions enable row level security;
alter table public.audit_log        enable row level security;

-- modules: a static registry, readable by every signed-in user.
create policy modules_read on public.modules
  for select to authenticated using (true);

-- companies -----------------------------------------------------------------
-- Creating and deleting a company is an install-level act (super admin only),
-- because there is no membership row to authorise against before it exists.
create policy companies_read on public.companies
  for select to authenticated
  using (public.is_company_member(id));

create policy companies_insert on public.companies
  for insert to authenticated
  with check (public.is_super_admin());

create policy companies_update on public.companies
  for update to authenticated
  using (public.has_permission(id, 'admin.companies', 'edit'))
  with check (public.has_permission(id, 'admin.companies', 'edit'));

create policy companies_delete on public.companies
  for delete to authenticated
  using (public.is_super_admin());

-- locations -----------------------------------------------------------------
-- Readable by any member: locations are referenced across billing, properties
-- and reporting, so gating reads on admin.locations would break those modules.
create policy locations_read on public.locations
  for select to authenticated
  using (public.is_company_member(company_id));

create policy locations_insert on public.locations
  for insert to authenticated
  with check (public.has_permission(company_id, 'admin.locations', 'edit'));

create policy locations_update on public.locations
  for update to authenticated
  using (public.has_permission(company_id, 'admin.locations', 'edit'))
  with check (public.has_permission(company_id, 'admin.locations', 'edit'));

create policy locations_delete on public.locations
  for delete to authenticated
  using (public.has_permission(company_id, 'admin.locations', 'delete'));

-- profiles ------------------------------------------------------------------
-- Visible to yourself and to anyone sharing a company with you (needed to
-- render user lists, assignee pickers and audit entries).
create policy profiles_read on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_super_admin()
    or exists (
         select 1
           from public.company_users mine
           join public.company_users theirs
             on theirs.company_id = mine.company_id
          where mine.user_id = auth.uid()
            and theirs.user_id = public.profiles.id
       )
  );

-- Users may edit their own profile. Administering other people's accounts
-- goes through server actions on the service-role client, which also has to
-- touch auth.users.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Column-level guard so self-service editing can never grant is_super_admin
-- or reactivate a disabled account.
revoke update on public.profiles from authenticated;
grant update (full_name, mobile_number) on public.profiles to authenticated;

-- roles ---------------------------------------------------------------------
create policy roles_read on public.roles
  for select to authenticated
  using (public.is_company_member(company_id));

create policy roles_insert on public.roles
  for insert to authenticated
  with check (public.has_permission(company_id, 'admin.roles', 'edit'));

create policy roles_update on public.roles
  for update to authenticated
  using (public.has_permission(company_id, 'admin.roles', 'edit'))
  with check (public.has_permission(company_id, 'admin.roles', 'edit'));

create policy roles_delete on public.roles
  for delete to authenticated
  using (public.has_permission(company_id, 'admin.roles', 'delete'));

-- role_permissions ----------------------------------------------------------
create policy role_permissions_read on public.role_permissions
  for select to authenticated
  using (exists (
    select 1 from public.roles r
     where r.id = role_permissions.role_id
       and public.is_company_member(r.company_id)
  ));

create policy role_permissions_write on public.role_permissions
  for all to authenticated
  using (exists (
    select 1 from public.roles r
     where r.id = role_permissions.role_id
       and public.has_permission(r.company_id, 'admin.roles', 'edit')
  ))
  with check (exists (
    select 1 from public.roles r
     where r.id = role_permissions.role_id
       and public.has_permission(r.company_id, 'admin.roles', 'edit')
  ));

-- company_users -------------------------------------------------------------
create policy company_users_read on public.company_users
  for select to authenticated
  using (user_id = auth.uid() or public.is_company_member(company_id));

create policy company_users_insert on public.company_users
  for insert to authenticated
  with check (public.has_permission(company_id, 'admin.users', 'edit'));

create policy company_users_update on public.company_users
  for update to authenticated
  using (public.has_permission(company_id, 'admin.users', 'edit'))
  with check (public.has_permission(company_id, 'admin.users', 'edit'));

create policy company_users_delete on public.company_users
  for delete to authenticated
  using (public.has_permission(company_id, 'admin.users', 'delete'));

-- user_permissions ----------------------------------------------------------
create policy user_permissions_read on public.user_permissions
  for select to authenticated
  using (exists (
    select 1 from public.company_users cu
     where cu.id = user_permissions.company_user_id
       and (cu.user_id = auth.uid() or public.is_company_member(cu.company_id))
  ));

create policy user_permissions_write on public.user_permissions
  for all to authenticated
  using (exists (
    select 1 from public.company_users cu
     where cu.id = user_permissions.company_user_id
       and public.has_permission(cu.company_id, 'admin.users', 'edit')
  ))
  with check (exists (
    select 1 from public.company_users cu
     where cu.id = user_permissions.company_user_id
       and public.has_permission(cu.company_id, 'admin.users', 'edit')
  ));

-- audit_log -----------------------------------------------------------------
-- Append only: no update or delete policy is granted to anyone, ever.
create policy audit_log_read on public.audit_log
  for select to authenticated
  using (public.has_permission(company_id, 'admin.audit', 'view'));

create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (actor_id = auth.uid() and public.is_company_member(company_id));

revoke update, delete on public.audit_log from authenticated, anon;
