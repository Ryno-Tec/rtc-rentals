# Sign in with Google, Apple and Microsoft

The buttons appear on the sign-in page and on tenant and maintenance invite pages as soon as a
provider is switched on in Supabase. Nothing in the app needs changing.

Supabase callback URL (used by all three):
`https://ubxtpreeyenwdsybjemd.supabase.co/auth/v1/callback`

Before any of them: Supabase > **Authentication > URL Configuration**: Site URL
`https://rentals.ryno-tec.co.za`, Redirect URLs `https://rentals.ryno-tec.co.za/**`.

## Google (free)

1. console.cloud.google.com > new project "RTC Rentals".
2. **APIs & Services > OAuth consent screen** (Google Auth Platform > Branding): app name
   RTC Rentals, support email rentals@ryno-tec.co.za, logo, home page
   https://rentals.ryno-tec.co.za, privacy policy https://rentals.ryno-tec.co.za/privacy.html,
   authorised domain `ryno-tec.co.za`. Audience: External. Publish the app (scopes are only
   email and profile, so no Google review is needed).
3. **Credentials > Create credentials > OAuth client ID**, type Web application.
   Authorised JavaScript origin `https://rentals.ryno-tec.co.za`; authorised redirect URI = the
   Supabase callback above.
4. Supabase > **Authentication > Sign In / Providers > Google**: paste the Client ID and Client
   secret, turn it on.

## Apple (needs the Apple Developer account)

1. developer.apple.com > **Certificates, Identifiers & Profiles > Identifiers**: create an App ID
   (e.g. `za.co.rynotec.rentals`) with **Sign in with Apple** ticked.
2. Create a **Services ID** (e.g. `za.co.rynotec.rentals.web`), tick Sign in with Apple >
   Configure: primary App ID from step 1, domain `ubxtpreeyenwdsybjemd.supabase.co` and
   `rentals.ryno-tec.co.za`, return URL = the Supabase callback.
3. **Keys**: create a key with Sign in with Apple, download the `.p8` file (only once) and note the
   Key ID and your Team ID (top right of the developer site).
4. Supabase > **Providers > Apple**: Client IDs = the Services ID (and the App ID, for the iPhone
   app later); use Supabase's tool to turn the Team ID, Key ID and `.p8` into the secret. Turn it on.
5. **Renew the Apple secret every 6 months** (Apple limits it). Put a reminder in the hub.

## Microsoft (Entra ID, free): same standard as Google

1. entra.microsoft.com (Ryno-Tec tenant) > **App registrations > New registration**: name
   **RTC Rentals**; account types **Accounts in any organisational directory and personal
   Microsoft accounts**; redirect URI (Web) = the Supabase callback above.
2. **Branding & properties** (what people see on Microsoft's consent screen, like Google's branding page):
   logo (the RTC Rentals icon, 215×215 PNG), home page `https://rentals.ryno-tec.co.za`,
   terms of service and privacy `https://rentals.ryno-tec.co.za/privacy.html`,
   **publisher domain** `ryno-tec.co.za` (already verified in your M365 tenant).
3. **Publisher verification** (the blue "verified" tick, Microsoft's equivalent of Google's
   verified app): Branding & properties > *Add MPN ID to verify publisher*, enter Ryno-Tec's
   Microsoft AI Cloud Partner Program **Partner ID**. Needs a work account in the same tenant.
4. **Token configuration > Add optional claim > ID**: tick **email** and **xms_edov** (lets
   Supabase know whether Microsoft verified the email's domain). Accept adding the Graph
   email permission when asked.
5. **API permissions**: Microsoft Graph delegated `openid`, `email`, `profile`, `User.Read`
   only. No admin consent needed.
6. **Certificates & secrets**: new client secret, 24 months; copy the **Value**.
7. Supabase > **Authentication > Sign In / Providers > Azure**: Application (client) ID, secret
   value, Azure Tenant URL `https://login.microsoftonline.com/common` (work, school and personal
   accounts). Turn it on; the button appears by itself.
8. Button artwork: download Microsoft's sign-in logo from the identity platform branding
   guidelines and save it as `web/icons/microsoft-logo.svg`.
9. Renew the client secret before it expires (calendar reminder; same as the Apple secret).

## How invited people are handled

Someone who taps "Continue with Google" on a tenant or maintenance invite comes back to the same
invite link, and the app links their account to the record the owner made. (A first Google or
Apple sign-in briefly opens an empty owner account; the invite removes it. An owner account
with anything in it is never removed, and that person is asked to use a different email.)
