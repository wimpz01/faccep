/**
 * Tax a tenant withholds from the rent they pay us.
 *
 * The system already knew about withholding in one direction only: what we
 * withhold from a supplier when we pay their bill. The other direction was
 * missing entirely, and for a leasing business it is the one that bites.
 *
 * A tenant who is a withholding agent does not pay the invoice in full. On a
 * VAT-inclusive rent of 10,000 they withhold 5% of the amount net of VAT
 * (10,000 / 1.12 = 8,928.57, so 446.43) and remit that to the BIR on our
 * behalf, paying us 9,553.57. The invoice is settled in full. Nothing is
 * outstanding. Until now the system had nowhere to put the 446.43, so the
 * invoice sat forever showing an unpaid balance that would never be collected
 * and the creditable tax -- real money, deductible against our income tax --
 * was tracked by hand outside the system.
 *
 * So an application of a receipt to an invoice now carries what was withheld
 * alongside what was received:
 *
 *   DR Customer Advances          9,553.57   cash actually received
 *   DR Creditable Withholding Tax   446.43   withheld, supported by a 2307
 *     CR Accounts Receivable     10,000.00   invoice settled in full
 *
 * Two fields rather than one, because a government tenant withholds two
 * separate taxes on the same invoice and reports them on different forms:
 * income tax (form 2307) and VAT (form 2306). Recording them as a single
 * figure would lose the split we need at filing time.
 *
 * Nothing here computes a rate by itself. The amount withheld is whatever the
 * tenant actually withheld, which is what the remittance shows and what their
 * 2307 will say; the configured rates only suggest a figure in the form. A
 * tenant who rounds differently, or withholds on a different base, is recorded
 * as they paid -- not as the system thinks they should have paid.
 */

-- ---------------------------------------------------------------------------
-- Which tenants withhold
-- ---------------------------------------------------------------------------

/*
 * Not a rate, a habit. Some tenants withhold, some do not, and the difference
 * is a fact about the tenant rather than about the lease. It only decides
 * whether the form offers a figure by default; the field is always available,
 * because a tenant can become a withholding agent without telling us first.
 */
alter table public.tenants
  add column if not exists withholds_tax boolean not null default false,
  add column if not exists is_government boolean not null default false;

comment on column public.tenants.withholds_tax is
  'This tenant withholds creditable tax from the rent they pay. Suggests a figure when a payment is applied; never enforces one.';
comment on column public.tenants.is_government is
  'A government tenant, who additionally withholds VAT on top of the income tax.';

-- A government tenant is always a withholding agent.
update public.tenants set withholds_tax = true where is_government;

alter table public.tenants
  add constraint tenants_government_withholds
    check (not is_government or withholds_tax);

-- ---------------------------------------------------------------------------
-- What was withheld, on the application that settles the invoice
-- ---------------------------------------------------------------------------

/*
 * The withheld tax belongs on the application rather than on the payment.
 * One receipt can settle several invoices, each with its own withholding and
 * its own 2307, and the tax follows the income it was withheld from.
 */
alter table public.payment_applications
  add column if not exists tax_withheld numeric(14, 2) not null default 0
    check (tax_withheld >= 0),
  add column if not exists vat_withheld numeric(14, 2) not null default 0
    check (vat_withheld >= 0),
  add column if not exists form_2307_no text,
  add column if not exists form_2307_date date;

comment on column public.payment_applications.tax_withheld is
  'Creditable income tax the tenant withheld from this invoice, normally 5% of the amount net of VAT.';
comment on column public.payment_applications.vat_withheld is
  'VAT withheld by a government tenant. Creditable, not final, since 1 January 2021.';
comment on column public.payment_applications.form_2307_no is
  'Reference of the BIR form 2307 the tenant issued, once it is in hand.';

-- An application that withheld nothing must not claim a form.
alter table public.payment_applications
  add constraint payment_applications_form_needs_tax
    check (
      (form_2307_no is null and form_2307_date is null)
      or tax_withheld > 0 or vat_withheld > 0
    );

-- ---------------------------------------------------------------------------
-- Settlement counts the withheld tax
-- ---------------------------------------------------------------------------

/**
 * An invoice is settled by what was received plus what was withheld.
 *
 * This is the whole point: the tenant discharged the full invoice, partly in
 * cash and partly by paying our tax for us. Counting only the cash would keep
 * the invoice permanently short and put it in the overdue tile forever.
 */
