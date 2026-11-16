#!/usr/bin/env bash
# Creates the "RTC Rentals" Microsoft sign-in app in the Ryno-Tec Entra tenant, set up to the same
# standard as the Google one: branding, privacy/terms links, verified-email claim (xms_edov),
# least-privilege sign-in permissions, and a 24-month client secret for Supabase.
#
# Run on your Mac (needs the Azure CLI: brew install azure-cli):
#   az login --tenant ryno-tec.co.za --allow-no-subscriptions
#   bash scripts/entra-create-app.sh
# Optional: MPN_ID=1234567 bash scripts/entra-create-app.sh   (publisher verification, blue tick)
#
# Safe to re-run: it reuses an existing "RTC Rentals" app and only adds a new secret.
set -euo pipefail

NAME="RTC Rentals"
SITE="https://rentals.ryno-tec.co.za"
CALLBACK="https://ubxtpreeyenwdsybjemd.supabase.co/auth/v1/callback"
GRAPH="00000003-0000-0000-c000-000000000000"
G="https://graph.microsoft.com/v1.0"

command -v az >/dev/null || { echo "Install the Azure CLI first: brew install azure-cli"; exit 1; }
az account show >/dev/null 2>&1 || { echo "Sign in first: az login --tenant ryno-tec.co.za --allow-no-subscriptions"; exit 1; }
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Tenant: $TENANT_ID"

APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  echo "Creating the app registration…"
  # Created for work/school accounts first: personal Microsoft accounts need v2 tokens set before the audience can include them.
  APP_ID=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMultipleOrgs \
    --web-redirect-uris "$CALLBACK" --web-home-page-url "$SITE" --query appId -o tsv)
else
  echo "Found existing app $APP_ID; updating it."
fi
OBJ_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)

echo "Tokens v2, then work, school and personal Microsoft accounts…"
az rest --method PATCH --url "$G/applications/$OBJ_ID" --headers "Content-Type=application/json" \
  --body '{"api":{"requestedAccessTokenVersion":2}}' >/dev/null
az rest --method PATCH --url "$G/applications/$OBJ_ID" --headers "Content-Type=application/json" \
  --body '{"signInAudience":"AzureADandPersonalMicrosoftAccount"}' >/dev/null

echo "Redirect URI, branding links, sign-in only permissions, email + xms_edov claims…"
az rest --method PATCH --url "$G/applications/$OBJ_ID" --headers "Content-Type=application/json" --body "{
  \"web\": { \"redirectUris\": [\"$CALLBACK\"], \"homePageUrl\": \"$SITE\",
             \"implicitGrantSettings\": { \"enableIdTokenIssuance\": false, \"enableAccessTokenIssuance\": false } },
  \"info\": { \"marketingUrl\": \"$SITE\", \"supportUrl\": \"$SITE/help.html\",
              \"privacyStatementUrl\": \"$SITE/privacy.html\", \"termsOfServiceUrl\": \"$SITE/privacy.html\" },
  \"requiredResourceAccess\": [{ \"resourceAppId\": \"$GRAPH\", \"resourceAccess\": [
      { \"id\": \"37f7f235-527c-4136-accd-4a02d197296e\", \"type\": \"Scope\" },
      { \"id\": \"64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0\", \"type\": \"Scope\" },
      { \"id\": \"14dad69e-099b-42c9-810b-d002981feec1\", \"type\": \"Scope\" },
      { \"id\": \"e1fe6dd8-ba31-4d61-89e7-88639da4683d\", \"type\": \"Scope\" } ] }],
  \"optionalClaims\": {
    \"idToken\": [ { \"name\": \"email\", \"essential\": false }, { \"name\": \"xms_edov\", \"essential\": false } ],
    \"accessToken\": [ { \"name\": \"email\", \"essential\": false }, { \"name\": \"xms_edov\", \"essential\": false } ],
    \"saml2Token\": [] }
}" >/dev/null
# (Graph delegated: openid, email, profile, User.Read; no admin consent needed.)

echo "Logo…"
LOGO=$(mktemp -t rtc-logo).png
curl -fsSL "$SITE/icons/entra-logo-215.png" -o "$LOGO"
az rest --method PUT --url "$G/applications/$OBJ_ID/logo" --headers "Content-Type=image/png" --body "@$LOGO" >/dev/null \
  || echo "  (logo upload skipped; add it under Branding & properties)"
rm -f "$LOGO"

echo "Enterprise app (service principal)…"
az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null

if [ -n "${MPN_ID:-}" ]; then
  echo "Publisher verification with Partner ID $MPN_ID…"
  az rest --method POST --url "$G/applications/$OBJ_ID/setVerifiedPublisher" --headers "Content-Type=application/json" \
    --body "{\"verifiedPublisherId\":\"$MPN_ID\"}" >/dev/null \
    && echo "  Verified." \
    || echo "  Not verified yet: set the publisher domain to ryno-tec.co.za under Branding & properties, then run again with MPN_ID."
fi

END=$(date -u -v+24m +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+24 months' +%Y-%m-%dT%H:%M:%SZ)
SECRET=$(az ad app credential reset --id "$APP_ID" --append --display-name "Supabase $(date +%Y-%m)" \
  --end-date "$END" --query password -o tsv)

cat <<OUT

Done. Put these in Supabase > Authentication > Sign In / Providers > Azure, then turn it on:
  Application (client) ID : $APP_ID
  Secret value            : $SECRET
  Azure Tenant URL        : https://login.microsoftonline.com/common
The secret is shown only now. It expires $END: put a reminder in your calendar.

Still in the portal (Branding & properties): Publisher domain = ryno-tec.co.za, then rerun with MPN_ID for the blue tick.
OUT
