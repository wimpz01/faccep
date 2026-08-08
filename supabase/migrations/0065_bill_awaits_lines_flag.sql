/**
 * Posting stays automatic; only a bill that says it is still expecting lines
 * waits for them.
 *
 * 0063 stopped the header trigger from posting direct bills, so that the
 * per-line accounts would be in place first -- and quietly broke every other
 * way a bill is created. A bill inserted with no lines and no order simply
 * never reached the ledger, which the verification suite caught: payables not
 * credited, input VAT not debited, withholding not credited.
 *
 * The fault was making posting depend on the caller remembering to ask. It is
 * a trigger again, and a bill that is about to receive lines says so when it
 * is inserted. Anything that does not set the flag -- a reversal, a bill from
 * an order, a script -- posts on insert exactly as it always did.
 */

alter table public.supplier_invoices
  add column if not exists awaiting_lines boolean not null default false;

comment on column public.supplier_invoices.awaiting_lines is
  'Set while a bill is being saved with item lines, so the ledger entry waits '
  'until their accounts are known. Cleared once the lines land.';

create or replace function public.post_supplier_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A bill still expecting lines posts when they arrive, not now.
  if not new.awaiting_lines then
    perform public.post_supplier_invoice_row(new.id);
  end if;
  return null;
end;
$$;

/**
 * The lines have landed: post, and stop the bill waiting.
 *
 * AFTER row triggers run at the end of the statement, so every line of a
 * multi-line insert is present by the time the first one fires.
 */
create or replace function public.post_bill_from_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.supplier_invoices
     set awaiting_lines = false
   where id = new.invoice_id and awaiting_lines;

  perform public.post_supplier_invoice_row(new.invoice_id);
  return null;
end;
$$;