create or replace function public.recalculate_invoice_settlement(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_paid     numeric(14, 2);
  v_credited numeric(14, 2);
  v_total    numeric(14, 2);
  v_status   public.invoice_status;
begin
  select i.total, i.status into v_total, v_status
    from public.invoices i where i.id = p_invoice_id;

  if v_status is null or v_status = 'cancelled' then
    return;
  end if;

  select coalesce(sum(pa.amount + pa.tax_withheld + pa.vat_withheld), 0) into v_paid
    from public.payment_applications pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = p_invoice_id
     and p.status = 'posted';

  select coalesce(sum(cm.amount), 0) into v_credited
    from public.credit_memos cm
   where cm.invoice_id = p_invoice_id;

  update public.invoices
     set amount_paid     = v_paid,
         credited_amount = v_credited,
         status = case
                    when status = 'draft' then 'draft'::public.invoice_status
                    when v_paid + v_credited >= v_total
                      then 'paid'::public.invoice_status
                    when v_paid + v_credited > 0
                      then 'partially_paid'::public.invoice_status
                    else 'released'::public.invoice_status
                  end
   where id = p_invoice_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- An application may not settle more than the invoice is worth
-- ---------------------------------------------------------------------------

/**
 * Cash plus withheld tax cannot exceed what is left on the invoice.
 *
 * Without this, a mistyped withholding would overpay the invoice and leave a
 * credit balance sitting in receivables where nobody would look for it.
 */
create or replace function public.guard_application_within_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invoice public.invoices%rowtype;
  v_settled numeric(14, 2);
  v_this    numeric(14, 2);
begin
  select * into v_invoice from public.invoices where id = new.invoice_id;
  if not found then
    return new;
  end if;

  select coalesce(sum(pa.amount + pa.tax_withheld + pa.vat_withheld), 0)
    into v_settled
    from public.payment_applications pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = new.invoice_id
     and p.status = 'posted'
     and pa.id <> new.id;

  v_this := new.amount + new.tax_withheld + new.vat_withheld;

  -- A credit memo has already discharged part of the invoice, so it is not
  -- available to be settled again.
  if v_settled + v_this > v_invoice.total - coalesce(v_invoice.credited_amount, 0) + 0.005 then
    raise exception
      'That settles % against invoice %, which is more than the % still owed on it.',
      to_char(v_this, 'FM999,999,990.00'),
      v_invoice.invoice_no,
      to_char(
        greatest(v_invoice.total - coalesce(v_invoice.credited_amount, 0) - v_settled, 0),
        'FM999,999,990.00');
  end if;

  return new;
end;
$fn$;

create trigger payment_applications_within_invoice
  before insert or update on public.payment_applications
  for each row execute function public.guard_application_within_invoice();

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------

/**
 * Applying a receipt to an invoice moves it off the advance account, and
 * takes the withheld tax to the asset account it is creditable from:
 *
 *   DR Customer Advances           cash applied
 *   DR Creditable Withholding Tax  income tax + VAT withheld
 *     CR Accounts Receivable       the invoice, settled in full
 *
 * The withholding lines are only added when there is something to add, so an
 * ordinary application posts exactly the two lines it always did.
 */
create or replace function public.post_payment_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s          public.accounting_settings%rowtype;
  v_payment  public.payments%rowtype;
  v_invoice  public.invoices%rowtype;
  v_withheld numeric(14, 2);
  v_lines    jsonb;
begin
  select * into v_payment from public.payments where id = coalesce(new.payment_id, old.payment_id);
  select * into s from public.accounting_settings where company_id = v_payment.company_id;
  if not found or s.ar_account_id is null then
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.reverse_posting(
      v_payment.company_id, 'payment_applications', old.id, 'apply', 'application removed');
    return null;
  end if;

  select * into v_invoice from public.invoices where id = new.invoice_id;

  v_withheld := coalesce(new.tax_withheld, 0) + coalesce(new.vat_withheld, 0);

  /*
   * Withheld tax with nowhere to put it would post a one-sided journal, so
   * the settings must name the account first. Refusing here is the safe
   * failure: the collection is not recorded at all, rather than recorded with
   * a silently missing debit.
   */
  if v_withheld > 0 and s.creditable_wht_id is null then
    raise exception
      'No Creditable Withholding Tax account is set, so tax withheld by a tenant cannot be posted. Set it in Tax settings.';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account', s.customer_advances_id,
                       'description', 'Applied to ' || v_invoice.invoice_no,
                       'debit', new.amount, 'credit', 0),
    jsonb_build_object('account', s.ar_account_id,
                       'description', 'Settlement of ' || v_invoice.invoice_no,
                       'debit', 0, 'credit', new.amount + v_withheld));

  if v_withheld > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', s.creditable_wht_id,
                         'description', 'Tax withheld on ' || v_invoice.invoice_no,
                         'debit', v_withheld, 'credit', 0));
  end if;

  perform public.post_journal(
    v_payment.company_id, v_payment.payment_date,
    'Applied ' || v_payment.payment_no || ' to ' || v_invoice.invoice_no,
    'payment_applications', new.id, 'apply', v_lines);

  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- The suggested figure
-- ---------------------------------------------------------------------------

/**
 * What a tenant would normally withhold on a given invoice, as a suggestion.
 *
 * Returns the income tax and the VAT separately. Both are computed on the
 * VAT-exclusive base, which is what RR 2-98 requires and what the tenant's
 * own computation will use.
 *
 * A suggestion only. The form offers it, the user overrides it, and what is
 * stored is what the tenant actually withheld.
 */
create or replace function public.suggested_tenant_withholding(p_invoice uuid)
returns table (tax_withheld numeric, vat_withheld numeric)
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_invoice  public.invoices%rowtype;
  v_tenant   public.tenants%rowtype;
  v_net      numeric(14, 2);
  v_vat      numeric(14, 2);
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

  -- The invoice already carries its own split, stamped when it was raised.
  v_net := v_invoice.subtotal;
  v_vat := v_invoice.vat_amount;

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
    round(v_net * coalesce(v_rate_inc, 0) / 100, 2),
    case when v_tenant.is_government
         then round(v_vat * coalesce(v_rate_vat, 0) / 100, 2)
         else 0::numeric
    end;
end;
$fn$;

comment on function public.suggested_tenant_withholding(uuid) is
  'Suggested withholding on an invoice at the configured rates. Advisory only -- what is recorded is what the tenant actually withheld.';
