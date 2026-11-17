# Online rent payments (Ozow) and Ryno-Tec billing

**How the money flows**
- A tenant pays rent through Ozow straight into the **landlord's own** Ozow merchant account. Ryno-Tec never holds rent.
- Ryno-Tec earns the monthly plan (Starter R149 / Growth R399 / Pro R799 / Agency custom) plus a collection fee of
  **0.5% of each rent paid online, at most R75**. Both go on one invoice on the 1st for the month before.
- Owners pay that invoice through **Ryno-Tec's** Ozow account (or by EFT with the invoice number as reference).
- Fee rate, cap and due days are in `platform_settings` (one row). Change them in the Supabase table editor.

**One-off setup**
1. Run `supabase/migrations/011_payments_billing.sql` in the Supabase SQL editor.
2. Run `012_ozow_one_api.sql` too (and 013–016 in order; 016 adds Private Key + API Key accounts).
3. Supabase → Database → Extensions → enable `pg_cron`, then run the last `do $$ … $$` block of 011 again to schedule monthly invoices.
3. Supabase → Account → Access tokens → create one. GitHub repo → Settings → Secrets and variables → Actions:
   - secret `SUPABASE_ACCESS_TOKEN` (deploys the two server functions on every push)
   - Ryno-Tec's own Ozow: secret `RTC_OZOW_SITE_CODE` plus either `RTC_OZOW_CLIENT_ID` + `RTC_OZOW_CLIENT_SECRET` (One API)
     or `RTC_OZOW_PRIVATE_KEY` + `RTC_OZOW_API_KEY` (original API). Never store the Payout API Key;
     variable `RTC_OZOW_IS_TEST` = `true` only for Ozow staging credentials. The token needs Edge Functions secrets write.
4. Each landlord connects their own Ozow under **Billing & payments**.

**Server functions** (`supabase/functions`)
Ozow One API (`one.ozow.com`; staging `stagingone.ozow.com`): Client ID + Client Secret → bearer token → `POST /v1/payments`
→ redirect to `redirectUrl`. The outcome is always read from `GET /v1/payments/{id}/transactions` (`Successful` = paid).
Ozow original API (accounts issued a Private Key + API Key, `ozow_accounts.method = 'classic'`):
`POST api.ozow.com/PostPaymentRequest` with the `ApiKey` header and a SHA-512 `HashCheck` (fields in Ozow's order + Private Key,
lower-cased) → redirect to `url`. The outcome is read from `GET /GetTransactionByReference` (`Complete` = paid). Notifications'
`Hash` is checked (`bad_signature` alert if wrong), but the API answer decides. Capitec Pay recurring is One API only.
- `ozow-pay` – signed in; checks the tenant owns the rent month (or the owner the invoice), creates the Ozow payment.
- `ozow-notify` – Ozow's notify URL; only finds the payment, then asks Ozow's API for the outcome.
- `ozow-check` – the browser calls it after returning from Ozow; same check, for the person who started the payment.
`complete_online_payment` is idempotent; an amount mismatch is flagged `pending_investigation`; staging payments never touch the rent ledger.

## Checks, alerts and reconciliation
- Every result is read from Ozow's API and must match what was asked for: currency ZAR, our merchant reference,
  the site code and the amount. Anything else is held as `pending_investigation` and logged.
- `payment_events` (server-only table) logs: unknown references on the notify address, failed checks, mismatches,
  missing credentials, reconciliation differences, and (as non-alerts) payments the payer never finished.
- `.github/workflows/ozow-reconcile.yml` runs hourly (re-checks open payments, closes expired ones) and daily at
  02:43 SA time (checks every completed payment of the last 35 days against Ozow). A run that logs an alert fails,
  and GitHub emails the account that owns the schedule. Look in Supabase → Table editor → `payment_events`.
- Investigate an alert: open the payment in `online_payments` by `reference`, compare with the Ozow dashboard
  (Transactions → search the reference), then correct the rent month by hand if needed.

## Credential rotation (owner: Kagiso Tshukudu, director)
Who holds production credentials: the director only (Ozow dashboard, Supabase, GitHub). Server functions read them;
no person or browser can read them back from the app.

| Credential | Where it lives | Rotate |
|---|---|---|
| Ryno-Tec Ozow Client Secret or Private Key / API Key | GitHub secrets `RTC_OZOW_CLIENT_SECRET` or `RTC_OZOW_PRIVATE_KEY` / `RTC_OZOW_API_KEY` → Supabase function secrets | every 12 months, when someone with dashboard access leaves, or on any suspicion |
| A landlord's Ozow Client Secret or Private Key / API Key | `ozow_secrets` (write-only) | landlord's choice; they paste the new one in Billing & payments → Edit connection |
| Supabase access token (deploys) | GitHub secret `SUPABASE_ACCESS_TOKEN` | before it expires (90 days) |
| Supabase service role key | Supabase only, never copied anywhere | if exposed: Supabase → Settings → API → roll |

Steps for an Ozow secret: in the Ozow dashboard (One API Clients) create a new secret → update the GitHub secret →
push or re-run "Test and deploy" → make one small test payment → revoke the old secret in Ozow.
Ozow Dashboard access: give each person only the roles they need; keep Settlement, Refund and Banking admin to the director.

## Automatic payments (015)
- **Capitec Pay recurring** (Ozow One API recurring payments, beta): the landlord's Ozow One API client needs the
  `subscriptions` scope and Ozow must enable recurring payments on the merchant. Tenant approves once in the Capitec app
  (3-minute window); `autopay-run` (hourly) collects the month's outstanding rent on/after the due day, never above the
  approved maximum, at most one retry 3 days later, and records results through `complete_online_payment`.
- **DebiCheck** (each landlord's own Netcash account): the landlord saves their Netcash debit order service key; the tenant
  approves a DebiCheck mandate through Netcash; the landlord records the mandate reference. `autopay-run` uploads a batch
  (NIWS_NIF BatchFileUpload) on the due day; rejections from the load report are marked failed. Successful debits are confirmed
  on the landlord's Netcash statement (marked paid on the Rent page). Beta: test with one tenant first.
- **Stopping**: tenant or landlord; collections stop immediately; Ozow consent is cancelled on the next run.
- **Reminders**: `rent-reminders` (daily 07:05 SA) emails tenants via Brevo's API. Add a Brevo API key (Brevo → SMTP & API →
  API keys) as GitHub secret `BREVO_API_KEY`; the deploy copies it to Supabase (token needs Edge Functions secrets write).
- Schedule: `.github/workflows/autopay.yml`.
