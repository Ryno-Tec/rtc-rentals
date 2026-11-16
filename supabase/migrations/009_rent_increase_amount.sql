-- 009: the yearly rent increase can be a percentage or a fixed rand amount.
alter table public.leases
  add column if not exists escalation_type text not null default 'percent' check (escalation_type in ('percent', 'amount')),
  add column if not exists escalation_amount numeric(12,2) not null default 0 check (escalation_amount >= 0);
