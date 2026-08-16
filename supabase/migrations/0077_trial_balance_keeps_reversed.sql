/**
 * A reversed entry still belongs in the ledger.
 *
 * 0076 restricted the trial balance to entries whose status is exactly
 * 'posted'. That is too strict. Reversing an entry does not remove it: the
 * original is marked 'reversed' and stays where it is, and a second entry is
 * posted that cancels it out. Both sides have to be counted, or the books are
 * short by the amount of the original.
 *
 * Voiding a receipt showed it plainly. The receipt debits cash 27,400 on the
 * day it was taken; voiding marks that entry 'reversed' and posts a credit of
 * 27,400 today. Counting only the credit left cash 27,400 below where it had
 * started, when the right answer is that the two cancel and nothing moved.
 *
 * The statuses that never reached the ledger are 'draft' and 'cancelled', and
 * those remain excluded -- which is what the financial statements have always
 * claimed to do and, before 0076, did not.
 */

create or replace function public.trial_balance(
  p_company uuid,
  p_from date default '1900-01-01',
  p_to date default '2999-12-31'
)
returns table (
  account_id uuid,
  code text,
  name text,
  account_type public.account_type,
  debit_total numeric,
  credit_total numeric,
  balance numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id,
         a.code,
         a.name,
         a.account_type,
         coalesce(sum(l.debit), 0)  as debit_total,
         coalesce(sum(l.credit), 0) as credit_total,
         case when public.is_debit_normal(a.account_type)
              then coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0)
              else coalesce(sum(l.credit), 0) - coalesce(sum(l.debit), 0)
         end as balance
    from public.chart_of_accounts a
    left join (
      select jl.account_id, jl.debit, jl.credit
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.entry_id
       where je.status in ('posted', 'reversed')
         and je.entry_date between p_from and p_to
    ) l on l.account_id = a.id
   where a.company_id = p_company
   group by a.id, a.code, a.name, a.account_type
   order by a.code;
$$;

comment on function public.trial_balance(uuid, date, date) is
  'Account balances from journal entries that reached the ledger -- posted, or '
  'posted and since reversed -- dated within the range. Drafts and cancelled '
  'entries are excluded. Accounts with no movement are returned at zero.';
