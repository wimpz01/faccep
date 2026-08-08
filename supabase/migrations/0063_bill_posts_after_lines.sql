/**
 * A direct bill waits for its lines before it reaches the ledger.
 *
 * The accrual fired AFTER INSERT on the header, and the bill is saved header
 * first, lines second. So the entry was written while the bill still had no
 * lines, and the per-line accounts arrived a moment too late to be used --
 * every direct bill landed wholly in the fallback expense account no matter
 * what services it listed.
 *
 * Posting is now asked for by whoever knows the bill is complete:
 *
 *   * A bill against a purchase order posts on insert as before. Its lines
 *     are the order's, and those already exist.
 *   * A direct bill posts when its lines land. An AFTER row trigger runs at
 *     the end of the statement, so a multi-line insert has every line in
 *     place by the time the first one fires.
 *   * A direct bill with no lines at all is posted by the save itself.
 *
 * post_journal() refuses a second posting of the same event, so whichever
 * path gets there first wins and the others are no-ops.
 */

create or replace function public.post_supplier_invoice_row(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv         public.supplier_invoices%rowtype;
  s           public.accounting_settings%rowtype;
  v_lines     jsonb := '[]'::jsonb;
  v_total_rec numeric(14, 2);
  v_assigned  numeric(14, 2) := 0;
  v_share     numeric(14, 2);
  r           record;
  v_count     integer;
  v_index     integer := 0;
  v_line_tot  numeric(14, 2);
begin
  select * into inv from public.supplier_invoices where id = p_invoice;
  if not found then
    return;
  end if;

  select * into s from public.accounting_settings where company_id = inv.company_id;
  if not found or s.ap_account_id is null then
    return;
  end if;

  if inv.po_id is not null then
    select coalesce(round(sum(quantity_received * unit_price), 2), 0)
      into v_total_rec
      from public.purchase_order_lines
     where po_id = inv.po_id;
  else
    v_total_rec := 0;
  end if;

  if inv.po_id is not null and v_total_rec > 0 then
    select count(*) into v_count from (
      select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account
        from public.purchase_order_lines l
       where l.po_id = inv.po_id and l.quantity_received > 0
       group by 1
    ) grouped;

    for r in
      select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account,
             round(sum(l.quantity_received * l.unit_price), 2) as value
        from public.purchase_order_lines l
       where l.po_id = inv.po_id and l.quantity_received > 0
       group by 1
       order by 2 desc
    loop
      v_index := v_index + 1;
      if v_index = v_count then
        v_share := round(inv.amount - v_assigned, 2);
      else
        v_share := round(inv.amount * (r.value / v_total_rec), 2);
        v_assigned := v_assigned + v_share;
      end if;

      if v_share <> 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account', r.account,
          'description', 'Supplier invoice ' || inv.invoice_no,
          'debit', v_share, 'credit', 0));
      end if;
    end loop;
  else
    select coalesce(round(sum(amount), 2), 0) into v_line_tot
      from public.supplier_invoice_lines where invoice_id = inv.id;

    if v_line_tot > 0 then
      select count(*) into v_count from (
        select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account
          from public.supplier_invoice_lines l
         where l.invoice_id = inv.id
         group by 1
      ) grouped;

      for r in
        select public.purchase_line_account(l.item_id, l.expense_account_id, s) as account,
               round(sum(l.amount), 2) as value
          from public.supplier_invoice_lines l
         where l.invoice_id = inv.id
         group by 1
         order by 2 desc
      loop
        v_index := v_index + 1;
        if v_index = v_count then
          -- Last group absorbs the rounding residual so the entry balances.
          v_share := round(inv.amount - v_assigned, 2);
        else
          v_share := round(inv.amount * (r.value / v_line_tot), 2);
          v_assigned := v_assigned + v_share;
        end if;

        if v_share <> 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account', r.account,
            'description', 'Supplier invoice ' || inv.invoice_no,
            'debit', v_share, 'credit', 0));
        end if;
      end loop;
    else
      v_lines := jsonb_build_array(jsonb_build_object(
        'account', coalesce(
          inv.expense_account_id,
          case when inv.job_id is not null then s.maintenance_expense_id
               else s.default_expense_id end),
        'description', 'Supplier invoice ' || inv.invoice_no,
        'debit', inv.amount, 'credit', 0));
    end if;
  end if;

  if inv.vat_amount > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.input_vat_id, 'description', 'Input VAT',
      'debit', inv.vat_amount, 'credit', 0));
  end if;

  if inv.withholding_tax > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.withholding_tax_id, 'description', 'Creditable tax withheld',
      'debit', 0, 'credit', inv.withholding_tax));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', s.ap_account_id, 'description', 'Payable to supplier',
    'debit', 0, 'credit', inv.total));

  perform public.post_journal(
    inv.company_id, inv.invoice_date,
    'Supplier invoice ' || inv.invoice_no,
    'supplier_invoices', inv.id, 'accrue', v_lines);
end;
$$;

/** Only a bill that already knows its accounts posts on insert. */
create or replace function public.post_supplier_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.po_id is not null then
    perform public.post_supplier_invoice_row(new.id);
  end if;
  return null;
end;
$$;

/** A direct bill posts once its lines are in place. */
create or replace function public.post_bill_from_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.post_supplier_invoice_row(new.invoice_id);
  return null;
end;
$$;

create trigger supplier_invoice_lines_post_to_ledger
  after insert on public.supplier_invoice_lines
  for each row execute function public.post_bill_from_lines();

/**
 * For a direct bill that carries no lines, the save asks for the posting
 * itself. Exposed rather than left to a trigger because there is no later
 * event to hang it on.
 */
create or replace function public.post_supplier_invoice_now(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.supplier_invoices i
     where i.id = p_invoice
       and public.has_permission(i.company_id, 'payables.invoices', 'edit')) then
    raise exception 'Not allowed to post this bill.' using errcode = '42501';
  end if;

  perform public.post_supplier_invoice_row(p_invoice);
end;
$$;

grant execute on function public.post_supplier_invoice_now(uuid) to authenticated;
