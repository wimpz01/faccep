/**
 * Withholding only arises on a VAT-registered tenant.
 *
 * The supplier side has said this since 0035 -- vendors_withholding_needs_vat
 * refuses a withholding kind on a vendor who is not VAT-registered. The tenant
 * side had nothing, so a non-VAT tenant could be marked as withholding and
 * quietly produce nonsense: their invoices carry no VATable lines, so the base
 * is nought, so the form would offer nought every time while the tenant record
 * claimed otherwise.
 *
 * Saying it in the schema rather than leaving it to arithmetic makes the
 * refusal happen where the mistake is made -- on the tenant record -- instead
 * of showing an unexplained zero on a payment weeks later.
 *
 * No tenant on file breaks this today.
 */

alter table public.tenants
  add constraint tenants_withholding_needs_vat
    check (not withholds_tax or is_vatable);

comment on column public.tenants.withholds_tax is
  'This tenant withholds creditable tax from the rent they pay. Only a VAT-registered tenant may, since the base is their VATable inclusions. Suggests a figure when a payment is applied; never enforces one.';
