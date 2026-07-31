-- OPTIONAL starter roles for one company.
--
-- These are the example roles from specification section 2, wired to the
-- confirmed segregation-of-duties rules:
--   * Billing Processor creates invoices but cannot touch payments.
--   * Cashier is view-only on invoices and can only apply payments.
--   * Manager approves; it does not create.
--   * Property Custodian runs maintenance but does not reach into Purchasing.
--
-- Roles are meant to be edited freely in the UI afterwards -- nothing here is
-- fixed by the system. Set the company name below, then run the file.

do $$
declare
  v_company_name constant text := 'Faccep Properties';   -- <-- set this first
  v_company_id   uuid;
  v_role_id      uuid;
begin
  select id into v_company_id
    from public.companies
   where lower(name) = lower(v_company_name);

  if v_company_id is null then
    raise exception 'No company named "%". Create it in the app first.', v_company_name;
  end if;

  ---------------------------------------------------------------------------
  -- Manager: sees everything, approves everything, creates nothing.
  ---------------------------------------------------------------------------
  insert into public.roles (company_id, name, description)
  values (v_company_id, 'Manager',
          'Reviews and approves. Sees every module; does not encode transactions.')
  on conflict (company_id, lower(name)) do update set description = excluded.description
  returning id into v_role_id;

  insert into public.role_permissions
    (role_id, module_key, can_view, can_edit, can_delete, can_approve, can_void)
  select v_role_id, m.key, true, false, false, m.supports_approve, false
    from public.modules m
   where m.module_group <> 'Administration'
  on conflict (role_id, module_key) do update
    set can_view = excluded.can_view,
        can_edit = excluded.can_edit,
        can_delete = excluded.can_delete,
        can_approve = excluded.can_approve,
        can_void = excluded.can_void;

  ---------------------------------------------------------------------------
  -- Billing Processor / Encoder: creates invoices, never settles them.
  ---------------------------------------------------------------------------
  insert into public.roles (company_id, name, description)
  values (v_company_id, 'Billing Processor',
          'Encodes meter readings and tenant invoices. Cannot accept or apply payments.')
  on conflict (company_id, lower(name)) do update set description = excluded.description
  returning id into v_role_id;

  insert into public.role_permissions
    (role_id, module_key, can_view, can_edit, can_delete, can_approve, can_void)
  values
    (v_role_id, 'tenants',                 true,  false, false, false, false),
    (v_role_id, 'contracts',               true,  false, false, false, false),
    (v_role_id, 'properties',              true,  false, false, false, false),
    (v_role_id, 'units',                   true,  false, false, false, false),
    (v_role_id, 'billing.meter_readings',  true,  true,  false, false, false),
    (v_role_id, 'billing.utility_rates',   true,  true,  false, false, false),
    (v_role_id, 'billing.invoices',        true,  true,  false, false, false),
    (v_role_id, 'billing.credit_memos',    true,  true,  false, false, false),
    (v_role_id, 'reports.receivables',     true,  false, false, false, false),
    (v_role_id, 'reports.utilities',       true,  false, false, false, false)
  on conflict (role_id, module_key) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit;

  ---------------------------------------------------------------------------
  -- Cashier: view-only on invoices, apply-only on payments, no voids.
  ---------------------------------------------------------------------------
  insert into public.roles (company_id, name, description)
  values (v_company_id, 'Cashier',
          'Accepts and applies client payments. View-only on invoices; cannot void.')
  on conflict (company_id, lower(name)) do update set description = excluded.description
  returning id into v_role_id;

  insert into public.role_permissions
    (role_id, module_key, can_view, can_edit, can_delete, can_approve, can_void)
  values
    (v_role_id, 'tenants',            true, false, false, false, false),
    (v_role_id, 'billing.invoices',   true, false, false, false, false),
    (v_role_id, 'payments',           true, true,  false, false, false),
    (v_role_id, 'payments.pdc',       true, true,  false, false, false),
    (v_role_id, 'bank.deposits',      true, true,  false, false, false),
    (v_role_id, 'reports.receivables',true, false, false, false, false)
  on conflict (role_id, module_key) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit;

  ---------------------------------------------------------------------------
  -- Property Custodian: maintenance and inventory. Purchasing is a separate
  -- module, so a material request hands off rather than granting access.
  ---------------------------------------------------------------------------
  insert into public.roles (company_id, name, description)
  values (v_company_id, 'Property Custodian',
          'Runs repair and maintenance. Raises material requests; no Purchasing access.')
  on conflict (company_id, lower(name)) do update set description = excluded.description
  returning id into v_role_id;

  insert into public.role_permissions
    (role_id, module_key, can_view, can_edit, can_delete, can_approve, can_void)
  values
    (v_role_id, 'properties',                      true, false, false, false, false),
    (v_role_id, 'units',                           true, false, false, false, false),
    (v_role_id, 'maintenance.scheduled',           true, true,  false, false, false),
    (v_role_id, 'maintenance.repairs',             true, true,  false, false, false),
    (v_role_id, 'maintenance.material_requests',   true, true,  false, false, false),
    (v_role_id, 'inventory.items',                 true, false, false, false, false),
    (v_role_id, 'inventory.movements',             true, true,  false, false, false),
    (v_role_id, 'inventory.tools',                 true, true,  false, false, false),
    (v_role_id, 'crm.complaints',                  true, true,  false, false, false),
    (v_role_id, 'calendar',                        true, true,  false, false, false)
  on conflict (role_id, module_key) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit;

  raise notice 'Starter roles created for company %.', v_company_name;
end;
$$;
