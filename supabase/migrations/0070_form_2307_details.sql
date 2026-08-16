/**
 * What BIR Form 2307 needs and the system never asked for.
 *
 * The certificate names both parties in full -- registered address and ZIP
 * for each, TIN for each -- and classifies the income payment by its ATC.
 * None of that was stored, so a certificate could only ever have printed with
 * the boxes BIR requires left blank.
 *
 * The ATC sits on the supplier because it follows what they invoice, not what
 * any one payment happened to be for. A supplier billing professional fees
 * every month has one code; asking for it again on each certificate would
 * only invite inconsistency between quarters.
 */

alter table public.companies
  add column if not exists zip_code text;

comment on column public.companies.zip_code is
  'Payor ZIP, box 8A of BIR Form 2307.';

alter table public.vendors
  add column if not exists zip_code text,
  add column if not exists atc_code text;

comment on column public.vendors.zip_code is
  'Payee ZIP, box 4A of BIR Form 2307.';
comment on column public.vendors.atc_code is
  'Alphanumeric Tax Code for this supplier''s income payments, e.g. WC640 for '
  'goods or WC158 for services. Printed on Form 2307.';
