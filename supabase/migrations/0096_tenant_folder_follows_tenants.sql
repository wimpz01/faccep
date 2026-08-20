/**
 * A tenant's papers are governed by the tenants module.
 *
 * 0083 made the second folder of a path decide which permission applies, and
 * listed jobs and contracts. A tenant's own documents live under
 * <company>/tenants/..., which that case does not name, so they fell through
 * to needing edit on Internal Documents -- meaning the person creating a
 * tenant could not attach that tenant's permit unless they had also been
 * given the run of every company document.
 *
 * Added as another arm of the same case, on the same reasoning: the folder
 * says which record the file hangs off, and that record's module decides.
 */

drop policy if exists "documents writable by the module that owns the folder"
  on storage.objects;

create policy "documents writable by the module that owns the folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (
      public.has_permission(
        public.safe_uuid((storage.foldername(name))[1]), 'documents', 'edit')
      or case (storage.foldername(name))[2]
           when 'jobs' then
             public.has_permission(
               public.safe_uuid((storage.foldername(name))[1]),
               'maintenance.repairs', 'edit')
           when 'contracts' then
             public.has_permission(
               public.safe_uuid((storage.foldername(name))[1]),
               'contracts', 'edit')
           when 'tenants' then
             public.has_permission(
               public.safe_uuid((storage.foldername(name))[1]),
               'tenants', 'edit')
           else false
         end
    )
  );
