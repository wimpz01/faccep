-- Carry the property through the buying chain.
--
-- The request already says which property the spend is for, but the order, the
-- receipt and the supplier's bill did not, so by the time a cost reached the
-- ledger the property had been lost. Each step now carries it, inherited from
-- the step before unless it is raised standalone.
--
-- The receipt is deliberately left out: it belongs to exactly one order and
-- takes the order's property, so storing it again would only create a second
-- copy that could disagree.

alter table public.purchase_orders
  add column if not exists location_id uuid
    references public.locations (id) on delete set null;

alter table public.supplier_invoices
  add column if not exists location_id uuid
    references public.locations (id) on delete set null;

comment on column public.purchase_orders.location_id is
  'The property this order is for. Null means company-wide.';
comment on column public.supplier_invoices.location_id is
  'The property this bill is charged to. Null means company-wide.';

create index if not exists purchase_orders_location_idx
  on public.purchase_orders (company_id, location_id);
create index if not exists supplier_invoices_location_idx
  on public.supplier_invoices (company_id, location_id);

-- Anything already on file inherits from the step it came from.
update public.purchase_orders o
   set location_id = r.location_id
  from public.purchase_requests r
 where o.request_id = r.id
   and o.location_id is null
   and r.location_id is not null;

update public.supplier_invoices i
   set location_id = o.location_id
  from public.purchase_orders o
 where i.po_id = o.id
   and i.location_id is null
   and o.location_id is not null;

-- A bill raised against a maintenance job takes that job's property.
update public.supplier_invoices i
   set location_id = j.location_id
  from public.maintenance_jobs j
 where i.job_id = j.id
   and i.location_id is null
   and j.location_id is not null;
