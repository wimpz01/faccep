/**
 * How the billing prints, as a setting rather than a decision in the code.
 *
 * The sheet a billing is printed on is a house matter: some print on A4, some
 * on half letter laid on its side, and what has to appear on it changes with
 * who reads it. Fixing that in the markup means a deployment every time the
 * paper changes, and it was already wrong once -- the meter cycle printed
 * under every utility line, which is useful on A4 and simply pushes the
 * columns off a 5.5in page.
 *
 * One row per company. Sizes are in inches because that is what the paper is
 * sold as here, and type in points because that is what type is measured in;
 * converting either for storage would only make the screen harder to read.
 *
 * Nothing here changes an invoice. It changes the sheet a billing is printed
 * on, so it can be edited freely and as often as the paper changes.
 */

create table public.invoice_print_settings (
  company_id       uuid primary key
                     references public.companies (id) on delete cascade,

  -- The sheet. Defaults to half letter on its side, which is what this
  -- company prints on.
  page_width_in    numeric(4, 2) not null default 8.5
                     check (page_width_in between 3 and 24),
  page_height_in   numeric(4, 2) not null default 5.5
                     check (page_height_in between 3 and 24),
  margin_in        numeric(4, 2) not null default 0.35
                     check (margin_in between 0 and 2),

  -- Type. The table is usually set a little smaller than the body.
  body_font_pt     numeric(4, 1) not null default 8.5
                     check (body_font_pt between 5 and 16),
  table_font_pt    numeric(4, 1) not null default 8
                     check (table_font_pt between 5 and 16),

  /*
   * What appears. Each of these is a column or a block that is worth having
   * on a roomy sheet and worth losing on a short one.
   *
   * The meter cycle starts off: it is the first thing to go when the columns
   * are tight, and the billing period at the top already says what month the
   * bill is for.
   */
  show_meter_dates    boolean not null default false,
  show_meter_columns  boolean not null default true,
  show_vat_column     boolean not null default true,
  show_payment_note   boolean not null default true,
  show_signatures     boolean not null default true,

  -- Printed under the signatures, where a company puts its own wording.
  footer_note      text,

  updated_at       timestamptz not null default now()
);

comment on table public.invoice_print_settings is
  'How a billing is laid out when printed. Affects the sheet only, never the invoice.';
comment on column public.invoice_print_settings.show_meter_dates is
  'The provider cycle under each utility line. Off by default: it is the first thing to lose when the columns are tight.';

alter table public.invoice_print_settings enable row level security;

create policy invoice_print_settings_read on public.invoice_print_settings
  for select to authenticated
  using (public.has_permission(company_id, 'billing.invoices', 'view'));

create policy invoice_print_settings_write on public.invoice_print_settings
  for all to authenticated
  using (public.has_permission(company_id, 'billing.invoices', 'edit'))
  with check (public.has_permission(company_id, 'billing.invoices', 'edit'));

create trigger invoice_print_settings_touch
  before update on public.invoice_print_settings
  for each row execute function public.set_updated_at();

-- Every company starts with the defaults, and so does any made later.
insert into public.invoice_print_settings (company_id)
select id from public.companies
on conflict (company_id) do nothing;

create or replace function public.seed_invoice_print_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.invoice_print_settings (company_id)
  values (new.id)
  on conflict (company_id) do nothing;
  return null;
end;
$fn$;

create trigger companies_seed_invoice_print_settings
  after insert on public.companies
  for each row execute function public.seed_invoice_print_settings();
