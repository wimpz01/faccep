/**
 * Where each person wants their dashboard.
 *
 * The dashboard shows the same panels to everybody, in an order somebody
 * chose once. What matters most differs by the job: a cashier opens it for
 * cheques, a manager for occupancy, whoever signs things off for the approval
 * queue. Letting each person drag their own arrangement costs nothing and
 * saves them scrolling past four panels every morning to reach the one they
 * came for.
 *
 * The row is per user per company, because the same person can hold different
 * jobs in two companies and would not want one arrangement forced on both.
 *
 * The order is stored as a list of panel keys rather than positions. Keys the
 * app no longer knows are ignored on read, and panels the list does not name
 * fall in at the end in their built-in order -- so adding a panel later shows
 * it to everyone instead of hiding it behind a stale saved layout.
 */

create table if not exists public.dashboard_layouts (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Panel keys, top to bottom.
  panels     text[] not null default '{}',
  -- The figures along the top, left to right.
  tiles      text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

comment on table public.dashboard_layouts is
  'One person''s chosen dashboard order, per company. Purely a display '
  'preference: it decides nothing and is safe to lose.';
comment on column public.dashboard_layouts.panels is
  'Panel keys top to bottom. Unknown keys are ignored; unnamed panels append.';
comment on column public.dashboard_layouts.tiles is
  'Figure keys left to right. Same rules as panels.';

alter table public.dashboard_layouts enable row level security;

/*
 * Your own layout and nobody else's -- not even an administrator's. There is
 * nothing here worth reading about another person, and a preference somebody
 * else can rewrite is not a preference.
 */
create policy dashboard_layouts_own on public.dashboard_layouts
  for all to authenticated
  using      (user_id = auth.uid() and public.is_company_member(company_id))
  with check (user_id = auth.uid() and public.is_company_member(company_id));

drop trigger if exists dashboard_layouts_set_updated_at on public.dashboard_layouts;
create trigger dashboard_layouts_set_updated_at
  before update on public.dashboard_layouts
  for each row execute function public.set_updated_at();
