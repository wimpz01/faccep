/**
 * Who does what with a deposit settlement.
 *
 * 0092 seeded the new module by copying whatever each role already had on
 * contracts, which kept everyone working but did not describe the actual
 * division of the work: Billing came out able to read a settlement and not to
 * prepare one, because they cannot edit a lease -- which is the very reason
 * this module was split off in the first place.
 *
 * Set explicitly instead:
 *
 *   Billing   prepares the settlement and its deductions   view + edit
 *   Manager   approves the refundable balance              view + approve
 *   Cashier   pays the approved refund out                 view
 *
 * Admins already pass everything. Matched on role name because that is what
 * the company named them; a role called something else keeps what 0092 gave it
 * and can be adjusted from the roles screen.
 */

update public.role_permissions rp
   set can_view = true,
       can_edit = true
  from public.roles r
 where r.id = rp.role_id
   and rp.module_key = 'contracts.deposits'
   and lower(r.name) like '%billing%';

update public.role_permissions rp
   set can_view    = true,
       can_approve = true
  from public.roles r
 where r.id = rp.role_id
   and rp.module_key = 'contracts.deposits'
   and (lower(r.name) like '%manager%' or lower(r.name) like '%admin%');

/*
 * The cashier handles the money and nothing else here: she can see what was
 * agreed so she knows what to pay, and cannot alter it or approve it.
 */
update public.role_permissions rp
   set can_view    = true,
       can_edit    = false,
       can_approve = false
  from public.roles r
 where r.id = rp.role_id
   and rp.module_key = 'contracts.deposits'
   and lower(r.name) like '%cashier%';
