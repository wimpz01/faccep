/**
 * A tenant's papers, kept with the tenant.
 *
 * The documents table already carries everything this needs -- the tenant it
 * belongs to, the kind it is, where the file sits, when it expires and who
 * uploaded it -- so nothing new is built here. Three gaps are filled instead.
 *
 * Two kinds are added. SEC registration and a valid ID are asked for alongside
 * the mayor's permit, the DTI and the BIR registration, and had nowhere to go
 * but 'other', where they could not be told apart afterwards.
 *
 * A no_expiry flag is added. Some papers genuinely never lapse, and a blank
 * expiry date cannot say whether that is the case or whether nobody has filled
 * it in yet. Those are different facts and only one of them should stop the
 * reminders. Nothing existing changes: every document on file reads as
 * "expiry not stated", which is what it was.
 *
 * Deliberately not added: an OCR status and a verification status. There is no
 * OCR -- the date is typed by the person looking at the document -- so a column
 * recording how a machine read it would only ever hold one value, and a
 * verification flag would mean confirming what somebody had just typed.
 */

alter type public.document_kind add value if not exists 'sec_registration';
alter type public.document_kind add value if not exists 'valid_id';

alter table public.documents
  add column if not exists no_expiry boolean not null default false;

comment on column public.documents.no_expiry is
  'The document genuinely never lapses, as against nobody having entered a '
  'date yet. Only this silences the expiry reminders.';

/*
 * A date and "never expires" contradict each other, and the pair is read by
 * the reminders. Refused rather than resolved silently.
 */
alter table public.documents
  drop constraint if exists documents_expiry_is_one_thing;
alter table public.documents
  add constraint documents_expiry_is_one_thing
    check (not (no_expiry and expires_on is not null));

create index if not exists documents_expiry_idx
  on public.documents (company_id, expires_on)
  where expires_on is not null and no_expiry = false;
