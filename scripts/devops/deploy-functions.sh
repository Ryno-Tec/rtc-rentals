#!/usr/bin/env bash
# Deploys the Edge Functions and copies server-only settings to one Supabase project.
# Needs SUPABASE_ACCESS_TOKEN and SUPABASE_URL. Optional secrets are set only when present.
source "$(dirname "$0")/lib.sh"
[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || { note "SUPABASE_ACCESS_TOKEN not set; server functions not deployed."; exit 0; }
REF="$(project_ref "${SUPABASE_URL:?SUPABASE_URL missing}")"
echo "Project: $REF"
supabase functions deploy ozow-pay --yes --project-ref "$REF" --use-api
supabase functions deploy ozow-notify --yes --project-ref "$REF" --no-verify-jwt --use-api
for f in ozow-check ozow-reconcile autopay-setup autopay-check autopay-run rent-reminders ops-health; do
  supabase functions deploy "$f" --yes --project-ref "$REF" --use-api
done
SET=()
if [ -n "${RTC_OZOW_SITE_CODE:-}" ] && [ -n "${RTC_OZOW_CLIENT_ID:-}" ] && [ -n "${RTC_OZOW_CLIENT_SECRET:-}" ]; then
  SET+=("RTC_OZOW_SITE_CODE=$RTC_OZOW_SITE_CODE" "RTC_OZOW_CLIENT_ID=$RTC_OZOW_CLIENT_ID" "RTC_OZOW_CLIENT_SECRET=$RTC_OZOW_CLIENT_SECRET" "RTC_OZOW_IS_TEST=${RTC_OZOW_IS_TEST:-false}")
elif [ -n "${RTC_OZOW_SITE_CODE:-}" ] && [ -n "${RTC_OZOW_PRIVATE_KEY:-}" ] && [ -n "${RTC_OZOW_API_KEY:-}" ]; then
  SET+=("RTC_OZOW_SITE_CODE=$RTC_OZOW_SITE_CODE" "RTC_OZOW_PRIVATE_KEY=$RTC_OZOW_PRIVATE_KEY" "RTC_OZOW_API_KEY=$RTC_OZOW_API_KEY" "RTC_OZOW_IS_TEST=${RTC_OZOW_IS_TEST:-false}")
fi
[ -n "${BREVO_API_KEY:-}" ] && SET+=("BREVO_API_KEY=$BREVO_API_KEY")
[ -n "${KHAPHELA_KEY:-}" ] && SET+=("KHAPHELA_KEY=$KHAPHELA_KEY")
[ -n "${SITE_URL:-}" ] && SET+=("SITE_URL=$SITE_URL")
if [ ${#SET[@]} -gt 0 ]; then supabase secrets set --project-ref "$REF" "${SET[@]}"; else note "No server secrets to set."; fi
