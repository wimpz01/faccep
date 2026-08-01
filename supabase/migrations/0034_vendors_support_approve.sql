-- Suppliers are now an approvable module.
--
-- Nothing approved a supplier before, so purchasing.vendors was registered
-- with supports_approve = false. my_permissions() reports that flag straight
-- through for company admins, so the approvals queue showed "You do not have
-- Approve on this module" and hid the buttons -- even though has_permission()
-- would have allowed the decision. The module has to declare the action before
-- the screen will offer it.

update public.modules
   set supports_approve = true
 where key = 'purchasing.vendors';

-- Manager already signs off purchase requests, orders and receiving, so the
-- same role takes new suppliers. Whoever adds a supplier still cannot approve
-- them unless they also hold this role.
insert into public.role_permissions (role_id, module_key, can_view, can_approve)
select r.id, 'purchasing.vendors', true, true
  from public.roles r
 where r.name = 'Manager'
on conflict (role_id, module_key)
  do update set can_view = true, can_approve = true;
