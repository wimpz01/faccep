-- post_invoice_release passed an invoice_line_kind enum straight to replace(),
-- which only takes text. Postgres will not infer that cast, so releasing any
-- invoice failed.

create or replace function public.post_invoice_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.accounting_settings%rowtype;
  v_lines jsonb := '[]'::jsonb;
  r record;
begin
  select * into s from public.accounting_settings where company_id = new.company_id;
  if not found or s.ar_account_id is null then
    return null;  -- accounting not in use for this company
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.reverse_posting(
      new.company_id, 'invoices', new.id, 'release',
      coalesce(new.cancellation_reason, 'cancelled'));
    return null;
  end if;

  if not (old.status = 'draft' and new.status = 'released') then
    return null;
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account', s.ar_account_id,
    'description', 'Invoice ' || new.invoice_no,
    'debit', new.total, 'credit', 0));

  for r in
    select line_kind::text as line_kind, sum(amount) as amount
      from public.invoice_lines
     where invoice_id = new.id
     group by line_kind
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', case r.line_kind
                   when 'rent'        then s.rent_income_id
                   when 'parking'     then coalesce(s.parking_income_id, s.other_income_id)
                   when 'water'       then s.utility_income_id
                   when 'electricity' then s.utility_income_id
                   when 'genset'      then s.utility_income_id
                   when 'penalty'     then coalesce(s.penalty_income_id, s.other_income_id)
                   else s.other_income_id
                 end,
      'description', initcap(replace(r.line_kind, '_', ' ')),
      'debit', 0, 'credit', r.amount));
  end loop;

  if new.vat_amount > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', s.vat_payable_id,
      'description', 'Output VAT',
      'debit', 0, 'credit', new.vat_amount));
  end if;

  perform public.post_journal(
    new.company_id, new.invoice_date,
    'Invoice ' || new.invoice_no || ' released',
    'invoices', new.id, 'release', v_lines);

  return null;
end;
$$;
