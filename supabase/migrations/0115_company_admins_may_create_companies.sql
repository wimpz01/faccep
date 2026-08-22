/**
 * A company administrator may create a company.
 *
 * Creating one was install-level: only a super admin could, because there is
 * no membership row to authorise against before the company exists. That left
 * the day-to-day administrator of a company unable to add a second one without
 * signing in as somebody else.
 *
 * The rule is now: a super admin, or anyone who already administers a company.
 * Someone trusted to run one is trusted to open another.
 *
 * This is wider than it looks and worth stating plainly. Company admin is
 * granted per company, so an administrator of any one company can now create
 * companies -- and, being their creator, becomes administrator of those too.
 * It is a deliberate loosening, asked for knowingly.
 *
 * What it does not do is let anybody see more. companies_read is still
 * membership-based, so a new company is visible only to whoever is given a
 * seat in it; the application gives the creator one so they are not left with
 * a company they cannot open.
 */

create or replace function public.administers_any_company()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
      from public.company_users cu
      join public.profiles p on p.id = cu.user_id
     where cu.user_id = auth.uid()
       and cu.is_company_admin
       and cu.is_active
       and p.is_active
  );
$fn$;

comment on function public.administers_any_company() is
  'Whether the caller is company admin of at least one live company. The right to create a further company hangs off this.';

drop policy if exists companies_insert on public.companies;

create policy companies_insert on public.companies
  for insert to authenticated
  with check (public.is_super_admin() or public.administers_any_company());
