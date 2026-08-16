/**
 * The trial balance was ignoring both its date range and the entry status.
 *
 * The conditions were written onto the journal_entries join:
 *
 *     left join public.journal_lines l on l.account_id = a.id
 *     left join public.journal_entries e
 *            on e.id = l.entry_id
 *           and e.status = 'posted'
 *           and e.entry_date between p_from and p_to
 *
 * but the figures are summed from l, and l was already joined unconditionally.
 * When e failed to match -- wrong period, or a draft -- the line still carried
 * its debit and credit into the total. The join narrowed nothing.
 *
 * The effect was that every financial statement showed the same figures no
 * matter what dates were asked for, and drafts were counted as though posted.
 * A quarter-by-quarter comparison made it obvious: all four quarters of 2026
 * came back identical, including quarters in which nothing had been billed.
 *
 * Restricting the lines before they are joined fixes both. Accounts still come
 * from a left join, so an account with no movement in the period is reported
 * at zero rather than vanishing from the statement.
 *
 * (0077 widens the status test straight after this: a reversed entry still
 * belongs in the ledger, and this migration was too strict about it.)
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
       where je.status = 'posted'
         and je.entry_date between p_from and p_to
    ) l on l.account_id = a.id
   where a.company_id = p_company
   group by a.id, a.code, a.name, a.account_type
   order by a.code;
$$;

comment on function public.trial_balance(uuid, date, date) is
  'Account balances from posted journal entries dated within the range. '
  'Accounts with no movement are returned at zero.';
