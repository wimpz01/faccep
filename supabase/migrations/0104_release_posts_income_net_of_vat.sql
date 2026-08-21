/**
 * Releasing an invoice credited income with the VAT still in it.
 *
 * post_invoice_release totalled each line kind with sum(amount) -- the figure
 * as typed -- and then credited Output VAT separately. On a VAT-exclusive line
 * the typed amount is already net, so the two agree and the entry balances,
 * which is why this has stood since 0011 without anyone noticing.
 *
 * On a VAT-inclusive line the typed amount is the gross. Crediting it and then
 * crediting the VAT again counts the VAT twice, the journal does not balance,
 * and the release is refused outright:
 *
 *   rent 10,000 inclusive -> net 8,928.57 + VAT 1,071.43
 *   DR Accounts Receivable                  12,000.00
 *     CR Rental Income                      12,000.00   <- gross, wrong
 *     CR Output VAT                          1,071.43
 *
 * So an invoice quoted VAT-inclusive could not be released at all. That is the
 * ordinary way rent is agreed, and supporting it was the point of 0079, but
 * the posting was never moved along with it.
 *
 * The fix is to credit net_amount, which each line already carries: VAT taken
 * out of an inclusive amount, added to an exclusive one, and nought on an
 * exempt one.
 *
 *   DR Accounts Receivable                  12,000.00
 *     CR Rental Income                       8,928.57
 *     CR Other Income                        2,000.00
 *     CR Output VAT                          1,071.43
 *
 * Nothing already posted moves. The trigger fires only on draft -> released,
 * no invoice raised so far has an inclusive line, and where every line is
 * exclusive net_amount and amount are the same number.
 */

create or replace function public.post_invoice_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
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
    -- net_amount, not amount: the VAT is credited on its own line below, and
    -- an inclusive amount still contains it.
    select line_kind::text as line_kind, sum(net_amount) as amount
      from public.invoice_lines
     where invoice_id = new.id
     group by line_kind
    -- A kind whose net comes to nothing has no side to post, and a zero line
    -- is refused by the journal in any case.
    having sum(net_amount) <> 0
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', case r.line_kind
                   when 'rent'          then s.rent_income_id
                   when 'parking'       then coalesce(s.parking_income_id, s.other_income_id)
                   when 'water'         then s.utility_income_id
                   when 'electricity'   then s.utility_income_id
                   when 'genset'        then s.utility_income_id
                   when 'water_expense' then s.utility_income_id
                   when 'penalty'       then coalesce(s.penalty_income_id, s.other_income_id)
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
$fn$;

comment on function public.post_invoice_release() is
  'Posts an invoice on release, crediting each income account net of VAT so an inclusive price is not counted twice.';
