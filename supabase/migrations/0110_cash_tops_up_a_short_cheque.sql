/**
 * Cash and a cheque handed over together.
 *
 * The usual reason is a cheque written short of what is owed, with the balance
 * made up in cash on the spot. One collection, one receipt, but two things in
 * the drawer, and until now it had to be recorded as two payments with two
 * receipt numbers for money that arrived once.
 *
 * Only ever with a cheque dated today or earlier. A postdated cheque is a
 * promise rather than money -- it belongs in the postdated register, or is
 * taken as a prepayment when it clears -- and mixing a promise with cash on
 * one receipt would put money in the day's takings that nobody has yet. So a
 * split is refused outright when the cheque is dated ahead, which is checked
 * here rather than left to the form.
 *
 * The ledger needs nothing new. A cheque dated today is cash-equivalent and
 * already posts to the cash account, so a split posts exactly as a single
 * payment of the same total always did. What is recorded is the breakdown, so
 * the drawer can be counted against the receipt and the cheque found on the
 * collection report.
 */

alter type public.payment_mode add value if not exists 'cash_check';

comment on type public.payment_mode is
  'How the money arrived. cash_check is cash and a current-dated cheque together, usually cash making up a cheque written short.';
