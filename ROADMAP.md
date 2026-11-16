# RTC Rentals roadmap

Goal: simplify rental management for property owners and tenants. One database, two separate
experiences (owner and tenant), enforced by row-level security.

## Done
- Owner side: properties, units, tenants and leases, rent ledger, receipts and statements.
- Tenant side: rent due, payment history, repairs, messages, lease and home details.
- Owner/tenant separation on the same database (tenants only ever see their own lease).
- Tenant invites: the owner sends a one-time registration link; the tenant registers and their lease loads.
- Installable app (PWA) for Android, iPhone/iPad and Huawei; light Ryno-Tec theme.
- In-app lease (plain language, based on the standard SA residential lease) with e-signatures,
  witnesses in person or by one-time link, and a SHA-256 fingerprint of the signed text.
- Move-in, move-out and routine inspections: room-by-room checklist, photos, both parties confirm.
- Maintenance: faults per property, a maintenance team with their own login and job app,
  tenant sees who's coming and progress; employment contract for directly employed staff.
- App lock: 6-digit PIN and fingerprint/face unlock (WebAuthn platform authenticator) on each
  device; locks on reopen or after idle; 5 wrong PINs signs out.
- Profile photo, required for tenants and maintenance people before they use the app.
- SARS-ready tax reports: rental income and expenses per property per tax year (ITR12 rental
  section), CSV and print; tenants get a tax-year statement of rent paid.
- Sign in with Google, Apple and Microsoft (shown once switched on in Supabase), including from
  invite links; guide in docs/SOCIAL-SIGN-IN.md.
- Store readiness: privacy and account-deletion page, store screenshots, Android build config
  (Google Play and Huawei AppGallery), guide in docs/APP-STORES.md.

## Next
- Publish to Google Play, Huawei AppGallery and the App Store (iPhone app with Capacitor: camera,
  Face ID, push notifications).

## Later
- Ozow rent payments with automatic reconciliation.
