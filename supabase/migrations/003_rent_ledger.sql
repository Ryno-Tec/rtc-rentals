-- 003: landlord rent ledger
-- Landlords record rent received by EFT or cash against each month's charge, with the
-- reference that appeared on their bank statement. provider_ref stays reserved for
-- payment-provider transaction ids (Ozow), which must be unique for idempotency;
-- bank references repeat ("RENT"), so they get their own column.

alter table public.payments add column if not exists reference text;
alter table public.payments add column if not exists notes text;

-- Months charged before the landlord started using RTC Rentals can be marked as settled
-- in one go; this records that the row was created as part of an opening balance.
alter table public.payments add column if not exists opening_balance boolean not null default false;

-- Payments inherit the landlord from their lease, so the browser never has to send it.
create or replace function public.fill_landlord_from_lease()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.landlord_id is null then
    select landlord_id into new.landlord_id from public.leases where id = new.lease_id;
  end if;
  return new;
end $$;

drop trigger if exists payments_fill_landlord on public.payments;
create trigger payments_fill_landlord before insert on public.payments
  for each row execute function public.fill_landlord_from_lease();

-- A tenant may not see notes the landlord writes for themselves.
-- (payments_tenant_read already limits rows to the tenant's own lease; notes are private.)
comment on column public.payments.notes is 'Landlord-only notes. Not shown in the tenant app.';
