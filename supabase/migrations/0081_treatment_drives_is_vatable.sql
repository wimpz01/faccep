/**
 * The treatment decides; is_vatable follows.
 *
 * invoice_lines.is_vatable predates the per-line treatment and now says the
 * same thing less precisely. Leaving both as inputs lets a row claim to be
 * VATable and not VATable at once, and the two answers were already
 * disagreeing: a line inserted as is_vatable = false but left at the default
 * treatment of 'vatable' was picking up VAT it should never have had.
 *
 * So tax_treatment is the one input, and is_vatable becomes a derived
 * convenience -- true exactly when the line actually bore VAT. Everything that
 * reads is_vatable keeps working and now agrees with the figures beside it.
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
  -- Priced already by whoever wrote the row; only keep the flag honest.
  if new.net_amount <> 0 or new.line_total <> 0 then
    new.is_vatable := new.vat_amount <> 0;
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
    new.is_vatable := false;
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
  new.is_vatable := v_vat <> 0;
  return new;
end;
$$;

comment on column public.invoice_lines.is_vatable is
  'Derived: true when this line actually bore VAT. tax_treatment is the input.';
