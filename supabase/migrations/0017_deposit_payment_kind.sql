-- A security deposit is a liability, not revenue and not an advance against
-- billing. It needs its own payment kind so it can be booked against Security
-- Deposits Payable -- the account the refund side already debits.
--
-- Separate migration so the enum value is committed before it is used.

alter type public.payment_kind add value if not exists 'deposit';
