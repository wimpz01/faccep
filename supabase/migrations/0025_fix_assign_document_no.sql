-- assign_document_no() returned the rebuilt row as a single composite value.
-- PL/pgSQL's INTO assigns a result row column by column, so it tried to put a
-- whole `contracts` value into the first field and failed with
--   "Returned type contracts does not match expected type uuid in column 1".
--
-- Putting the call in FROM expands the composite into its columns, which is the
-- shape INTO expects, and evaluates it once.

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
  -- concrete composite type to build from.
  execute format(
    'select * from jsonb_populate_record(null::public.%I, to_jsonb($1) || $2)',
    tg_table_name)
    into new
    using new, jsonb_build_object(v_column, v_issued);

  return new;
end;
$$;
