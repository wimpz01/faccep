/**
 * An attachment is governed by the record it hangs off, not by the bucket.
 *
 * Everything the app attaches goes into the one `documents` bucket, and the
 * write policy asked for a single permission: edit on the Internal Documents
 * module. But the screens that do the attaching are gated on their own module.
 * A property custodian can open a repair job and is shown the photo form --
 * the form checks maintenance.repairs edit, which they have -- and then storage
 * refuses the upload, because they have no right to Internal Documents. The
 * error that surfaces is 'new row violates row-level security policy', which
 * says nothing about which permission was actually missing.
 *
 * The bucket is laid out by owner already:
 *
 *   documents/<company_id>/jobs/<job_id>/<file>          a repair job photo
 *   documents/<company_id>/contracts/<contract_id>/<file> a signed contract
 *   documents/<company_id>/documents/<file>               an internal document
 *
 * So the second folder says which module owns the file, and the policy can ask
 * that module. Edit on the owning record now earns the right to attach to it.
 *
 * This is written as an OR rather than a swap: whoever could upload before
 * still can. The change only ever adds, so no existing workflow stops working
 * because a permission moved.
 *
 * Reads are untouched -- any member of the company could already see the whole
 * bucket -- and so are deletes, which only the Internal Documents screen
 * offers.
 */

drop policy if exists "documents writable with documents edit" on storage.objects;

create policy "documents writable by the module that owns the folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (
      -- The Internal Documents right still opens the whole bucket.
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
           else false
         end
    )
  );
