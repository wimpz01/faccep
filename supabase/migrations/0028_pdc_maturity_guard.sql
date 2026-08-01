-- A cheque cannot mature before the date written on it.
--
-- The register let anyone press "Mark matured" the moment a cheque was
-- recorded, so a cheque dated weeks ahead could sit in the books as matured
-- and be banked early. The whole point of a postdated cheque is that it is not
-- payable until its date, so the rule belongs here rather than in the screen
-- that happens to offer the button.

create or replace function public.guard_pdc_maturity()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('matured', 'deposited')
     and new.maturity_date > current_date then
    raise exception
      'Cheque % is dated % and cannot be marked % before then.',
      new.check_no, to_char(new.maturity_date, 'DD Mon YYYY'), new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_pdc_maturity on public.postdated_checks;
create trigger guard_pdc_maturity
  before insert or update on public.postdated_checks
  for each row execute function public.guard_pdc_maturity();

-- Put back any cheque that was tagged matured ahead of its date. Nothing was
-- banked on the strength of it -- depositing is a separate step -- so returning
-- it to pending is enough.
update public.postdated_checks
   set status = 'pending'
 where status = 'matured'
   and maturity_date > current_date;
