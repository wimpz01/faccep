/**
 * A line prices itself.
 *
 * 0079 moved the VAT onto the line and made the invoice the sum of its lines.
 * That left every other way of inserting a line -- a credit memo, a fixture, a
 * correction typed straight into the table -- producing a line with a net of
 * nought, and therefore an invoice that totalled nothing. The arithmetic has to
 * live where the row is written, not only in the one code path that happened to
 * be updated.
 *
 * So the rule moves into the database. Give a line its amount, its treatment
 * and, if VATable, its mode, and the net, the VAT and the total are worked out
 * here. A caller that has already done the arithmetic is left alone, so the
 * billing run's own figures are never second-guessed.
 *
 * The tenant still governs: an invoice raised for a tenant who is not
 * VAT-registered carries no output VAT whatever its lines say.
 */

create or replace function public.price_invoice_line()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invoice_vatable boolean;
  v_invoice_rate    numeric(5, 2);
  v_rate            numeric(5, 2);
  v_net             numeric(14, 2);
  v_vat             numeric(14, 2);
begin
  -- Priced already by whoever wrote the row; nothing to work out.
  if new.net_amount <> 0 or new.line_total <> 0 then
    return new;
  end if;

  select i.is_vatable, i.vat_rate
    into v_invoice_vatable, v_invoice_rate
    from public.invoices i where i.id = new.invoice_id;

  v_rate := coalesce(nullif(new.vat_rate, 0), v_invoice_rate, 0);

  if not coalesce(v_invoice_vatable, false)
     or new.tax_treatment <> 'vatable'
     or v_rate <= 0 then
    new.vat_rate   := 0;
    new.net_amount := new.amount;
    new.vat_amount := 0;
    new.line_total := new.amount;
    return new;
  end if;

  if new.vat_mode = 'inclusive' then
    -- The amount is the total. Take the VAT out of it, and derive the VAT by
    -- subtraction so net + vat is exactly the amount however it divided.
    v_net := round(new.amount / (1 + v_rate / 100), 2);
    v_vat := new.amount - v_net;
  else
    -- Exclusive, and the default for a VATable line that names no mode:
    -- the amount is net and the VAT goes on top.
    v_net := new.amount;
    v_vat := round(new.amount * v_rate / 100, 2);
  end if;

  new.vat_rate   := v_rate;
  new.net_amount := v_net;
  new.vat_amount := v_vat;
  new.line_total := v_net + v_vat;
  return new;
end;
$$;

comment on function public.price_invoice_line() is
  'Splits a line into net and VAT on its own terms, unless the caller has done '
  'it already. Inclusive takes the VAT out of the amount; exclusive adds it on.';

drop trigger if exists invoice_lines_price on public.invoice_lines;
create trigger invoice_lines_price
  before insert or update of amount, tax_treatment, vat_mode, vat_rate
  on public.invoice_lines
  for each row execute function public.price_invoice_line();
