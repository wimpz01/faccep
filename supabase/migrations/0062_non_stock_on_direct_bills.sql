/**
 * Non-stock items belong on the direct bill, not the purchase order.
 *
 * Services are billed straight by the supplier -- a month of guard duty does
 * not get ordered, received and matched. So the columns added to the purchase
 * order and request lines were the wrong place; they are empty and are
 * removed rather than left to confuse.
 *
 * A direct bill previously charged its whole amount to one account, taken
 * from the bill header. That is fine for a single service, but a bill listing
 * guard duty and hauling has to split. Each line may now name a non-stock
 * item, which brings its account with it, and the accrual debits each account
 * for what its own lines came to.
 *
 * The account still lands on the line itself, so what a bill was charged to
 * cannot change later because somebody edited a setup record.
 */

drop trigger if exists purchase_order_lines_non_stock_account
  on public.purchase_order_lines;
drop trigger if exists purchase_request_lines_non_stock_account
  on public.purchase_request_lines;

alter table public.purchase_order_lines   drop column if exists non_stock_item_id;
alter table public.purchase_request_lines drop column if exists non_stock_item_id;

alter table public.supplier_invoice_lines
  add column if not exists non_stock_item_id uuid
    references public.non_stock_items (id) on delete set null,
  add column if not exists expense_account_id uuid
    references public.chart_of_accounts (id) on delete set null;

comment on column public.supplier_invoice_lines.non_stock_item_id is
  'The service billed. Brings its expense account onto the line.';

create trigger supplier_invoice_lines_non_stock_account
  before insert or update on public.supplier_invoice_lines
  for each row execute function public.apply_non_stock_account();

/**
 * Accrual, with the direct-bill branch now splitting by line.
 *
 * Only that branch changes: a bill against a purchase order still apportions
 * across what was received, and a bill with no lines still falls back to the
 * header account.
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
  v_line_tot  numeric(14, 2);
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
    -- A direct bill: split across whatever its own lines point at.
    select coalesce(round(sum(amount), 2), 0) into v_line_tot
      from public.supplier_invoice_lines where invoice_id = new.id;

    if v_line_tot > 0 then
      select count(*) into v_count from (
        select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account
          from public.supplier_invoice_lines l
         where l.invoice_id = new.id
         group by 1
      ) grouped;

      for r in
        select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account,
               round(sum(l.amount), 2) as value
          from public.supplier_invoice_lines l
         where l.invoice_id = new.id
         group by 1
         order by 2 desc
      loop
        v_index := v_index + 1;
        if v_index = v_count then
          -- Last group absorbs the rounding residual so the entry balances.
          v_share := round(new.amount - v_assigned, 2);
        else
          v_share := round(new.amount * (r.value / v_line_tot), 2);
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
