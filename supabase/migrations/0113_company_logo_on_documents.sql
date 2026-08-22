/**
 * A company's logo, and whether the billing carries it.
 *
 * The billing has printed the company name as text since the beginning, which
 * is fine on plain paper and wrong on letterhead -- printing the name again
 * over a pre-printed head is the usual complaint. So the mark is uploaded
 * once and shown or hidden per document, like every other part of the sheet.
 *
 * Stored in the documents bucket under <company>/branding/, following the
 * convention 0083 set: the second folder says which module governs the file.
 * Reading is already open to any member of the company, which is what a logo
 * on a printout needs.
 */

alter table public.companies
  add column if not exists logo_path text;

comment on column public.companies.logo_path is
  'Object path in the documents bucket for the company mark shown on printed documents. Null means print the name as text.';

alter table public.invoice_print_settings
  add column if not exists show_logo boolean not null default true;

comment on column public.invoice_print_settings.show_logo is
  'Print the company logo at the head of the billing. Ignored when no logo has been uploaded, and turned off when printing onto letterhead.';

-- ---------------------------------------------------------------------------
-- Who may put a mark in the branding folder
-- ---------------------------------------------------------------------------

/*
 * The logo is set from the billing print layout screen, so Edit on invoices
 * is what governs it -- requiring company administration instead would mean
 * the person laying out the billing could not place the mark on it.
 *
 * Rewritten whole rather than patched because a policy cannot be altered in
 * part; the arms 0083 and 0096 added are carried across unchanged.
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
           when 'branding' then
             public.has_permission(
               public.safe_uuid((storage.foldername(name))[1]),
               'billing.invoices', 'edit')
           else false
         end
    )
  );

/*
 * Replacing a logo means removing the one before it, so the same people who
 * may place a mark may take it away again. Without this, changing the logo
 * would leave every previous one in the bucket for ever.
 */
create policy "branding removable with invoice edit"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'branding'
    and public.has_permission(
      public.safe_uuid((storage.foldername(name))[1]),
      'billing.invoices', 'edit')
  );
