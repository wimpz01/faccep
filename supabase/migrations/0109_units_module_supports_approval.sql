/**
 * The units module has to declare that it supports approval.
 *
 * Until 0106 nothing about a unit was ever signed off, so the module was
 * seeded with supports_approve = false. That flag is not decoration: it is
 * what my_permissions() hands an administrator, so an admin's can_approve on
 * this module came back false, the Roles screen offered no Approve tick for
 * it, and the rate change raised by 0108 sat in the queue reading "You do not
 * have Approve on this module" -- for everybody, with no way to grant it.
 *
 * Worth noting why the tests did not catch it. has_permission(), which is what
 * row-level security and the rate functions use, gives an administrator
 * everything outright and never consults this flag. my_permissions(), which is
 * what the screens read, does consult it. The two disagreed only for a module
 * that had just started needing approval, which is exactly this one.
 */

update public.modules
   set supports_approve = true
 where key = 'units';

comment on column public.modules.supports_approve is
  'Whether anything in this module is signed off. Read by my_permissions when expanding an administrator, so a module that gates something on Approve must say so here or nobody can be given it.';
