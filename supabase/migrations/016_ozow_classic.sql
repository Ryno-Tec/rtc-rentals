-- 016: Ozow accounts that come with a Private Key and API Key (Ozow's original API) work alongside
-- One API accounts (Client ID + Client Secret). Ozow decides which kind a merchant gets.
--   classic: payment created server-side at api.ozow.com/PostPaymentRequest (ApiKey header + SHA-512
--            HashCheck with the Private Key); outcome read back from GetTransactionByReference.
--   one:     unchanged (012).
-- The Payout API Key is never asked for or stored: RTC Rentals doesn't send payouts.
-- Safe to run more than once.

alter table public.ozow_accounts add column if not exists method text not null default 'one';
do $$ begin
  alter table public.ozow_accounts add constraint ozow_accounts_method_chk check (method in ('one', 'classic'));
exception when duplicate_object then null; end $$;

-- One API: also clears any classic keys when an owner switches over.
create or replace function public.save_ozow_account(p_site_code text, p_client_id text, p_client_secret text, p_is_test boolean, p_enabled boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id();
        v_id text := nullif(trim(coalesce(p_client_id, '')), '');
        v_secret text := nullif(trim(coalesce(p_client_secret, '')), '');
        v_has boolean;
begin
  perform public.require_account_admin();
  if coalesce(trim(p_site_code), '') !~ '^[A-Za-z0-9-]{3,50}$' then raise exception 'Enter the Site Code from your Ozow dashboard (Sites)' using errcode = '22023'; end if;
  select s.client_id is not null and s.client_secret is not null into v_has
    from public.ozow_secrets s join public.ozow_accounts a using (landlord_id) where s.landlord_id = v_landlord and a.method = 'one';
  if not coalesce(v_has, false) and (v_id is null or v_secret is null) then
    raise exception 'Enter the Client ID and Client Secret from your Ozow dashboard (One API Clients)' using errcode = '22023'; end if;
  if v_secret is not null and length(v_secret) < 16 then raise exception 'That Client Secret looks too short' using errcode = '22023'; end if;
  insert into public.ozow_accounts (landlord_id, site_code, is_test, enabled, key_hint, method, updated_at)
  values (v_landlord, trim(p_site_code), coalesce(p_is_test, false), coalesce(p_enabled, true), right(v_secret, 4), 'one', now())
  on conflict (landlord_id) do update set site_code = excluded.site_code, is_test = excluded.is_test, enabled = excluded.enabled,
    key_hint = coalesce(excluded.key_hint, ozow_accounts.key_hint), method = 'one', updated_at = now();
  insert into public.ozow_secrets (landlord_id, client_id, client_secret) values (v_landlord, v_id, v_secret)
  on conflict (landlord_id) do update set client_id = coalesce(excluded.client_id, ozow_secrets.client_id),
    client_secret = coalesce(excluded.client_secret, ozow_secrets.client_secret), private_key = null, api_key = null;
end $$;
revoke all on function public.save_ozow_account(text, text, text, boolean, boolean) from public, anon;
grant execute on function public.save_ozow_account(text, text, text, boolean, boolean) to authenticated;

-- Private Key + API Key (Ozow dashboard → Merchant details). Leave a key empty to keep the saved one.
create or replace function public.save_ozow_classic(p_site_code text, p_private_key text, p_api_key text, p_is_test boolean, p_enabled boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id();
        v_key text := nullif(trim(coalesce(p_private_key, '')), '');
        v_api text := nullif(trim(coalesce(p_api_key, '')), '');
        v_has boolean;
begin
  perform public.require_account_admin();
  if coalesce(trim(p_site_code), '') !~ '^[A-Za-z0-9-]{3,50}$' then raise exception 'Enter the Site Code from your Ozow dashboard (Sites)' using errcode = '22023'; end if;
  select s.private_key is not null and s.api_key is not null into v_has
    from public.ozow_secrets s join public.ozow_accounts a using (landlord_id) where s.landlord_id = v_landlord and a.method = 'classic';
  if not coalesce(v_has, false) and (v_key is null or v_api is null) then
    raise exception 'Enter the Private Key and API Key from your Ozow dashboard (Merchant details)' using errcode = '22023'; end if;
  if v_key is not null and (length(v_key) < 16 or v_key ~ '\s') then raise exception 'That Private Key doesn’t look right' using errcode = '22023'; end if;
  if v_api is not null and (length(v_api) < 16 or v_api ~ '\s') then raise exception 'That API Key doesn’t look right' using errcode = '22023'; end if;
  if v_key is not null and v_key = v_api then raise exception 'The Private Key and API Key are different keys. Check you copied each one.' using errcode = '22023'; end if;
  insert into public.ozow_accounts (landlord_id, site_code, is_test, enabled, key_hint, method, updated_at)
  values (v_landlord, trim(p_site_code), coalesce(p_is_test, false), coalesce(p_enabled, true), right(v_key, 4), 'classic', now())
  on conflict (landlord_id) do update set site_code = excluded.site_code, is_test = excluded.is_test, enabled = excluded.enabled,
    key_hint = coalesce(excluded.key_hint, ozow_accounts.key_hint), method = 'classic', updated_at = now();
  insert into public.ozow_secrets (landlord_id, private_key, api_key) values (v_landlord, v_key, v_api)
  on conflict (landlord_id) do update set private_key = coalesce(excluded.private_key, ozow_secrets.private_key),
    api_key = coalesce(excluded.api_key, ozow_secrets.api_key), client_id = null, client_secret = null;
  -- Capitec Pay recurring is a One API feature.
  update public.autopay_settings set ozow_capitec = false where landlord_id = v_landlord;
end $$;
revoke all on function public.save_ozow_classic(text, text, text, boolean, boolean) from public, anon;
grant execute on function public.save_ozow_classic(text, text, text, boolean, boolean) to authenticated;

-- Capitec Pay recurring needs a One API connection.
create or replace function public.save_autopay_settings(p_ozow_capitec boolean, p_netcash boolean, p_netcash_service_key text, p_reminders boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_key text := nullif(trim(coalesce(p_netcash_service_key, '')), '');
begin
  perform public.require_account_admin();
  if coalesce(p_ozow_capitec, false) and not exists (select 1 from public.ozow_accounts where landlord_id = v_landlord and enabled) then
    raise exception 'Connect Ozow first (Online rent payments)' using errcode = '22023'; end if;
  if coalesce(p_ozow_capitec, false) and exists (select 1 from public.ozow_accounts where landlord_id = v_landlord and method = 'classic') then
    raise exception 'Capitec Pay recurring needs Ozow One API details (Client ID and Client Secret). Ask Ozow for them.' using errcode = '22023'; end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'That Netcash service key doesn’t look right' using errcode = '22023'; end if;
  if coalesce(p_netcash, false) and v_key is null and not exists (select 1 from public.netcash_secrets where landlord_id = v_landlord) then
    raise exception 'Enter your Netcash debit order service key' using errcode = '22023'; end if;
  insert into public.autopay_settings (landlord_id, ozow_capitec, netcash, netcash_hint, reminders, updated_at)
  values (v_landlord, coalesce(p_ozow_capitec, false), coalesce(p_netcash, false), right(v_key, 4), coalesce(p_reminders, true), now())
  on conflict (landlord_id) do update set ozow_capitec = excluded.ozow_capitec, netcash = excluded.netcash,
    netcash_hint = coalesce(excluded.netcash_hint, autopay_settings.netcash_hint), reminders = excluded.reminders, updated_at = now();
  if v_key is not null then
    insert into public.netcash_secrets (landlord_id, service_key) values (v_landlord, v_key)
    on conflict (landlord_id) do update set service_key = excluded.service_key;
  end if;
end $$;

-- Notifications whose signature doesn't match the Private Key are logged as alerts.
alter table public.payment_events drop constraint if exists payment_events_kind_check;
alter table public.payment_events add constraint payment_events_kind_check
  check (kind in ('unknown_reference', 'check_failed', 'mismatch', 'credentials', 'reconcile_mismatch', 'expired', 'autopay', 'reminder', 'bad_signature'));

notify pgrst, 'reload schema';
