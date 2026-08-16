-- OPTIONAL sample data: one building, two units, one tenant on an active
-- contract, and this month's utility readings.
--
-- Enough to exercise occupancy, contract escalation, the utility computation
-- and invoice generation without hand-entering a dozen screens. Everything it
-- creates is named below so it can be removed again:
--
--   delete from public.contracts    where contract_no = 'CT-2026-0001';
--   delete from public.tenants      where company_name = 'Sunrise Hardware Trading';
--   delete from public.utility_periods where location_id in
--     (select id from public.locations where code = 'BLDG-A');
--   delete from public.units        where code in ('101', '102');
--   delete from public.locations    where code = 'BLDG-A';
--
-- Set the company name below, then run it.

do $$
declare
  v_company_name constant text := 'Faccep Properties';
  v_company    uuid;
  v_location   uuid;
  v_unit_101   uuid;
  v_unit_102   uuid;
  v_tenant     uuid;
  v_contract   uuid;
  v_elec       uuid;
  v_water      uuid;
  v_month_start date := date_trunc('month', current_date)::date;
  v_month_end   date := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
begin
  select id into v_company from public.companies
   where lower(name) = lower(v_company_name);
  if v_company is null then
    raise exception 'No company named "%".', v_company_name;
  end if;

  ---------------------------------------------------------------------------
  -- Building and units
  ---------------------------------------------------------------------------
  insert into public.locations (company_id, code, name, property_type, address)
  values (v_company, 'BLDG-A', 'Faccep Commercial Center',
          'commercial_building', '123 Rizal Avenue, Cabanatuan City')
  on conflict (company_id, lower(code)) do update set name = excluded.name
  returning id into v_location;

  insert into public.units
    (company_id, location_id, code, floor, area_sqm, monthly_rate,
     water_meter_serial, electric_meter_serial, description)
  values (v_company, v_location, '101', 'Ground', 48.5, 25000,
          'WM-101', 'EM-101', 'Corner unit facing the main road')
  on conflict (location_id, lower(code)) do update set monthly_rate = excluded.monthly_rate
  returning id into v_unit_101;

  insert into public.units
    (company_id, location_id, code, floor, area_sqm, monthly_rate,
     water_meter_serial, electric_meter_serial, description)
  values (v_company, v_location, '102', 'Ground', 36.0, 18000,
          'WM-102', 'EM-102', 'Interior unit, currently available')
  on conflict (location_id, lower(code)) do update set monthly_rate = excluded.monthly_rate
  returning id into v_unit_102;

  ---------------------------------------------------------------------------
  -- Tenant and contract. VATable, so invoices carry output VAT.
  ---------------------------------------------------------------------------
  insert into public.tenants
    (company_id, company_name, address, contact_person, mobile_number, email,
     tin, is_vatable, status)
  values (v_company, 'Sunrise Hardware Trading',
          '45 Burgos Street, Cabanatuan City', 'Mr. Antonio Cruz',
          '0917 555 0142', 'antonio@sunrisehardware.example',
          '123-456-789-000', true, 'active')
  on conflict (company_id, lower(company_name)) do update
    set contact_person = excluded.contact_person
  returning id into v_tenant;

  insert into public.contracts
    (company_id, tenant_id, contract_no, status, start_date, end_date,
     term_years, monthly_rent, security_deposit, advance_payment,
     escalation_rate, rent_due_day, penalty_rate,
     water_billing_type, electric_billing_type,
     repair_responsibility, renewal_terms)
  values (v_company, v_tenant, 'CT-2026-0001', 'draft',
          '2026-01-01', '2027-12-31', 2, 25000, 50000, 25000,
          5, 5, 2, 'consumption', 'consumption',
          'Lessee maintains the interior; structural repairs remain with the Lessor.',
          'Renewable by mutual agreement on sixty days written notice.')
  on conflict (company_id, lower(contract_no)) do update
    set monthly_rent = excluded.monthly_rent
  returning id into v_contract;

  insert into public.contract_units (contract_id, unit_id)
  values (v_contract, v_unit_101)
  on conflict do nothing;

  -- Only these appear on the tenant's invoice.
  insert into public.contract_inclusions (contract_id, inclusion, amount, sort_order)
  values (v_contract, 'rent', 25000, 0),
         (v_contract, 'water', null, 1),
         (v_contract, 'electricity', null, 2)
  on conflict do nothing;

  -- Activating flips unit 101 to occupied via the sync trigger.
  update public.contracts set status = 'active' where id = v_contract;

  ---------------------------------------------------------------------------
  -- This month's provider bills and sub-meter readings
  ---------------------------------------------------------------------------
  insert into public.utility_periods
    (company_id, location_id, utility, period_start, period_end,
     provider_amount, provider_consumption, extra_expense, notes)
  values (v_company, v_location, 'electric', v_month_start, v_month_end,
          62000, 5500, 8000, 'Meralco bill plus generator fuel for the month')
  on conflict (location_id, utility, period_start) do update
    set provider_amount = excluded.provider_amount
  returning id into v_elec;

  insert into public.utility_periods
    (company_id, location_id, utility, period_start, period_end,
     provider_amount, provider_consumption, extra_expense, notes)
  values (v_company, v_location, 'water', v_month_start, v_month_end,
          9000, 320, 0, 'Water district bill for the month')
  on conflict (location_id, utility, period_start) do update
    set provider_amount = excluded.provider_amount
  returning id into v_water;

  insert into public.meter_readings
    (company_id, period_id, unit_id, previous_reading, present_reading, reading_date)
  values (v_company, v_elec,  v_unit_101, 1200, 1650, v_month_end),
         (v_company, v_elec,  v_unit_102, 800,  815,  v_month_end),
         (v_company, v_water, v_unit_101, 240,  258,  v_month_end),
         (v_company, v_water, v_unit_102, 110,  112,  v_month_end)
  on conflict (period_id, unit_id) do update
    set present_reading = excluded.present_reading;

  raise notice 'Sample data ready for %.', v_company_name;
end;
$$;
