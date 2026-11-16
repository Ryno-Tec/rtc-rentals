# Online rent payments (Ozow) and Ryno-Tec billing

**How the money flows**
- A tenant pays rent through Ozow straight into the **landlord's own** Ozow merchant account. Ryno-Tec never holds rent.
- Ryno-Tec earns the monthly plan (Starter R149 / Growth R399 / Pro R799 / Agency custom) plus a collection fee of
  **0.5% of each rent paid online, at most R75**. Both go on one invoice on the 1st for the month before.
- Owners pay that invoice through **Ryno-Tec's** Ozow account (or by EFT with the invoice number as reference).
- Fee rate, cap and due days are in `platform_settings` (one row). Change them in the Supabase table editor.

**One-off setup**
1. Run `supabase/migrations/011_payments_billing.sql` in the Supabase SQL editor.
2. Run `012_ozow_one_api.sql` too.
3. Supabase → Database → Extensions → enable `pg_cron`, then run the last `do $$ … $$` block of 011 again to schedule monthly invoices.
3. Supabase → Account → Access tokens → create one. GitHub repo → Settings → Secrets and variables → Actions:
   - secret `SUPABASE_ACCESS_TOKEN` (deploys the two server functions on every push)
   - Ryno-Tec's own Ozow (One API): secrets `RTC_OZOW_SITE_CODE`, `RTC_OZOW_CLIENT_ID`, `RTC_OZOW_CLIENT_SECRET`;
     variable `RTC_OZOW_IS_TEST` = `true` only for Ozow staging credentials. The token needs Edge Functions secrets write.
4. Each landlord connects their own Ozow under **Billing & payments**.

**Server functions** (`supabase/functions`)
Ozow One API (`one.ozow.com`; staging `stagingone.ozow.com`): Client ID + Client Secret → bearer token → `POST /v1/payments`
→ redirect to `redirectUrl`. The outcome is always read from `GET /v1/payments/{id}/transactions` (`Successful` = paid).
- `ozow-pay` – signed in; checks the tenant owns the rent month (or the owner the invoice), creates the Ozow payment.
- `ozow-notify` – Ozow's notify URL; only finds the payment, then asks Ozow's API for the outcome.
- `ozow-check` – the browser calls it after returning from Ozow; same check, for the person who started the payment.
`complete_online_payment` is idempotent; an amount mismatch is flagged `pending_investigation`; staging payments never touch the rent ledger.
