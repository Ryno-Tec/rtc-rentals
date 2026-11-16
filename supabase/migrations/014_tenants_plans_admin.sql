-- 014: removing tenants, owners changing their own plan, and the Ryno-Tec admin dashboard.

-- ============================================================================
-- Removing a tenant
-- ============================================================================
-- Added by mistake (no rent paid, nothing signed, no inspection): deleted outright.
-- A real tenancy: the lease ends, app access goes, the tenant is archived. The rent history stays
-- (SARS can ask for five years of records; deposits and disputes need it too).
alter table public.tenants add column if not exists archived_at timestamptz;

create or replace function public.remove_tenant(p_tenant uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_t public.tenants; v_history boolean;
begin
  if v_landlord is null then raise exception 'Only an owner can remove a tenant' using errcode = '42501'; end if;
  select * into v_t from public.tenants where id = p_tenant and landlord_id = v_landlord;
  if not found then raise exception 'Tenant not found' using errcode = 'P0002'; end if;

  select exists (select 1 from public.payments p join public.leases l on l.id = p.lease_id
                  where l.tenant_id = p_tenant and p.amount_paid > 0)
      or exists (select 1 from public.lease_signatures s join public.lease_documents d on d.id = s.document_id
                  join public.leases l on l.id = d.lease_id where l.tenant_id = p_tenant)
      or exists (select 1 from public.inspections i join public.leases l on l.id = i.lease_id where l.tenant_id = p_tenant)
      or exists (select 1 from public.online_payments o join public.payments p on p.id = o.payment_id
                  join public.leases l on l.id = p.lease_id where l.tenant_id = p_tenant)
    into v_history;

  if not v_history then
    begin
      delete from public.payments where lease_id in (select id from public.leases where tenant_id = p_tenant);
      delete from public.leases where tenant_id = p_tenant;
      delete from public.tenants where id = p_tenant;
      update public.units u set status = 'vacant' where u.landlord_id = v_landlord and u.status = 'occupied'
        and not exists (select 1 from public.leases l where l.unit_id = u.id and l.status in ('signed', 'active'));
      return 'deleted';
    exception when foreign_key_violation then
      null;   -- something still points at it: archive instead
    end;
  end if;

  update public.leases set status = case when status in ('draft', 'sent') then 'cancelled'::public.lease_status else 'ended'::public.lease_status end,
         end_date = case when status in ('signed', 'active') then least(coalesce(end_date, current_date), current_date) else end_date end
   where tenant_id = p_tenant and status in ('draft', 'sent', 'signed', 'active');
  delete from public.tenant_invites where tenant_id = p_tenant and accepted_at is null;
  update public.tenants set archived_at = now(), user_id = null where id = p_tenant;
  update public.units u set status = 'vacant' where u.landlord_id = v_landlord and u.status = 'occupied'
    and not exists (select 1 from public.leases l where l.unit_id = u.id and l.status in ('signed', 'active'));
  return 'archived';
end $$;
revoke all on function public.remove_tenant(uuid) from public, anon;
grant execute on function public.remove_tenant(uuid) to authenticated;

-- ============================================================================
-- Plans: owners change their own; every month is billed at the highest plan held in it
-- ============================================================================
alter table public.landlords add column if not exists custom_price numeric(10,2);   -- Agency / special deals, set by Ryno-Tec

create table if not exists public.plan_changes (
  id          bigint generated always as identity primary key,
  landlord_id uuid not null references public.landlords(id) on delete cascade,
  from_tier   public.subscription_tier not null,
  to_tier     public.subscription_tier not null,
  by_admin    boolean not null default false,
  at          timestamptz not null default now()
);
create index if not exists plan_changes_landlord_idx on public.plan_changes(landlord_id, at);
alter table public.plan_changes enable row level security;
create policy plan_changes_owner_read on public.plan_changes for select to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update, delete on public.plan_changes from anon, authenticated;

create or replace function public.change_my_plan(p_tier public.subscription_tier)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_old public.subscription_tier; v_lim public.tier_limits;
        v_old_price numeric; v_units integer; v_props integer;
begin
  if v_landlord is null then raise exception 'Only an owner can change the plan' using errcode = '42501'; end if;
  select tier into v_old from public.landlords where id = v_landlord;
  if v_old = p_tier then return; end if;
  select * into v_lim from public.tier_limits where tier = p_tier;
  if v_lim.price_zar is null then raise exception 'The Agency plan is set up with Ryno-Tec. Email rentals@ryno-tec.co.za.' using errcode = 'P0001'; end if;
  select price_zar into v_old_price from public.tier_limits where tier = v_old;
  if v_old_price is null then raise exception 'Your plan is managed by Ryno-Tec. Email rentals@ryno-tec.co.za to change it.' using errcode = 'P0001'; end if;

  if v_lim.price_zar < v_old_price then           -- a downgrade
    if exists (select 1 from public.platform_invoices where landlord_id = v_landlord and status = 'open' and due_date < current_date) then
      raise exception 'Please pay your overdue invoice before moving to a smaller plan.' using errcode = 'P0001'; end if;
    select count(*) into v_units from public.units where landlord_id = v_landlord;
    select count(*) into v_props from public.properties where landlord_id = v_landlord;
    if v_lim.max_units is not null and v_units > v_lim.max_units then
      raise exception 'The % plan allows % units and you have %. Remove some units first.', v_lim.display_name, v_lim.max_units, v_units using errcode = 'P0001'; end if;
    if v_lim.max_properties is not null and v_props > v_lim.max_properties then
      raise exception 'The % plan allows % properties and you have %. Remove some first.', v_lim.display_name, v_lim.max_properties, v_props using errcode = 'P0001'; end if;
  end if;

  update public.landlords set tier = p_tier where id = v_landlord;   -- definer: passes the tier guard
  insert into public.plan_changes (landlord_id, from_tier, to_tier) values (v_landlord, v_old, p_tier);
end $$;
revoke all on function public.change_my_plan(public.subscription_tier) from public, anon;
grant execute on function public.change_my_plan(public.subscription_tier) to authenticated;

-- The subscription for a month: the highest-priced plan the owner held at any time in it.
create or replace function public.month_subscription(p_landlord uuid, p_month date)
returns table (tier public.subscription_tier, amount numeric) language sql stable security definer set search_path = public as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month')::date as e),
  held as (
    -- the plan at the end of the month: before the first change made after it, else today's plan
    select coalesce((select c.from_tier from public.plan_changes c, m where c.landlord_id = p_landlord and c.at >= m.e order by c.at limit 1),
                    (select l.tier from public.landlords l where l.id = p_landlord)) as tier
    union
    select c.from_tier from public.plan_changes c, m where c.landlord_id = p_landlord and c.at >= m.s and c.at < m.e
    union
    select c.to_tier from public.plan_changes c, m where c.landlord_id = p_landlord and c.at >= m.s and c.at < m.e
  )
  select h.tier, coalesce(case when h.tier = 'agency' then l.custom_price end, t.price_zar, l.custom_price, 0)
  from held h join public.tier_limits t on t.tier = h.tier join public.landlords l on l.id = p_landlord
  order by 2 desc limit 1
$$;
revoke all on function public.month_subscription(uuid, date) from public, anon, authenticated;

create or replace function public.generate_platform_invoices(p_month date)
returns integer language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date; r record; v_inv uuid; v_n integer := 0; v_due integer;
begin
  select invoice_due_days into v_due from public.platform_settings;
  for r in
    select l.id, s.tier, coalesce(s.amount, 0) as sub,
           coalesce((select sum(f.amount) from public.platform_fees f where f.landlord_id = l.id and f.invoice_id is null
                     and f.period_month <= v_month), 0) as fees
    from public.landlords l cross join lateral public.month_subscription(l.id, v_month) s
    where l.created_at < (v_month + interval '1 month')
      and not exists (select 1 from public.platform_invoices i where i.landlord_id = l.id and i.period_month = v_month)
  loop
    continue when r.sub + r.fees <= 0;
    insert into public.platform_invoices (number, landlord_id, period_month, tier, subscription_amount, collection_fees, total, due_date)
    values ('RTC-' || to_char(v_month, 'YYYYMM') || '-' || upper(substr(replace(r.id::text, '-', ''), 1, 6)),
            r.id, v_month, r.tier, r.sub, r.fees, r.sub + r.fees, (v_month + interval '1 month')::date + v_due)
    returning id into v_inv;
    update public.platform_fees set invoice_id = v_inv
      where landlord_id = r.id and invoice_id is null and period_month <= v_month;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.generate_platform_invoices(date) from public, anon, authenticated;
grant execute on function public.generate_platform_invoices(date) to service_role;

-- ============================================================================
-- Ryno-Tec admin
-- ============================================================================
-- Add an admin (SQL editor):  insert into public.platform_admins (user_id)
--   select id from auth.users where email = 'you@example.com';
create table if not exists public.platform_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;     -- no policies
revoke all on public.platform_admins from anon, authenticated;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;
revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

create or replace function public.require_platform_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Ryno-Tec admins only' using errcode = '42501'; end if;
end $$;

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_month date := date_trunc('month', current_date)::date; v jsonb;
begin
  perform public.require_platform_admin();
  select jsonb_build_object(
    'landlords', (select count(*) from public.landlords),
    'new_this_month', (select count(*) from public.landlords where created_at >= v_month),
    'by_tier', (select coalesce(jsonb_object_agg(tier, n), '{}') from (select tier, count(*) n from public.landlords group by tier) x),
    'properties', (select count(*) from public.properties),
    'units', (select count(*) from public.units),
    'tenants', (select count(*) from public.tenants where archived_at is null),
    'tenants_on_app', (select count(*) from public.tenants where archived_at is null and user_id is not null),
    'mrr', (select coalesce(sum(coalesce(case when l.tier = 'agency' then l.custom_price end, t.price_zar, 0)), 0)
              from public.landlords l join public.tier_limits t on t.tier = l.tier),
    'fees_this_month', (select coalesce(sum(amount), 0) from public.platform_fees where period_month = v_month),
    'online_rent_this_month', (select coalesce(sum(amount), 0) from public.online_payments where kind = 'rent' and status = 'complete' and not is_test and completed_at >= v_month),
    'online_rent_count', (select count(*) from public.online_payments where kind = 'rent' and status = 'complete' and not is_test and completed_at >= v_month),
    'ozow_connected', (select count(*) from public.ozow_accounts where enabled),
    'open_invoices', (select coalesce(sum(total), 0) from public.platform_invoices where status = 'open'),
    'overdue_invoices', (select coalesce(sum(total), 0) from public.platform_invoices where status = 'open' and due_date < current_date),
    'overdue_count', (select count(*) from public.platform_invoices where status = 'open' and due_date < current_date),
    'paid_this_month', (select coalesce(sum(total), 0) from public.platform_invoices where status = 'paid' and paid_at >= v_month),
    'alerts_7d', (select count(*) from public.payment_events where alert and at > now() - interval '7 days'),
    'settings', (select to_jsonb(s) from public.platform_settings s)
  ) into v;
  return v;
end $$;

create or replace function public.admin_landlords()
returns table (id uuid, full_name text, email text, phone text, tier public.subscription_tier, custom_price numeric,
               created_at timestamptz, properties bigint, units bigint, tenants bigint, ozow boolean,
               open_amount numeric, overdue boolean, last_sign_in timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public.require_platform_admin();
  return query
  select l.id, l.full_name, l.email, l.phone, l.tier, l.custom_price, l.created_at,
    (select count(*) from public.properties p where p.landlord_id = l.id),
    (select count(*) from public.units u where u.landlord_id = l.id),
    (select count(*) from public.tenants t where t.landlord_id = l.id and t.archived_at is null),
    exists (select 1 from public.ozow_accounts a where a.landlord_id = l.id and a.enabled),
    (select coalesce(sum(i.total), 0) from public.platform_invoices i where i.landlord_id = l.id and i.status = 'open'),
    exists (select 1 from public.platform_invoices i where i.landlord_id = l.id and i.status = 'open' and i.due_date < current_date),
    (select u.last_sign_in_at from auth.users u where u.id = l.user_id)
  from public.landlords l order by l.created_at desc;
end $$;

create or replace function public.admin_invoices()
returns table (id uuid, number text, landlord_id uuid, landlord text, period_month date, tier public.subscription_tier,
               subscription_amount numeric, collection_fees numeric, total numeric, status text, due_date date, paid_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_platform_admin();
  return query select i.id, i.number, i.landlord_id, coalesce(l.full_name, l.email), i.period_month, i.tier,
    i.subscription_amount, i.collection_fees, i.total, i.status, i.due_date, i.paid_at
  from public.platform_invoices i join public.landlords l on l.id = i.landlord_id
  order by i.period_month desc, i.number limit 500;
end $$;

create or replace function public.admin_events()
returns table (id bigint, at timestamptz, kind text, alert boolean, reference text, landlord text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_platform_admin();
  return query select e.id, e.at, e.kind, e.alert, e.reference, coalesce(l.full_name, l.email), e.detail
  from public.payment_events e left join public.landlords l on l.id = e.landlord_id
  order by e.at desc limit 200;
end $$;

create or replace function public.admin_set_invoice_status(p_invoice uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_platform_admin();
  if p_status not in ('open', 'paid', 'void') then raise exception 'Unknown status' using errcode = '22023'; end if;
  update public.platform_invoices set status = p_status, paid_at = case when p_status = 'paid' then coalesce(paid_at, now()) else null end
   where id = p_invoice;
end $$;

create or replace function public.admin_set_plan(p_landlord uuid, p_tier public.subscription_tier, p_custom_price numeric default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_old public.subscription_tier;
begin
  perform public.require_platform_admin();
  if p_custom_price is not null and p_custom_price < 0 then raise exception 'Price can’t be negative' using errcode = '22023'; end if;
  select tier into v_old from public.landlords where id = p_landlord;
  if not found then raise exception 'Landlord not found' using errcode = 'P0002'; end if;
  update public.landlords set tier = p_tier, custom_price = p_custom_price where id = p_landlord;
  if v_old <> p_tier then
    insert into public.plan_changes (landlord_id, from_tier, to_tier, by_admin) values (p_landlord, v_old, p_tier, true);
  end if;
end $$;

create or replace function public.admin_update_settings(p_fee_pct numeric, p_fee_min numeric, p_fee_max numeric, p_due_days integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_platform_admin();
  if p_fee_pct < 0 or p_fee_pct > 10 or p_fee_min < 0 or p_fee_max < p_fee_min or p_due_days not between 0 and 60 then
    raise exception 'Check the values: fee 0–10%%, cap at least the minimum, due within 60 days' using errcode = '22023'; end if;
  update public.platform_settings set collection_fee_pct = p_fee_pct, collection_fee_min = p_fee_min,
    collection_fee_max = p_fee_max, invoice_due_days = p_due_days, updated_at = now();
end $$;

create or replace function public.admin_generate_invoices(p_month date)
returns integer language plpgsql security definer set search_path = public as $$
begin
  perform public.require_platform_admin();
  if date_trunc('month', p_month) >= date_trunc('month', current_date) then
    raise exception 'Only months that have ended can be invoiced' using errcode = '22023'; end if;
  return public.generate_platform_invoices(p_month);
end $$;

revoke all on function public.require_platform_admin(), public.admin_overview(), public.admin_landlords(), public.admin_invoices(),
  public.admin_events(), public.admin_set_invoice_status(uuid, text), public.admin_set_plan(uuid, public.subscription_tier, numeric),
  public.admin_update_settings(numeric, numeric, numeric, integer), public.admin_generate_invoices(date) from public, anon;
grant execute on function public.admin_overview(), public.admin_landlords(), public.admin_invoices(),
  public.admin_events(), public.admin_set_invoice_status(uuid, text), public.admin_set_plan(uuid, public.subscription_tier, numeric),
  public.admin_update_settings(numeric, numeric, numeric, integer), public.admin_generate_invoices(date) to authenticated;

notify pgrst, 'reload schema';
