-- Sign in by user code instead of email.
--
-- Supabase Auth is keyed on email and that does not change: the email remains
-- the account's identity underneath. The user code is what people actually
-- type, which suits staff who have a payroll or employee code and no work
-- email of their own.
--
-- Codes are unique across the whole install, not per company. Auth happens
-- before any company is known, so a code shared between two companies would be
-- ambiguous at exactly the moment it needs to be decisive.

alter table public.profiles
  add column if not exists user_code text;

-- Seed a code for anyone who predates this: the email local part, letters and
-- digits only, uppercased. Collisions get a numeric suffix.
with candidates as (
  select id,
         upper(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9]', '', 'g')) as base,
         row_number() over (
           partition by upper(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9]', '', 'g'))
           order by created_at
         ) as seq
    from public.profiles
   where user_code is null
)
update public.profiles p
   set user_code = case when c.seq = 1 then c.base else c.base || c.seq::text end
  from candidates c
 where p.id = c.id;

-- A profile with no code could never sign in, so the column is required.
alter table public.profiles
  alter column user_code set not null;

create unique index if not exists profiles_user_code_key
  on public.profiles (lower(user_code));

comment on column public.profiles.user_code is
  'What the user types to sign in. Unique across the install; the email remains the auth identity.';

/**
 * Resolves a user code to the email Supabase Auth expects.
 *
 * Returns null for an unknown code. Called only from the server, never
 * exposed to the browser, so it cannot be used to enumerate codes.
 */
create or replace function public.email_for_user_code(p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select email from public.profiles
   where lower(user_code) = lower(trim(p_code));
$$;
