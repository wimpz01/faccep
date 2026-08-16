/**
 * VAT decided per billing item, and inclusive as well as exclusive.
 *
 * Until now VAT was a property of the tenant: is_vatable on the tenant flowed
 * to the invoice, every line inherited it, and the total was the sum of the
 * lines plus VAT on top. That makes two things impossible. A tenant cannot have
 * rent that is VATable and association dues that are exempt, because the flag is
 * the same for both. And a price agreed as VAT-inclusive -- which is how rent is
 * usually quoted -- had to be divided by hand before it was entered, or VAT was
 * added on top of a figure that already contained it.
 *
 * So each item now carries its own treatment, and where that treatment is
 * VATable, whether the amount already includes the VAT.
 *
 *   vatable      VAT applies. Inclusive: the amount is the total and the VAT is
 *                extracted from it. Exclusive: the amount is net and VAT is
 *                added.
 *   non_vat      a non-VAT-registered supply
 *   vat_exempt   exempt under the Tax Code
 *   zero_rated   zero-rated, typically export or a treaty
 *   no_tax       outside VAT entirely, e.g. a reimbursement
 *
 * The last four all produce nought VAT. They are kept apart because BIR wants
 * exempt, zero-rated and VATable sales reported separately, and once they are
 * merged into "not VATable" the schedule cannot be rebuilt.
 *
 * The tenant still governs. A tenant who is not VAT-registered cannot be
 * charged output VAT whatever an item says, so their invoices are unchanged.
 *
 * The rate now lives in accounting_settings, one per company, and every invoice
 * line stamps the rate in force when it was raised. Changing the rate later
 * moves nothing that has already been billed.
 *
 * Nothing existing is restated. Every line already raised was VAT-exclusive, so
 * it is backfilled as such, and the per-line VAT is reconciled to the invoice's
 * stored VAT to the centavo before the totals are recomputed from it.
 */

create type public.tax_treatment as enum (
  'vatable',
  'non_vat',
  'vat_exempt',
  'zero_rated',
  'no_tax'
);

create type public.vat_mode as enum ('inclusive', 'exclusive');

-- ---------------------------------------------------------------------------
-- The rate, one per company
-- ---------------------------------------------------------------------------

alter table public.accounting_settings
  add column if not exists vat_rate numeric(5, 2) not null default 12
    check (vat_rate >= 0 and vat_rate < 100);

comment on column public.accounting_settings.vat_rate is
  'Output VAT rate for this company. Stamped onto each invoice line when it is '
  'raised, so changing it never restates an invoice already issued.';

-- ---------------------------------------------------------------------------
-- What each inclusion is
-- ---------------------------------------------------------------------------

alter table public.contract_inclusions
  add column if not exists tax_treatment public.tax_treatment
    not null default 'vatable',
  add column if not exists vat_mode public.vat_mode;

-- Everything already agreed was exclusive; that is what the billing run did.
-- Filled before the rule below is imposed, or every existing row breaks it.
update public.contract_inclusions
   set vat_mode = 'exclusive'
 where tax_treatment = 'vatable' and vat_mode is null;

/*
 * A VAT mode only means anything on a VATable item. Requiring it there and
 * forbidding it elsewhere stops a row that says "exempt, inclusive", which
 * would leave the next reader guessing which half to believe.
 */
alter table public.contract_inclusions
  drop constraint if exists contract_inclusions_vat_mode_fits;
alter table public.contract_inclusions
  add constraint contract_inclusions_vat_mode_fits check (
    (tax_treatment = 'vatable' and vat_mode is not null)
    or (tax_treatment <> 'vatable' and vat_mode is null)
  );

comment on column public.contract_inclusions.tax_treatment is
  'How this item is taxed. Only vatable attracts VAT; the rest are apart for '
  'reporting, not for arithmetic.';
comment on column public.contract_inclusions.vat_mode is
  'On a VATable item: inclusive means the amount already contains the VAT.';

-- ---------------------------------------------------------------------------
-- What each line was charged
-- ---------------------------------------------------------------------------

