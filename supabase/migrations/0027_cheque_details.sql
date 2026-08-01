-- Cheque particulars on a payment.
--
-- A cheque received and banked straight away is an ordinary payment, but it
-- still has a bank and a date written on its face that reconciliation needs.
-- A cheque dated in the future is not money yet: it is recorded against the
-- tenant as a postdated cheque instead, and only becomes a payment once it has
-- been deposited and cleared.

alter table public.payments
  add column if not exists check_bank text,
  add column if not exists check_date date;

comment on column public.payments.check_bank is
  'Drawee bank, when the payment mode is a cheque.';
comment on column public.payments.check_date is
  'The date written on the cheque. A future date belongs in postdated_checks.';
