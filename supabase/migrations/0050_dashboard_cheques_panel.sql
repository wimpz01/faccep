-- Postdated cheques become a dashboard panel of their own.
--
-- Cheques on hand, what matures this month, what is past maturity and what
-- bounced is a cashier's morning, and it belonged on the front page. It is a
-- separate module so an administrator grants it per role like every other
-- panel -- seeing the cheque register is not the same decision as seeing the
-- totals on the dashboard.

insert into public.modules
  (key, label, module_group, description, sort_order, supports_approve, supports_void)
values
  ('dashboard.cheques', 'Postdated Cheques', 'Dashboard',
   'Cheques on hand, maturing, past maturity and bounced.', 60, false, false)
on conflict (key) do update
   set label            = excluded.label,
       module_group     = excluded.module_group,
       description      = excluded.description,
       sort_order       = excluded.sort_order;

-- Roles that already watch the cheque register see the panel too; anything
-- else is left for the administrator to decide.
insert into public.role_permissions (role_id, module_key, can_view)
select p.role_id, 'dashboard.cheques', true
  from public.role_permissions p
 where p.module_key = 'payments.pdc'
   and p.can_view
on conflict (role_id, module_key) do nothing;
