/**
 * A note of the postdated cheques handed over when a contract is signed.
 *
 * Deliberately NOT the postdated cheque register. That register is the
 * cashier's: a cheque in it is banked, cleared, bounced, chased, and turns
 * into a collection against an invoice. This is a different thing with the
 * same subject -- an acknowledgement, written when the tenant hands over a
 * year of cheques at signing, so both sides have a record of what changed
 * hands. It settles nothing and posts nothing.
 *
 * Kept apart for that reason. Folding it into postdated_checks would put a
 * dozen cheques into the cashier's queue on the day a lease was signed, raise
 * maturity alerts on the dashboard for cheques nobody has yet been given to
 * bank, and make an acknowledgement look like a receivable.
 *
 * If the cheques are later handed to the cashier, they are recorded there as
 * well. The two records answer different questions and neither is derived
 * from the other.
 */

create table public.contract_cheque_receipts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  contract_id uuid not null references public.contracts (id) on delete cascade,
  bank        text not null,
  cheque_no   text not null,
  amount      numeric(14, 2) not null check (amount > 0),
  cheque_date date not null,
  notes       text,
  received_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.contract_cheque_receipts is
  'Acknowledgement of postdated cheques handed over at signing. A note on the '
  'contract, not the cashier''s postdated cheque register.';

create index contract_cheque_receipts_contract_idx
  on public.contract_cheque_receipts (contract_id, cheque_date);

-- The same cheque cannot be acknowledged twice on one contract.
create unique index contract_cheque_receipts_unique
  on public.contract_cheque_receipts (contract_id, lower(bank), lower(cheque_no));

alter table public.contract_cheque_receipts enable row level security;

create policy contract_cheque_receipts_read on public.contract_cheque_receipts
  for select to authenticated
  using (public.has_permission(company_id, 'contracts', 'view'));

create policy contract_cheque_receipts_write on public.contract_cheque_receipts
  for all to authenticated
  using (public.has_permission(company_id, 'contracts', 'edit'))
  with check (public.has_permission(company_id, 'contracts', 'edit'));