alter table public.invoice_lines
  add column if not exists tax_treatment public.tax_treatment
    not null default 'vatable',
  add column if not exists vat_mode public.vat_mode,
  add column if not exists vat_rate numeric(5, 2) not null default 0,
  add column if not exists net_amount numeric(14, 2) not null default 0,
  add column if not exists vat_amount numeric(14, 2) not null default 0,
  add column if not exists line_total numeric(14, 2) not null default 0;

comment on column public.invoice_lines.vat_rate is
  'The rate in force when this line was raised. Historical lines keep it.';
comment on column public.invoice_lines.net_amount is
  'The charge before VAT. On an inclusive line this is less than amount.';
comment on column public.invoice_lines.line_total is
  'net_amount + vat_amount. What this line adds to the invoice.';

/*
 * Backfill.
 *
 * Every line so far was exclusive, so net is the amount as entered and the VAT
 * is the invoice's rate on top -- but only where the invoice itself was VATable,
 * which is how it was actually billed.
 *
 * The guard that refuses to let a released invoice's lines be touched is stood
 * down for the length of this backfill, and put back straight afterwards. It is
 * protecting the figures from being edited; this is describing figures that
 * were already charged, in columns that did not exist when they were.
 */
alter table public.invoice_lines disable trigger invoice_lines_guard;
alter table public.invoice_lines disable trigger invoice_lines_recalculate;

update public.invoice_lines l
   set tax_treatment = case when l.is_vatable then 'vatable'::public.tax_treatment
                            else 'non_vat'::public.tax_treatment end,
       vat_mode      = case when l.is_vatable then 'exclusive'::public.vat_mode
                            else null end,
       vat_rate      = case when l.is_vatable and i.is_vatable then i.vat_rate
                            else 0 end,
       net_amount    = l.amount,
       vat_amount    = case when l.is_vatable and i.is_vatable
                            then round(l.amount * i.vat_rate / 100, 2)
                            else 0 end,
       line_total    = l.amount + case when l.is_vatable and i.is_vatable
                                       then round(l.amount * i.vat_rate / 100, 2)
                                       else 0 end
  from public.invoices i
 where i.id = l.invoice_id;

/*
 * The old sum rounded once, over the whole vatable subtotal; the new one rounds
 * each line. On some invoices that differs by a centavo. The difference is put
 * onto the largest VATable line so every invoice keeps the total it was issued
 * with -- a released invoice must not change because the arithmetic moved.
 */
with per_invoice as (
  select l.invoice_id,
         sum(l.vat_amount) as line_vat,
         i.vat_amount      as invoice_vat
    from public.invoice_lines l
    join public.invoices i on i.id = l.invoice_id
   group by l.invoice_id, i.vat_amount
  having sum(l.vat_amount) <> i.vat_amount
),
biggest as (
  select distinct on (l.invoice_id)
         l.id, p.invoice_vat - p.line_vat as adjustment
    from public.invoice_lines l
    join per_invoice p on p.invoice_id = l.invoice_id
   where l.vat_amount > 0
   order by l.invoice_id, l.vat_amount desc, l.id
)
update public.invoice_lines l
   set vat_amount = l.vat_amount + b.adjustment,
       line_total = l.line_total + b.adjustment
  from biggest b
 where b.id = l.id;

alter table public.invoice_lines enable trigger invoice_lines_guard;
alter table public.invoice_lines enable trigger invoice_lines_recalculate;

/**
 * The invoice is the sum of its lines, each already taxed on its own terms.
 *
 * Nothing is computed from the invoice's own flag any more: an inclusive line
 * has had its VAT taken out of the amount, an exclusive one has had it added,
 * and an exempt one has none. Adding VAT again here is exactly the double
 * charge this change exists to prevent.
 */
create or replace function public.recalculate_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_net   numeric(14, 2);
  v_vat   numeric(14, 2);
begin
  select coalesce(sum(net_amount), 0), coalesce(sum(vat_amount), 0)
    into v_net, v_vat
    from public.invoice_lines
   where invoice_id = p_invoice_id;

  update public.invoices
     set subtotal   = v_net,
         vat_amount = v_vat,
         total      = v_net + v_vat
   where id = p_invoice_id;
end;
$$;

comment on function public.recalculate_invoice(uuid) is
  'Totals an invoice from its lines, each of which already carries its own net '
  'and VAT. Never applies VAT a second time.';
