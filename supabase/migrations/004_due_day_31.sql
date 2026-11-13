-- 004: rent can be due on any day of the month, 1 to 31.
-- In shorter months a due day past the end (e.g. the 31st in April, the 30th in February)
-- falls on the last day of that month; the app works this out.
alter table public.leases drop constraint if exists leases_rent_due_day_check;
alter table public.leases add constraint leases_rent_due_day_check check (rent_due_day between 1 and 31);
