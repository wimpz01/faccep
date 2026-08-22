/**
 * The income statement, for one property or for all of them.
 *
 * A function of its own rather than a parameter on trial_balance: giving that
 * one a defaulted fourth argument would make every existing three-argument
 * call ambiguous, and the two questions are not the same anyway. A trial
 * balance has to include the accounts that cannot be placed -- cash, debtors,
 * creditors -- or it does not balance. An income statement can be read one
 * property at a time, because what a building earned and what it cost are
 * genuinely its own.
 *
 * The property is passed as text so one argument can carry three answers:
 *
 *   null or ''      every property, and the unplaced with them
 *   'unallocated'   only postings with no property
 *   a uuid          that property alone
 *
 * Only income and expense accounts are returned. Asking this for an asset
 * would invite a per-property balance sheet, which the ledger cannot honestly
 * produce: one bank account is not divisible by building without inter-
 * property clearing accounts nobody has agreed.
 */

create or replace function public.income_statement(
  p_company  uuid,
  p_from     date default '1900-01-01',
  p_to       date default '2999-12-31',
  p_location text default null
)
returns table (
  account_id   uuid,
  code         text,
  name         text,
  account_type public.account_type,
  balance      numeric
)
language sql
stable
security definer
set search_path = public
as $fn$
  select a.id,
         a.code,
         a.name,
         a.account_type,
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
         and (
           p_location is null
           or p_location = ''
           or (p_location = 'unallocated' and jl.location_id is null)
           or (
             p_location <> 'unallocated'
             and jl.location_id = nullif(p_location, '')::uuid
           )
         )
    ) l on l.account_id = a.id
   where a.company_id = p_company
     and a.account_type in ('income', 'expense')
   group by a.id, a.code, a.name, a.account_type
   order by a.code;
$fn$;

comment on function public.income_statement(uuid, date, date, text) is
  'Income and expense balances for a range, optionally for one property. Pass a location id, the word unallocated, or nothing for every property.';
