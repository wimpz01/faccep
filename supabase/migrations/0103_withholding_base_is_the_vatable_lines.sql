/**
 * The base a tenant withholds on is the VATable inclusions, not the invoice.
 *
 * 0101 took 5% of the invoice's whole VAT-exclusive subtotal. That is right
 * only while every line on the invoice is VATable, which is true of the
 * invoices raised so far and is not a rule. An invoice can carry a line that
 * is vat_exempt, zero_rated, non_vat or no_tax -- a reimbursement passed
 * straight through, say -- and those do not belong in the base. Taking 5% of
 * the whole subtotal would withhold on them too, and over-withholding is money
 * out of the door that then has to be chased back through a BIR refund.
 *
 * So the base becomes the net of the VATable lines alone. On every invoice
 * raised to date that is the same figure the old rule gave, so nothing already
 * computed changes; it differs only on the mixed invoices this exists to get
 * right.
 *
 * The VAT half needs no such change: a non-VATable line carries nought VAT
 * already, so vat_amount is by construction the VATable lines' VAT.
 */

alter table public.invoices
  add column if not exists vatable_net numeric(14, 2) not null default 0;

comment on column public.invoices.vatable_net is
  'Net of the VATable lines only. The base a withholding tenant computes their 5% on; subtotal includes exempt and no-tax lines, which do not belong in it.';

-- ---------------------------------------------------------------------------
-- Kept in step with the lines
-- ---------------------------------------------------------------------------

/**
 * The invoice is the sum of its lines, each already taxed on its own terms.
 *
 * Nothing is computed from the invoice's own flag any more: an inclusive line
 * has had its VAT taken out of the amount, an exclusive one has had it added,
 * and an exempt one has none. Adding VAT again here is exactly the double
 * charge this change exists to prevent.
 *
 * Now also totals the VATable lines by themselves, which is what a withholding
 * tenant computes their tax on.
 */
create or replace function public.recalculate_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_net     numeric(14, 2);
  v_vat     numeric(14, 2);
  v_vatable numeric(14, 2);
begin
  select coalesce(sum(net_amount), 0),
         coalesce(sum(vat_amount), 0),
         coalesce(sum(net_amount) filter (where tax_treatment = 'vatable'), 0)
    into v_net, v_vat, v_vatable
    from public.invoice_lines
   where invoice_id = p_invoice_id;

  update public.invoices
     set subtotal    = v_net,
         vat_amount  = v_vat,
         vatable_net = v_vatable,
         total       = v_net + v_vat
   where id = p_invoice_id;
end;
$fn$;

comment on function public.recalculate_invoice(uuid) is
  'Totals an invoice from its lines, each of which already carries its own net and VAT. Never applies VAT a second time.';

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

/*
 * A released invoice is frozen, and rightly so, but this column is being
 * filled in for the first time rather than edited. The guard comes off for the
 * backfill and goes straight back on, and vatable_net joins the frozen list
 * below so it can never be moved afterwards.
 */
alter table public.invoices disable trigger invoices_guard_released;

update public.invoices i
   set vatable_net = coalesce(l.vatable_net, 0)
  from (
    select invoice_id,
           sum(net_amount) filter (where tax_treatment = 'vatable') as vatable_net
      from public.invoice_lines
     group by invoice_id
  ) l
 where l.invoice_id = i.id;

/*
 * An invoice entered as a single figure has no lines to total. Its subtotal is
 * the best statement of what was billed, and it is treated as VATable only
 * when the invoice itself was -- which is what it meant before lines carried
 * their own treatment.
 */
update public.invoices i
   set vatable_net = case when i.is_vatable then i.subtotal else 0 end
 where not exists (
   select 1 from public.invoice_lines l where l.invoice_id = i.id
 );

alter table public.invoices enable trigger invoices_guard_released;

-- ---------------------------------------------------------------------------
-- Frozen once released, like the rest of the money
-- ---------------------------------------------------------------------------

create or replace function public.guard_released_invoice()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if old.status = 'cancelled' then
    raise exception 'This invoice is cancelled and can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  if old.status in ('released', 'partially_paid', 'paid') then
    if new.invoice_no    is distinct from old.invoice_no
    or new.tenant_id     is distinct from old.tenant_id
    or new.contract_id   is distinct from old.contract_id
    or new.location_id   is distinct from old.location_id
    or new.invoice_date  is distinct from old.invoice_date
    or new.due_date      is distinct from old.due_date
    or new.period_start  is distinct from old.period_start
    or new.period_end    is distinct from old.period_end
    or new.is_vatable    is distinct from old.is_vatable
    or new.vat_rate      is distinct from old.vat_rate
    or new.subtotal      is distinct from old.subtotal
    or new.vat_amount    is distinct from old.vat_amount
    or new.vatable_net   is distinct from old.vatable_net
    or new.total         is distinct from old.total then
      raise exception
        'A released invoice cannot be edited. Cancel it with approval, or issue a credit memo.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- The suggestion follows the same base
-- ---------------------------------------------------------------------------

create or replace function public.suggested_tenant_withholding(p_invoice uuid)
returns table (tax_withheld numeric, vat_withheld numeric)
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_invoice  public.invoices%rowtype;
  v_tenant   public.tenants%rowtype;
  v_rate_inc numeric;
  v_rate_vat numeric;
begin
  select * into v_invoice from public.invoices where id = p_invoice;
  if not found then
    return;
  end if;

  select * into v_tenant from public.tenants where id = v_invoice.tenant_id;
  if not found or not v_tenant.withholds_tax then
    return query select 0::numeric, 0::numeric;
    return;
  end if;

  select r.rate into v_rate_inc
    from public.tax_rates r
   where r.company_id = v_invoice.company_id
     and r.kind = 'tenant_withholding'
     and r.code = 'rental'
     and r.is_active;

  select r.rate into v_rate_vat
    from public.tax_rates r
   where r.company_id = v_invoice.company_id
     and r.kind = 'tenant_withholding'
     and r.code = 'government_vat'
     and r.is_active;

  return query select
    -- The VATable lines only. Exempt and no-tax charges are not withheld on.
    round(v_invoice.vatable_net * coalesce(v_rate_inc, 0) / 100, 2),
    case when v_tenant.is_government
         then round(v_invoice.vat_amount * coalesce(v_rate_vat, 0) / 100, 2)
         else 0::numeric
    end;
end;
$fn$;

comment on function public.suggested_tenant_withholding(uuid) is
  'Suggested withholding on an invoice, computed on the VATable lines at the configured rates. Advisory only -- what is recorded is what the tenant actually withheld.';
