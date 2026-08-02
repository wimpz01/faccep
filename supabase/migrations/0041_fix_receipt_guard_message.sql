-- The three-way match message printed "200.00.2f".
--
-- PL/pgSQL's raise only understands a bare %; there is no printf precision, so
-- ".2f" was being emitted literally after the substituted value. Numerics are
-- formatted explicitly instead.

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
  v_money    text := 'FM999,999,999,990.00';
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
      'Billing % would exceed what has been received. Received %, already billed %, so % is still billable.',
      to_char(v_gross, v_money),
      to_char(v_received, v_money),
      to_char(v_billed, v_money),
      to_char(v_received - v_billed, v_money)
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
