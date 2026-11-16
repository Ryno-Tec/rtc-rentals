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
- Store readiness: privacy and account-deletion page, store screenshots, Android build config
  (Google Play and Huawei AppGallery), guide in docs/APP-STORES.md.

## Next: tenant onboarding (requested 16 Nov 2026)
1. **Owner sends a registration request.** Owner enters the tenant's email or phone; the tenant gets a
   one-time invite link tied to their lease.
2. **Sign in with a trusted provider.** Google, Apple and Microsoft through Supabase Auth, as well as
   email. Needs an OAuth app per provider (Apple needs the paid developer account).
3. **PIN or password.** Tenant sets a password or a 6-digit app PIN for quick unlock.
4. **Biometrics.** Fingerprint / Face unlock with passkeys (WebAuthn), which works in the installed app
   on Android, iOS and Huawei.
5. **Profile with a required photo.** Stored in a private Supabase Storage bucket.
6. **Lease loads automatically.** After registering, the tenant sees the lease the owner attached.
7. **Secure lease signing.** Tenant and owner sign in the app; witnesses sign through a secure,
   expiring link without creating an account. Each signature records name, time, IP and a hash of
   the document (Electronic Communications and Transactions Act: ordinary electronic signatures
   are valid for residential leases).
8. **SARS-ready reports.** Owner: rental income and expenses per tax year (1 March to end February)
   for the ITR12 rental schedule. Tenant: a rent-paid statement for the year on request.

## Later
- Ozow rent payments with automatic reconciliation.
- Publish to Google Play and Huawei AppGallery (needs D-U-N-S and developer accounts); iOS app with Capacitor.
