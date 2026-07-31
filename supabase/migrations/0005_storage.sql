-- Storage for unit photos (spec 5) and scanned wet-signed contracts (spec 4.2).
--
-- Object paths are company-scoped so the bucket policies can reuse the same
-- tenancy boundary as every other table:
--
--   unit-photos/<company_id>/<unit_id>/<filename>
--   documents/<company_id>/contracts/<contract_id>/<filename>

-- A storage path whose first folder is not a UUID would raise mid-policy and
-- fail the whole query, so the cast is done defensively: an unparseable value
-- becomes NULL, and both is_company_member and has_permission reject NULL.
create or replace function public.safe_uuid(value text)
returns uuid
language plpgsql
immutable
as $$
begin
  return value::uuid;
exception
  when others then
    return null;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('unit-photos', 'unit-photos', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp']),
  ('documents', 'documents', false, 26214400,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- Reads: any member of the owning company.
create policy "unit photos readable by company members"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'unit-photos'
    and public.is_company_member(public.safe_uuid((storage.foldername(name))[1]))
  );

create policy "unit photos writable with units edit"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'unit-photos'
    and public.has_permission(public.safe_uuid((storage.foldername(name))[1]), 'units', 'edit')
  );

create policy "unit photos removable with units edit"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'unit-photos'
    and public.has_permission(public.safe_uuid((storage.foldername(name))[1]), 'units', 'edit')
  );

create policy "documents readable by company members"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_company_member(public.safe_uuid((storage.foldername(name))[1]))
  );

create policy "documents writable with documents edit"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.has_permission(public.safe_uuid((storage.foldername(name))[1]), 'documents', 'edit')
  );

create policy "documents removable with documents delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.has_permission(public.safe_uuid((storage.foldername(name))[1]), 'documents', 'delete')
  );
