-- 012: Ozow One API. New Ozow merchants get a Client ID and Client Secret (Dashboard > One API Clients)
-- instead of the old Private Key. Payments are created through one.ozow.com and confirmed by asking
-- Ozow for the payment's transactions, so nothing a browser or a caller sends is trusted.
-- Test mode = Ozow's staging environment (stagingone.ozow.com, separate credentials from Ozow support).

alter table public.ozow_secrets add column if not exists client_id text;
alter table public.ozow_secrets add column if not exists client_secret text;
alter table public.ozow_secrets alter column private_key drop not null;
alter table public.online_payments add column if not exists ozow_payment_id text;
create index if not exists online_payments_ozow_idx on public.online_payments(ozow_payment_id);

drop function if exists public.save_ozow_account(text, text, text, boolean, boolean);
create or replace function public.save_ozow_account(p_site_code text, p_client_id text, p_client_secret text, p_is_test boolean, p_enabled boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id();
        v_id text := nullif(trim(coalesce(p_client_id, '')), '');
        v_secret text := nullif(trim(coalesce(p_client_secret, '')), '');
        v_has boolean;
begin
  if v_landlord is null then raise exception 'Only an owner can connect Ozow' using errcode = '42501'; end if;
  if coalesce(trim(p_site_code), '') !~ '^[A-Za-z0-9-]{3,50}$' then raise exception 'Enter the Site Code from your Ozow dashboard (Sites)' using errcode = '22023'; end if;
  select client_id is not null and client_secret is not null into v_has from public.ozow_secrets where landlord_id = v_landlord;
  if not coalesce(v_has, false) and (v_id is null or v_secret is null) then
    raise exception 'Enter the Client ID and Client Secret from your Ozow dashboard (One API Clients)' using errcode = '22023'; end if;
  if v_secret is not null and length(v_secret) < 16 then raise exception 'That Client Secret looks too short' using errcode = '22023'; end if;
  insert into public.ozow_accounts (landlord_id, site_code, is_test, enabled, key_hint, updated_at)
  values (v_landlord, trim(p_site_code), coalesce(p_is_test, false), coalesce(p_enabled, true), right(v_secret, 4), now())
  on conflict (landlord_id) do update set site_code = excluded.site_code, is_test = excluded.is_test, enabled = excluded.enabled,
    key_hint = coalesce(excluded.key_hint, ozow_accounts.key_hint), updated_at = now();
  insert into public.ozow_secrets (landlord_id, client_id, client_secret) values (v_landlord, v_id, v_secret)
  on conflict (landlord_id) do update set client_id = coalesce(excluded.client_id, ozow_secrets.client_id),
    client_secret = coalesce(excluded.client_secret, ozow_secrets.client_secret);
end $$;
revoke all on function public.save_ozow_account(text, text, text, boolean, boolean) from public, anon;
grant execute on function public.save_ozow_account(text, text, text, boolean, boolean) to authenticated;

-- Live is the default from now on: a "test" connection only works with Ozow staging credentials.
alter table public.ozow_accounts alter column is_test set default false;
