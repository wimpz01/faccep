-- handle_new_auth_user() inserted a profile without a user_code, which became
-- a NOT NULL violation once codes were required -- so creating any auth user
-- failed outright.
--
-- The trigger now derives a provisional code from the email, with a numeric
-- suffix when that is taken. The Users screen overwrites it with the code the
-- administrator actually chose, so this only ever has to be unique, not
-- pretty.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base    text;
  v_code    text;
  v_counter integer := 1;
begin
  v_base := upper(regexp_replace(split_part(new.email, '@', 1), '[^a-zA-Z0-9]', '', 'g'));
  if v_base = '' or v_base is null then
    v_base := 'USER';
  end if;
  v_base := left(v_base, 16);

  v_code := v_base;
  while exists (
    select 1 from public.profiles where lower(user_code) = lower(v_code)
  ) loop
    v_counter := v_counter + 1;
    v_code := v_base || v_counter::text;
  end loop;

  insert into public.profiles (id, email, full_name, user_code)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    v_code
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
