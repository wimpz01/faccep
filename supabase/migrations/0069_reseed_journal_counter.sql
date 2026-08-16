/**
 * The journal counter catches up with the entries that already exist.
 *
 * 0011 numbered journal entries by looking at the highest one already issued.
 * 0024 moved every document onto a shared counter -- but nothing carried the
 * journal's existing position across, so the counter restarted from nothing
 * while entries were already up in the twenties. It then handed out numbers
 * that were taken, and releasing a voucher died on
 * journal_entries_no_unique. Nothing was wrong with the voucher; the ledger
 * simply could not name the entry.
 *
 * Every other document type was counter-numbered from the start and is in
 * step. This still walks all of them, because a counter behind its own table
 * is the bug, not journal entries specifically.
 */

do $$
declare
  r record;
begin
  for r in
    select je.company_id,
           extract(year from je.entry_date)::integer            as year,
           max((regexp_replace(je.entry_no, '^.*-', ''))::int)  as highest
      from public.journal_entries je
     where je.entry_no ~ '-[0-9]+$'
     group by 1, 2
  loop
    insert into public.document_counters (company_id, doc_type, year, last_value)
    values (r.company_id, 'journal_entry', r.year, r.highest)
    on conflict (company_id, doc_type, year) do update
      -- Only ever forwards: a counter ahead of the entries is fine, one
      -- behind them hands out a number twice.
      set last_value = greatest(document_counters.last_value, excluded.last_value);
  end loop;
end $$;
