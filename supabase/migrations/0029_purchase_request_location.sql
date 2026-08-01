-- Which property a purchase is for.
--
-- A request could already be tied to a maintenance job, which carries its own
-- location, but most purchasing is not raised against a job -- supplies for a
-- building, a replacement pump, a fire extinguisher refill. Without this the
-- cost cannot be attributed to the property it was spent on.
--
-- Nullable on purpose: some buying really is company-wide (office paper, a
-- laptop for the admin) and forcing a location would invite a wrong one.

alter table public.purchase_requests
  add column if not exists location_id uuid
    references public.locations (id) on delete set null;

comment on column public.purchase_requests.location_id is
  'The property this purchase is for. Null means company-wide.';

create index if not exists purchase_requests_location_idx
  on public.purchase_requests (company_id, location_id);
