/**
 * The company name and address at the head of a billing become optional.
 *
 * 0113 added the logo and a switch for it, which covered the mark but not the
 * words beside it. On pre-printed letterhead the name, address, TIN and phone
 * are already on the paper, and printing them again a centimetre below is the
 * usual complaint about a system that assumes plain stock.
 *
 * Kept apart from show_logo on purpose. They are two things that happen to sit
 * together: a company may print its mark and leave the wording to the
 * letterhead, or print neither, or keep both on plain paper. One switch could
 * not say which.
 */

alter table public.invoice_print_settings
  add column if not exists show_company_header boolean not null default true;

comment on column public.invoice_print_settings.show_company_header is
  'Print the company name, address, TIN and contact number at the head of the billing. Turned off when the sheet is letterhead that already carries them.';
