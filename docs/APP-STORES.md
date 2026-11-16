# Getting RTC Rentals into the app stores

The app is one website (rentals.ryno-tec.co.za) that is already installable from the browser on
Android, iPhone and Huawei. The store versions wrap the same site, so every update to the site
reaches the store apps at once, without a new store release.

| Store | Package | Account | Cost | Notes |
|---|---|---|---|---|
| Google Play | Android App Bundle (.aab), Trusted Web Activity | Organisation: Ryno-Tec Consulting (Pty) Ltd | USD 25 once | Needs a D-U-N-S number (free) |
| Huawei AppGallery | Same Android build as an .apk | Enterprise developer (business licence or D-U-N-S) | Free | Opens in a built-in web view on Huawei phones without Google services |
| Apple App Store | iOS app (Capacitor wrapper) | Organisation | USD 99 a year | Needs a Mac (or a cloud Mac build) and native features to pass review |

## Before any store: one-off company steps

1. **Get a D-U-N-S number** for Ryno-Tec Consulting (Pty) Ltd. It is free from Dun & Bradstreet
   (Apple's enrolment page has a lookup and request form). Use the company name exactly as on the
   CIPC certificate. Allow a week or more.
2. **Use a shared mailbox** such as apps@ryno-tec.co.za for the store accounts, not a personal address.
3. **Privacy policy and account deletion** are live: https://rentals.ryno-tec.co.za/privacy.html
   and https://rentals.ryno-tec.co.za/privacy.html#delete. All three stores ask for these URLs.
4. **Screenshots** are in `web/screenshots/` (phone 1080x2338, and one wide).

## Google Play (Android)

1. Create the Play Console organisation account (USD 25, D-U-N-S, ID verification).
2. Build the app with Bubblewrap (needs Node and a Java JDK; on any PC or in Cloud Shell):
   ```
   npm i -g @bubblewrap/cli
   cd store
   bubblewrap init --manifest https://rentals.ryno-tec.co.za/manifest.webmanifest   # or: bubblewrap update (uses twa-manifest.json)
   bubblewrap build
   ```
   It creates the signing key `rtc-rentals-upload.keystore` the first time. **Back it up and keep it
   private** (password manager plus an offline copy). Never commit it; `store/.gitignore` blocks it.
3. Get the SHA-256 fingerprints: `bubblewrap fingerprint list`, plus the "App signing key
   certificate" fingerprint from Play Console (Setup > App signing) after the first upload.
4. In GitHub: Ryno-Tec/rtc-rentals > Settings > Secrets and variables > Actions > Variables, add
   `ANDROID_CERT_SHA256` with both fingerprints separated by a comma. The next deploy publishes
   `/.well-known/assetlinks.json`, which makes the app open full-screen without a browser bar.
5. Upload `app-release-bundle.aab` to a closed test first, then production. Fill in the Data
   safety form (account info, name, email, phone, photos; encrypted in transit; deletion on request;
   no data shared with third parties, no ads).

## Huawei AppGallery

1. Register at developer.huawei.com and verify Ryno-Tec as an enterprise (business licence or D-U-N-S).
2. Upload `app-release-signed.apk` from the same Bubblewrap build. `twa-manifest.json` sets
   `fallbackType: webview`, so on Huawei phones without Chrome the app runs in a built-in web view.
3. Add the same listing, screenshots and privacy URL.

## Apple App Store (iPhone and iPad)

Apple rejects apps that are only a website in a frame (App Review Guideline 4.2), so the iOS app
should be built with Capacitor and use native features that make it more than the site:
Face ID / Touch ID unlock, the camera for inspection and repair photos, and push notifications for
rent due, lease signing and job updates. This is the planned next step after biometrics and push
notifications are in the web app. Until then, iPhone users install from Safari: Share > Add to
Home Screen (the app shows them how).

Needs: Apple Developer Program as an organisation (USD 99 a year, D-U-N-S), a Mac with Xcode or a
cloud build service, and an App Store Connect listing with the same privacy URL.
