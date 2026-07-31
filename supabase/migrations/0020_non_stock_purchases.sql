-- Non-stock purchasing: services, utilities, professional fees and the like.
--
-- A purchase line without an inventory item never touches stock -- receiving
-- already skips it -- but the bill was still debiting Inventory for the whole
-- amount whenever it was raised against a purchase order. A month of security
-- services would have been capitalised as stock on the balance sheet.
--
-- Each non-stock line now carries the expense account it belongs to, and a
-- bill apportions its debit across Inventory and those expense accounts in
-- proportion to what was actually received.

alter table public.purchase_order_lines
  add column if not exists expense_account_id uuid
    references public.chart_of_accounts (id) on delete set null;

alter table public.purchase_request_lines
  add column if not exists expense_account_id uuid
    references public.chart_of_accounts (id) on delete set null;

-- Lets a standalone bill (no purchase order) be directed at the right account.
alter table public.supplier_invoices
  add column if not exists expense_account_id uuid
    references public.chart_of_accounts (id) on delete set null;

comment on column public.purchase_order_lines.expense_account_id is
  'Where a non-stock line is charged. Ignored when item_id is set, since stock goes to Inventory.';

/**
 * Where the debit for a purchase line belongs:
 * stock lines to Inventory, everything else to its own expense account, with
 * the company default as the fallback.
 */
create or replace function public.purchase_line_account(
  p_item_id    uuid,
  p_expense_id uuid,
  p_settings   public.accounting_settings
)
returns uuid
language sql
immutable
as $$
  select case
           when p_item_id is not null then p_settings.inventory_account_id
           else coalesce(p_expense_id, p_settings.default_expense_id)
         end;
$$;

/**
 * Supplier invoice posting.
 *
 *   DR Inventory and/or expense accounts   net amount, apportioned
 *   DR Input VAT
 *     CR Withholding Tax Payable
 *     CR Accounts Payable
 *
 * When the bill sits against a purchase order, the net amount is split across
 * the accounts its received lines point at, pro-rata by received value. The
 * rounding residual lands on the largest share so the entry balances exactly.
 */
create or replace function public.post_supplier_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_lines     jsonb := '[]'::jsonb;
  v_total_rec numeric(14, 2);
  v_assigned  numeric(14, 2) := 0;
  v_share     numeric(14, 2);
  r           record;
  v_count     integer;
  v_index     integer := 0;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ap_account_id is null then
    return null;
  end if;

  if new.po_id is not null then
    select coalesce(round(sum(quantity_received * unit_price), 2), 0)
      into v_total_rec
      from public.purchase_order_lines
     where po_id = new.po_id;
  else
    v_total_rec := 0;
  end if;

  if new.po_id is not null and v_total_rec > 0 then
    select count(*) into v_count from (
      select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account
        from public.purchase_order_lines l
       where l.po_id = new.po_id and l.quantity_received > 0
       group by 1
    ) grouped;

    for r in
      select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account,
             round(sum(l.quantity_received * l.unit_price), 2) as value
        from public.purchase_order_lines l
       where l.po_id = new.po_id and l.quantity_received > 0
       group by 1
       order by 2 desc
    loop
      v_index := v_index + 1;
      if v_index = v_count then
        -- Last group absorbs the rounding residual.
        v_share := round(new.amount - v_assigned, 2);
      else
        v_share := round(new.amount * (r.value / v_total_rec), 2);
        v_assigned := v_assigned + v_share;
      end if;

      if v_share <> 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account', r.account,
          'description', 'Supplier invoice ' || new.invoice_no,
          'debit', v_share, 'credit', 0));
      end if;
    end loop;
  else
    v_lines := jsonb_build_array(jsonb_build_object(
      'account', coalesce(
        new.expense_account_id,
        case when new.job_id is not null then s.maintenance_expense_id
             else s.default_expense_id end),
      'description', 'Supplier invoice ' || new.invoice_no,
      'debit', new.amount, 'credit', 0));
  end if;

  if new.vat_amount > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.input_vat_id, 'description', 'Input VAT',
      'debit', new.vat_amount, 'credit', 0));
  end if;

  if new.withholding_tax > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.withholding_tax_id, 'description', 'Creditable tax withheld',
      'debit', 0, 'credit', new.withholding_tax));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', s.ap_account_id, 'description', 'Payable to supplier',
    'debit', 0, 'credit', new.total));

  perform public.post_journal(
    new.company_id, new.invoice_date,
    'Supplier invoice ' || new.invoice_no,
    'supplier_invoices', new.id, 'accrue', v_lines);

  return null;
end;
$$;
