# Online rent payments (Ozow) and Ryno-Tec billing

**How the money flows**
- A tenant pays rent through Ozow straight into the **landlord's own** Ozow merchant account. Ryno-Tec never holds rent.
- Ryno-Tec earns the monthly plan (Starter R149 / Growth R399 / Pro R799 / Agency custom) plus a collection fee of
  **0.5% of each rent paid online, at most R75**. Both go on one invoice on the 1st for the month before.
- Owners pay that invoice through **Ryno-Tec's** Ozow account (or by EFT with the invoice number as reference).
- Fee rate, cap and due days are in `platform_settings` (one row). Change them in the Supabase table editor.

**One-off setup**
1. Run `supabase/migrations/011_payments_billing.sql` in the Supabase SQL editor.
2. Supabase → Database → Extensions → enable `pg_cron`, then run the last `do $$ … $$` block of 011 again to schedule monthly invoices.
3. Supabase → Account → Access tokens → create one. GitHub repo → Settings → Secrets and variables → Actions:
   - secret `SUPABASE_ACCESS_TOKEN` (deploys the two server functions on every push)
   - once Ryno-Tec's own Ozow account is approved: secrets `RTC_OZOW_SITE_CODE`, `RTC_OZOW_PRIVATE_KEY`; variable `RTC_OZOW_IS_TEST` = `false` when live.
4. Each landlord connects their own Ozow under **Billing & payments**.

**Server functions** (`supabase/functions`)
- `ozow-pay` – signed in; checks the tenant owns the rent month (or the owner the invoice), signs the Ozow request server-side.
- `ozow-notify` – Ozow's notify URL; verifies Ozow's hash with the right private key, then calls `complete_online_payment`
  (idempotent; an amount mismatch is flagged `pending_investigation`; test-mode payments never touch the rent ledger).
