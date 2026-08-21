/**
 * A proposed rate joins the queue everybody already watches.
 *
 * 0106 put the proposal in unit_rate_changes, which is where the history
 * belongs, but nothing pointed the approver at it. Approvals in this system
 * are read in one place, and a rule nobody is told about is a rule nobody
 * follows.
 *
 * So every proposal raises an approval_requests row alongside itself, keyed on
 * the units module -- which is what makes "anyone I give Approve on units to"
 * the answer to who may sign one off.
 *
 * Raised by trigger rather than by the form that happens to be in front of the
 * user, because a proposal can also arrive from a CSV import or a unit created
 * by a script, and one that never reached the queue would sit unnoticed while
 * the unit stayed unlettable.
 */

create or replace function public.queue_unit_rate_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_unit public.units%rowtype;
begin
  select * into v_unit from public.units where id = new.unit_id;

  insert into public.approval_requests (
    company_id, module_key, entity_table, entity_id, action, reason,
    requested_by)
  values (
    new.company_id, 'units', 'unit_rate_changes', new.id, 'approve',
    case
      when new.is_initial then
        'Set unit ' || coalesce(v_unit.code, '?') || ' at ' ||
        to_char(new.proposed_rate, 'FM999,999,990.00')
      else
        'Move unit ' || coalesce(v_unit.code, '?') || ' from ' ||
        to_char(new.current_rate, 'FM999,999,990.00') || ' to ' ||
        to_char(new.proposed_rate, 'FM999,999,990.00')
    end ||
    coalesce(' -- ' || nullif(btrim(new.reason), ''), ''),
    new.requested_by);

  return null;
end;
$fn$;

-- Only a live proposal is queued. The backfill in 0106 wrote history, not
-- requests, and those are already decided.
create trigger unit_rate_changes_queue
  after insert on public.unit_rate_changes
  for each row
  when (new.status = 'pending')
  execute function public.queue_unit_rate_change();

/*
 * Deciding a rate change outside the approvals screen would leave its request
 * open for ever, so the request follows the decision either way.
 */
create or replace function public.close_unit_rate_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old.status = 'pending' and new.status <> 'pending' then
    update public.approval_requests
       set status = case
                      when new.status = 'approved' then 'approved'
                      else 'rejected'
                    end::public.approval_status,
           decided_by = new.decided_by,
           decided_at = coalesce(new.decided_at, now()),
           decision_note = new.decision_note
     where entity_table = 'unit_rate_changes'
       and entity_id = new.id
       and status = 'pending';
  end if;

  return null;
end;
$fn$;

create trigger unit_rate_changes_close_request
  after update on public.unit_rate_changes
  for each row execute function public.close_unit_rate_request();

/*
 * The rate changes already open when this arrived -- raised by 0106 between
 * that migration and this one -- need their request too.
 */
insert into public.approval_requests (
  company_id, module_key, entity_table, entity_id, action, reason, requested_by)
select rc.company_id, 'units', 'unit_rate_changes', rc.id, 'approve',
       'Set unit ' || coalesce(u.code, '?') || ' at ' ||
       to_char(rc.proposed_rate, 'FM999,999,990.00'),
       rc.requested_by
  from public.unit_rate_changes rc
  left join public.units u on u.id = rc.unit_id
 where rc.status = 'pending'
   and not exists (
     select 1 from public.approval_requests ar
      where ar.entity_table = 'unit_rate_changes'
        and ar.entity_id = rc.id
   );
