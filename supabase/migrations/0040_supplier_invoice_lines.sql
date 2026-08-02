-- A supplier invoice becomes an itemised document.
--
-- Until now a bill was a single net figure, so nothing recorded what was
-- actually bought. Receiving already knows the SKU, quantity and price, and a
-- cheque voucher settles the bill -- but the middle step threw the detail away.
--
-- Philippine practice: a supplier's price is quoted VAT-inclusive, and the
-- invoice shows the VAT-exclusive base and the VAT backed out of it at the
-- bottom. Line amounts here are therefore VAT-inclusive and the split is
-- derived, never typed.

-- ---------------------------------------------------------------------------
-- What kind of purchase this is, which sets the withholding rate
-- ---------------------------------------------------------------------------

alter table public.supplier_invoices
  add column if not exists charge_kind public.withholding_kind not null
    default 'none',
  add column if not exists vat_rate numeric(5, 2) not null default 12;

comment on column public.supplier_invoices.charge_kind is
  'Goods or services. Sets the expanded withholding rate: goods 1%, services 2%.';
comment on column public.supplier_invoices.vat_rate is
  'VAT rate backed out of the VAT-inclusive line amounts.';

-- ---------------------------------------------------------------------------
-- Lines
-- ---------------------------------------------------------------------------

create table public.supplier_invoice_lines (
  id         uuid primary key default gen_random_uuid(),
  invoice_id uuid not null
    references public.supplier_invoices (id) on delete cascade,
  line_no    integer not null,
  -- Null for anything that is not a stock item: labour, freight, utilities.
  item_id    uuid references public.inventory_items (id) on delete set null,
  -- Snapshots. The item may be renamed or retired; the invoice must not change.
  sku         text,
  description text not null,
  unit_of_measure text not null default 'pc',
  quantity   numeric(14, 3) not null check (quantity > 0),
  unit_price numeric(14, 4) not null check (unit_price >= 0),
  amount     numeric(14, 2) not null
    generated always as (round(quantity * unit_price, 2)) stored,
  created_at timestamptz not null default now()
);

create unique index supplier_invoice_lines_no
  on public.supplier_invoice_lines (invoice_id, line_no);
create index supplier_invoice_lines_item_idx
  on public.supplier_invoice_lines (item_id);

alter table public.supplier_invoice_lines enable row level security;

-- Authorises through the parent invoice, like every other child table.
create policy supplier_invoice_lines_read on public.supplier_invoice_lines
  for select to authenticated
  using (exists (select 1 from public.supplier_invoices si
                  where si.id = supplier_invoice_lines.invoice_id
                    and public.is_company_member(si.company_id)));
create policy supplier_invoice_lines_write on public.supplier_invoice_lines
  for all to authenticated
  using (exists (select 1 from public.supplier_invoices si
                  where si.id = supplier_invoice_lines.invoice_id
                    and public.has_permission(si.company_id, 'payables.invoices', 'edit')))
  with check (exists (select 1 from public.supplier_invoices si
                  where si.id = supplier_invoice_lines.invoice_id
                    and public.has_permission(si.company_id, 'payables.invoices', 'edit')));

comment on table public.supplier_invoice_lines is
  'What the supplier billed for. Amounts are VAT-inclusive; the split is derived.';

-- ---------------------------------------------------------------------------
-- The header follows the lines, so the two can never disagree
-- ---------------------------------------------------------------------------

/**
 * Recomputes an invoice's money from its lines.
 *
 * VAT only arises on a VAT-registered supplier, and expanded withholding only
 * alongside it, so both are read from the vendor rather than trusted from the
 * form.
 */
create or replace function public.sync_supplier_invoice_totals(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gross    numeric(14, 2);
  v_net      numeric(14, 2);
  v_vat      numeric(14, 2);
  v_ewt      numeric(14, 2);
  v_invoice  record;
  v_vatable  boolean;
begin
  select si.*, v.is_vatable
    into v_invoice
    from public.supplier_invoices si
    join public.vendors v on v.id = si.vendor_id
   where si.id = p_invoice;

  if not found then
    return;
  end if;

  select coalesce(round(sum(amount), 2), 0)
    into v_gross
    from public.supplier_invoice_lines
   where invoice_id = p_invoice;

  -- No lines means the bill was entered as a single figure; leave it alone.
  if v_gross = 0 then
    return;
  end if;

  v_vatable := v_invoice.is_vatable;

  if v_vatable and v_invoice.vat_rate > 0 then
    v_net := round(v_gross / (1 + v_invoice.vat_rate / 100), 2);
    v_vat := round(v_gross - v_net, 2);
  else
    v_net := v_gross;
    v_vat := 0;
  end if;

  -- Expanded withholding is computed on the VAT-exclusive base.
  if v_vatable then
    v_ewt := round(v_net * public.withholding_rate(v_invoice.charge_kind) / 100, 2);
  else
    v_ewt := 0;
  end if;

  update public.supplier_invoices
     set amount          = v_net,
         vat_amount      = v_vat,
         withholding_tax = v_ewt,
         total           = round(v_net + v_vat - v_ewt, 2)
   where id = p_invoice;
end;
$$;

create or replace function public.apply_supplier_invoice_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_supplier_invoice_totals(
    case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end);
  return null;
end;
$$;

create trigger supplier_invoice_lines_apply
  after insert or update or delete on public.supplier_invoice_lines
  for each row execute function public.apply_supplier_invoice_line();

-- ---------------------------------------------------------------------------
-- Three-way match, corrected to compare like with like
-- ---------------------------------------------------------------------------
--
-- A purchase order's value is what the supplier quoted, which is VAT-inclusive.
-- The match previously compared it against the bill's VAT-exclusive net, so an
-- itemised bill settling a receipt in full still looked partly unbilled by
-- exactly the VAT.

create or replace function public.po_billed_value(p_po uuid, p_exclude uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(sum(amount + vat_amount), 2), 0)
    from public.supplier_invoices
   where po_id = p_po
     and status <> 'cancelled'
     and (p_exclude is null or id <> p_exclude);
$$;

create or replace function public.guard_bill_against_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_received numeric(14, 2);
  v_billed   numeric(14, 2);
  v_gross    numeric(14, 2);
begin
  if new.po_id is null then
    return new;
  end if;

  v_received := public.po_received_value(new.po_id);
  v_billed   := public.po_billed_value(new.po_id, new.id);
  v_gross    := round(new.amount + new.vat_amount, 2);

  if v_received = 0 then
    raise exception
      'Nothing has been received on this order yet, so it cannot be billed.'
      using errcode = 'check_violation';
  end if;

  if round(v_billed + v_gross, 2) > v_received then
    raise exception
      'Billing %.2f would exceed what has been received. Received %.2f, already billed %.2f, so %.2f is still billable.',
      v_gross, v_received, v_billed, v_received - v_billed
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists supplier_invoices_match_receipt on public.supplier_invoices;
create trigger supplier_invoices_match_receipt
  before insert or update of amount, vat_amount, po_id
  on public.supplier_invoices
  for each row execute function public.guard_bill_against_receipt();
