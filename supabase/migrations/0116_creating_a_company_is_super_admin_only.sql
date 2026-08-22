/**
 * Creating a company goes back to being super admin only.
 *
 * 0115 let any company administrator create one. On reflection that is too
 * wide: company admin is granted per company, so it would have meant the
 * administrator of any single company could open new ones indefinitely, and
 * become administrator of each in turn. Creating a company is an install-level
 * act and belongs with the person who runs the installation.
 *
 * Reverted rather than left in place and unused, because a policy that grants
 * more than intended is not made safe by nobody happening to use it.
 */

drop policy if exists companies_insert on public.companies;

create policy companies_insert on public.companies
  for insert to authenticated
  with check (public.is_super_admin());

drop function if exists public.administers_any_company();
