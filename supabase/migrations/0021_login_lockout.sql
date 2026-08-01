-- Failed-login lockout.
--
-- Three wrong passwords locks the account; only an administrator can release
-- it. The counting and the threshold live in the database rather than the
-- login action, so the rule cannot be sidestepped by another code path and can
-- be tested directly.
--
-- Lockout is separate from is_active: a locked account is a security event and
-- expected to be released, whereas an inactive one has been deliberately
-- switched off.

alter table public.profiles
  add column if not exists failed_login_attempts integer not null default 0,
  add column if not exists last_failed_login_at  timestamptz,
  add column if not exists locked_at             timestamptz;

comment on column public.profiles.locked_at is
  'Set when failed_login_attempts reaches the threshold. Cleared only by unlock_account().';

/** Attempts allowed before the account locks. */
create or replace function public.max_login_attempts()
returns integer
language sql
immutable
as $$
  select 3;
$$;

/**
 * Records a failed sign-in.
 *
 * Returns how many attempts remain, or 0 once the account is locked. An
 * unknown address returns the full allowance rather than raising, so the
 * caller cannot use this to discover whether an account exists.
 */
create or replace function public.record_failed_login(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_attempts integer;
begin
  select * into v_profile from public.profiles
   where lower(email) = lower(p_email);

  if not found then
    return public.max_login_attempts();
  end if;

  -- Already locked: stay locked, do not keep counting.
  if v_profile.locked_at is not null then
    return 0;
  end if;

  v_attempts := v_profile.failed_login_attempts + 1;

  update public.profiles
     set failed_login_attempts = v_attempts,
         last_failed_login_at  = now(),
         locked_at = case when v_attempts >= public.max_login_attempts()
                          then now() else null end
   where id = v_profile.id;

  return greatest(public.max_login_attempts() - v_attempts, 0);
end;
$$;

/** Clears the counter after a successful sign-in. */
create or replace function public.clear_failed_logins(p_email text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set failed_login_attempts = 0,
         last_failed_login_at = null
   where lower(email) = lower(p_email)
     and locked_at is null;
$$;

/** True only for an account that exists and is locked. */
create or replace function public.is_account_locked(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select locked_at is not null from public.profiles
      where lower(email) = lower(p_email)),
    false
  );
$$;

/**
 * Releases a locked account. Callable only by someone with edit rights on the
 * Users module in a company the account belongs to, or by a super admin.
 */
create or replace function public.unlock_account(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (
    public.is_super_admin()
    or exists (
      select 1 from public.company_users cu
       where cu.user_id = p_user
         and public.has_permission(cu.company_id, 'admin.users', 'edit')
    )
  ) then
    raise exception 'You do not have permission to unlock this account.'
      using errcode = 'insufficient_privilege';
  end if;

  update public.profiles
     set locked_at = null,
         failed_login_attempts = 0,
         last_failed_login_at = null
   where id = p_user;
end;
$$;
