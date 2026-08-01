-- Transaction numbers are issued by the database, not by the application.
--
-- Every module used to run its own "read the highest number, add one" query
-- from application code. Two people creating a document in the same moment read
-- the same highest value and built the same number, and the unique index then
-- rejected one of them. Holding the running total in a counter row that is
-- incremented as part of the insert makes that impossible: the second writer
-- waits on the row lock and gets the next value.

create table if not exists public.document_counters (
  company_id uuid    not null references public.companies(id) on delete cascade,
  doc_type   text    not null,
  year       integer not null,
  last_value integer not null default 0,
  primary key (company_id, doc_type, year)
);

comment on table public.document_counters is
  'One running number per company, document type and year. Only ever touched '
  'through next_document_no().';

-- No policies are defined on purpose. The counter is reached exclusively
-- through the SECURITY DEFINER function below, never read or written directly
-- by a signed-in user.
alter table public.document_counters enable row level security;

/**
 * Issues the next number for one company / document type / year.
 *
 * The upsert takes a row lock, so concurrent callers serialise and each gets a
 * distinct value.
 */
create or replace function public.next_document_no(
  p_company  uuid,
  p_doc_type text,
  p_prefix   text,
  p_year     integer,
  p_width    integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  if p_company is null then
    raise exception 'A document number needs a company.';
  end if;

  insert into public.document_counters (company_id, doc_type, year, last_value)
  values (p_company, p_doc_type, p_year, 1)
  on conflict (company_id, doc_type, year)
    do update set last_value = document_counters.last_value + 1
  returning last_value into v_next;

  return p_prefix || '-' || p_year || '-' || lpad(v_next::text, p_width, '0');
end;
$$;

/**
 * BEFORE INSERT trigger that fills in the document number column.
 *
 * Arguments: column name, counter key, prefix, zero-padded width.
 */
create or replace function public.assign_document_no()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_column  text    := tg_argv[0];
  v_doc     text    := tg_argv[1];
  v_prefix  text    := tg_argv[2];
  v_width   integer := tg_argv[3]::integer;
  v_current text;
  v_issued  text;
begin
  execute format('select ($1).%I::text', v_column) into v_current using new;

  -- A number supplied explicitly (seed data, a migration, an import) is left
  -- alone; everything the application inserts leaves the column blank.
  if v_current is not null and btrim(v_current) <> '' then
    return new;
  end if;

  v_issued := public.next_document_no(
    new.company_id, v_doc, v_prefix,
    extract(year from current_date)::integer, v_width);

  -- Casting the null to the table's row type gives jsonb_populate_record a
  -- concrete composite type to work from.
  execute format(
    'select jsonb_populate_record(null::public.%I, to_jsonb($1) || $2)',
    tg_table_name)
    into new
    using new, jsonb_build_object(v_column, v_issued);

  return new;
end;
$$;

-- Carry the existing numbers over so the counters continue the series instead
-- of restarting at 1 and colliding with what is already there.
do $$
declare
  spec    record;
  pattern text;
begin
  for spec in
    select * from (values
      ('contracts',         'contract_no',  'contract',         'CT'),
      ('invoices',          'invoice_no',   'invoice',          'INV'),
      ('credit_memos',      'memo_no',      'credit_memo',      'CM'),
      ('payments',          'payment_no',   'payment',          'OR'),
      ('maintenance_jobs',  'job_no',       'maintenance_job',  'JOB'),
      ('material_requests', 'request_no',   'material_request', 'MR'),
      ('purchase_requests', 'request_no',   'purchase_request', 'PR'),
      ('purchase_orders',   'po_no',        'purchase_order',   'PO'),
      ('goods_receipts',    'receipt_no',   'goods_receipt',    'GR'),
      ('check_vouchers',    'voucher_no',   'check_voucher',    'CV'),
      ('inquiries',         'inquiry_no',   'inquiry',          'INQ'),
      ('complaints',        'complaint_no', 'complaint',        'CMP'),
      ('journal_entries',   'entry_no',     'journal_entry',    'JV')
    ) as t(tbl, col, doc, prefix)
  loop
    pattern := '^' || spec.prefix || '-(\d{4})-(\d+)$';

    execute format(
      'insert into public.document_counters (company_id, doc_type, year, last_value)
       select company_id, %1$L,
              (regexp_match(%2$I, %3$L))[1]::integer,
              max((regexp_match(%2$I, %3$L))[2]::integer)
         from public.%4$I
        where %2$I ~ %3$L
        group by company_id, (regexp_match(%2$I, %3$L))[1]::integer
       on conflict (company_id, doc_type, year)
         do update set last_value =
              greatest(document_counters.last_value, excluded.last_value)',
      spec.doc, spec.col, pattern, spec.tbl);
  end loop;
end;
$$;

-- Attach the trigger to every table that carries a number we own.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('contracts',         'contract_no',  'contract',         'CT',  4),
      ('invoices',          'invoice_no',   'invoice',          'INV', 5),
      ('credit_memos',      'memo_no',      'credit_memo',      'CM',  4),
      ('payments',          'payment_no',   'payment',          'OR',  5),
      ('maintenance_jobs',  'job_no',       'maintenance_job',  'JOB', 4),
      ('material_requests', 'request_no',   'material_request', 'MR',  4),
      ('purchase_requests', 'request_no',   'purchase_request', 'PR',  4),
      ('purchase_orders',   'po_no',        'purchase_order',   'PO',  4),
      ('goods_receipts',    'receipt_no',   'goods_receipt',    'GR',  4),
      ('check_vouchers',    'voucher_no',   'check_voucher',    'CV',  4),
      ('inquiries',         'inquiry_no',   'inquiry',          'INQ', 4),
      ('complaints',        'complaint_no', 'complaint',        'CMP', 4),
      ('journal_entries',   'entry_no',     'journal_entry',    'JV',  5)
    ) as t(tbl, col, doc, prefix, width)
  loop
    execute format('drop trigger if exists assign_%1$s_no on public.%2$I',
                   spec.doc, spec.tbl);
    execute format(
      'create trigger assign_%1$s_no before insert on public.%2$I
         for each row execute function
         public.assign_document_no(%3$L, %1$L, %4$L, %5$L)',
      spec.doc, spec.tbl, spec.col, spec.prefix, spec.width::text);
  end loop;
end;
$$;

-- Auto-posting keeps its own entry point, but it now draws from the same
-- counter so manual and generated entries can never land on the same number.
create or replace function public.next_journal_no(p_company uuid, p_date date)
returns text
language sql
security definer
set search_path = public
as $$
  select public.next_document_no(
    p_company, 'journal_entry', 'JV',
    extract(year from p_date)::integer, 5);
$$;

-- The number columns stay NOT NULL; the trigger fills them before the
-- constraint is checked. Dropping the app's own numbering is what makes the
-- column arrive blank in the first place.
