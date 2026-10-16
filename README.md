# RTC Rentals

Property management for South African landlords who manage their own rentals, typically 2–25 units, without paying agent fees.

A product of **Ryno-Tec Consulting (Pty) Ltd** (Reg. 2026/818634/07).

## What works today

| Area | Status |
|---|---|
| Sign up, sign in, password reset (Supabase Auth) | Done |
| 30-day trial and plan limits (Starter 3 units, Growth 10, Pro 25), enforced in the database | Done |
| Dashboard: rent roll, occupancy, vacancy loss, unit status, units needing attention | Done |
| Properties: add, edit, delete, with SA provinces and 4-digit postal codes | Done |
| Units: add, edit, delete, quick status change, search and filter | Done |
| Demo mode with sample SA data, no backend needed | Done |
| Tenant app: rent due and pay button, payment history and receipts, repair requests with progress, messages, lease and home details | Done in demo; goes live once tenant invites and Ozow are connected |
| Tenant invites, leases and e-signing, live Ozow payments | Phase 1, next |

Database tables for tenants, leases, payments, maintenance, inspections, documents and messages already exist, so Phase 1 is mostly screens and integrations.

## How it's built

```
web/                     Static site (plain HTML, CSS, JavaScript modules; no build step)
  index.html             Sign in / create account / demo
  dashboard.html         Portfolio overview
  properties.html        Properties and units
  tenant.html            Tenant app (Home, Rent, Repairs, Messages)
  js/config.js           Supabase URL and public key (empty = demo mode)
  js/data.js             Data layer: Supabase or in-browser demo, same rules
  js/shell.js            Sidebar, modal, toasts, formatting
supabase/migrations/     Database schema and security rules
tests/db/                Schema tests on a throwaway Postgres
tests/ui/                Browser test of the whole demo flow
.github/workflows/       Test on every push; deploy main to Azure Static Web Apps
```

**Tenant access.** Tenants sign in with their own account (created from an invite, marked `role: tenant`, so they never get a landlord account). Database rules let them see only their own lease, unit, landlord contact, payments, repairs and messages. They can log repairs and send messages but can't change status, cost or anything the landlord set.

**Security model.** Every table has row-level security. A landlord's browser can only read or change that landlord's rows, and units can only attach to the same landlord's properties (enforced by a composite foreign key). Plan limits and plan changes are enforced by database triggers, so they can't be bypassed from the browser. The Supabase anon key in `config.js` is designed to be public.

## Run it locally

```bash
cd web && python3 -m http.server 8080
# open http://localhost:8080 → "Explore the demo"
```

## Go live

### 1. Supabase (database and sign-in)

1. Create a project at supabase.com. Pick the region closest to South Africa.
2. **SQL Editor** → run each file in `supabase/migrations/` in order (`001…`, then `002…`).
3. **Authentication → URL Configuration**: set **Site URL** to your live address (for example `https://rentals.ryno-tec.co.za`) and add it under **Redirect URLs**.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key.

### 2. Hosting (Azure Static Web Apps, free tier)

1. Azure portal → **Static Web Apps** → **Create**. Plan: **Free**. Deployment source: **Other**.
2. Open the new app → **Manage deployment token** → copy it.
3. In this GitHub repo → **Settings → Secrets and variables → Actions**:
   - Secret `AZURE_STATIC_WEB_APPS_API_TOKEN` = the deployment token
   - Variable `SUPABASE_URL` = Project URL
   - Variable `SUPABASE_ANON_KEY` = anon public key
4. Push to `main` (or run the workflow by hand). Tests run first; the site deploys only if they pass.

### 3. Custom domain

Static Web App → **Custom domains** → add `rentals.ryno-tec.co.za`, then create the CNAME it shows at your DNS host. Azure issues the certificate.

## Tests

```bash
tests/db/run.sh                 # schema: isolation between landlords and tenants, plan limits, one active lease per unit
python3 tests/ui/smoke_test.py  # browser: landlord and tenant demo flows, desktop and phone
```

Both run automatically in GitHub Actions.

## Roadmap

**Phase 1: core landlord loop**
1. Tenants: onboarding, ID and FICA capture, TPN credit checks
2. Leases: Rental Housing Act-compliant template, e-signing through SigniFlow
3. Rent collection: Ozow instant EFT, automatic receipts, arrears alerts by SMS and email
4. Move-in inspections with photos, landlord and tenant messaging

**Phase 2:** maintenance and contractors, deposit management, SARS-ready reports, CPI escalation, tenant app, load-shedding schedules, Property24 listings.

**Phase 3:** DebiCheck debit orders, agency accounts, Xero and Sage, rent benchmarking.

**Pricing:** Starter R149, Growth R399, Pro R799 per month; Agency on quote. Billing through PayFast.
