-- View, edit and delete are a ladder, and the database says so.
--
--   revoked  no access at all — the module is not even visible
--   view     read it, change nothing
--   edit     read and save, but not delete
--   delete   read, save and delete
--
-- Approve and void sit apart — sign-off rights some modules do not offer — but
-- they still need view: signing off on something you cannot see is not a
-- coherent right.
--
-- The screen already enforces this and the server normalises it when resolving
-- a matrix, but neither helps a row written by a script or an older client.
-- A row that cannot exist is better than one that has to be interpreted.

alter table public.role_permissions
  add constraint role_permissions_ladder check (
    (not can_delete or can_edit)
    and (not (can_edit or can_delete or can_approve or can_void) or can_view)
  );

alter table public.user_permissions
  add constraint user_permissions_ladder check (
    (not can_delete or can_edit)
    and (not (can_edit or can_delete or can_approve or can_void) or can_view)
  );

comment on constraint role_permissions_ladder on public.role_permissions is
  'delete implies edit implies view; approve and void require view.';
