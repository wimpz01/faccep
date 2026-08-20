/**
 * A line's amount is its quantity times its price, always.
 *
 * amount was written once, by whoever inserted the line, and never again. The
 * order total is summed from it by a trigger, so repricing a line moved the
 * price and left both the amount and the total behind -- an order could read
 * 10 x 85.50 and still total nought.
 *
 * That mattered beyond looking wrong. The billing guard measures the value
 * received, so a nought-valued order refuses its own supplier invoice with
 * "nothing has been received on this order yet", which is not what happened
 * and not what it means.
 *
 * Derived here rather than in the application because two writers already set
 * it -- creating an order and repricing one -- and a third would be a third
 * chance to disagree.
 */

create or replace function public.price_purchase_order_line()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.amount := round(coalesce(new.quantity, 0) * coalesce(new.unit_price, 0), 2);
  return new;
end;
$$;

drop trigger if exists purchase_order_lines_price on public.purchase_order_lines;
create trigger purchase_order_lines_price
  before insert or update on public.purchase_order_lines
  for each row execute function public.price_purchase_order_line();

comment on function public.price_purchase_order_line is
  'Keeps purchase_order_lines.amount equal to quantity * unit_price, so a '
  'repriced line cannot leave a stale amount behind it.';

/*
 * Put right anything already out of step. Nothing on file is expected to be,
 * but a line that was repriced before this trigger existed would be.
 */
update public.purchase_order_lines
   set amount = round(coalesce(quantity, 0) * coalesce(unit_price, 0), 2)
 where amount is distinct from
       round(coalesce(quantity, 0) * coalesce(unit_price, 0), 2);
