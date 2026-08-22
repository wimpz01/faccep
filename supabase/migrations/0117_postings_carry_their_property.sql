/**
 * A posting records which property it belongs to.
 *
 * The financial statements are built from the ledger, and the ledger had no
 * property on it -- so "what did this building earn" could not be asked at
 * all. The documents mostly know: an invoice is billed to a property, a
 * supplier's bill is charged to one. The ledger simply never kept it.
 *
 * Resolved once, here, rather than at each of the dozen posting functions.
 * post_journal is already told which document it is posting for, so it can
 * look the property up itself; every posting that exists today and every one
 * added later is tagged without its author having to remember.
 *
 * Left null where the document genuinely has no property, which is most of the
 * balance sheet. A receipt is money from a tenant, not from a building; cash
 * sits in one bank account. Those postings are honestly unallocated rather
 * than guessed at, and the income statement shows them as such.
 */

alter table public.journal_lines
  add column if not exists location_id uuid
    references public.locations (id) on delete set null;

comment on column public.journal_lines.location_id is
  'The property this posting belongs to, taken from the document it came from. Null where the document has none -- most of the balance sheet.';

create index if not exists journal_lines_location_idx
  on public.journal_lines (location_id);

/**
 * Which property a document's postings belong to.
 *
 * Only the documents that genuinely have one. A payment, a voucher or an
 * inventory movement is not a property's, and inventing an answer for them
 * would put figures in a building's income statement that were never earned
 * there.
 */
create or replace function public.posting_location(
  p_source_table text,
  p_source_id uuid
)
returns uuid
language sql
stable
set search_path = public
as $fn$
  select case p_source_table
    when 'invoices' then
      (select i.location_id from public.invoices i where i.id = p_source_id)
    when 'supplier_invoices' then
      (select si.location_id from public.supplier_invoices si where si.id = p_source_id)
    when 'maintenance_jobs' then
      (select j.location_id from public.maintenance_jobs j where j.id = p_source_id)
    /*
     * A settlement charges repairs back against the deposit, which is a cost
     * of the unit it was let with, so it follows the contract's property.
     */
    when 'deposit_settlements' then
      (select u.location_id
         from public.deposit_settlements d
         join public.contract_units cu on cu.contract_id = d.contract_id
         join public.units u on u.id = cu.unit_id
        where d.id = p_source_id
        limit 1)
    else null
  end;
$fn$;

comment on function public.posting_location(text, uuid) is
  'The property a document belongs to, for tagging its journal lines. Null where the document has none.';

-- ---------------------------------------------------------------------------
-- Every posting is tagged as it is written
-- ---------------------------------------------------------------------------

create or replace function public.post_journal(
  p_company      uuid,
  p_date         date,
  p_memo         text,
  p_source_table text,
  p_source_id    uuid,
  p_source_event text,
  p_lines        jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_entry    uuid;
  v_line     jsonb;
  v_order    integer := 0;
  v_debit    numeric(14, 2) := 0;
  v_credit   numeric(14, 2) := 0;
  v_location uuid;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return null;
  end if;

  -- Already posted for this event: nothing to do.
  if exists (
    select 1 from public.journal_entries
     where company_id = p_company
       and source_table = p_source_table
       and source_id = p_source_id
       and source_event = p_source_event
  ) then
    return null;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_debit  := v_debit  + coalesce((v_line ->> 'debit')::numeric, 0);
    v_credit := v_credit + coalesce((v_line ->> 'credit')::numeric, 0);
  end loop;

  if round(v_debit, 2) = 0 and round(v_credit, 2) = 0 then
    return null;
  end if;

  -- Looked up once for the whole entry: a document belongs to one property.
  v_location := public.posting_location(p_source_table, p_source_id);

  insert into public.journal_entries
    (company_id, entry_no, entry_date, memo, source_table, source_id, source_event)
  values (p_company, public.next_journal_no(p_company, p_date), p_date, p_memo,
          p_source_table, p_source_id, p_source_event)
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_line ->> 'debit')::numeric, 0) = 0
       and coalesce((v_line ->> 'credit')::numeric, 0) = 0 then
      continue;
    end if;

    insert into public.journal_lines
      (entry_id, account_id, description, debit, credit, sort_order, location_id)
    values (v_entry,
            (v_line ->> 'account')::uuid,
            v_line ->> 'description',
            round(coalesce((v_line ->> 'debit')::numeric, 0), 2),
            round(coalesce((v_line ->> 'credit')::numeric, 0), 2),
            v_order,
            -- A line may name its own, for a document that spans properties.
            coalesce((v_line ->> 'location')::uuid, v_location));
    v_order := v_order + 1;
  end loop;

  -- The guard trigger re-checks the balance and the period on the way through.
  update public.journal_entries
     set status = 'posted', posted_at = now()
   where id = v_entry;

  return v_entry;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- What is already on the books
-- ---------------------------------------------------------------------------

/*
 * Backfilled from the same rule, so history reads the same way as anything
 * posted from here. What the rule cannot place stays null: those postings had
 * no property when they were made and inventing one now would be worse than
 * leaving the income statement honest about it.
 */
/*
 * A posted entry is frozen, and rightly so. This adds a column that did not
 * exist when these were written rather than altering a figure, so the guard
 * comes off for the backfill and goes straight back on. No debit, credit or
 * account is touched.
 */
alter table public.journal_lines disable trigger journal_lines_guard;

update public.journal_lines jl
   set location_id = public.posting_location(je.source_table, je.source_id)
  from public.journal_entries je
 where je.id = jl.entry_id
   and jl.location_id is null
   and public.posting_location(je.source_table, je.source_id) is not null;

alter table public.journal_lines enable trigger journal_lines_guard;
