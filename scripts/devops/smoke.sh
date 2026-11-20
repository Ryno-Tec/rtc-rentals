#!/usr/bin/env bash
# Checks a deployed environment from the outside. Usage: smoke.sh <site url>
# Needs SUPABASE_URL and SUPABASE_ANON_KEY for the same environment; KHAPHELA_KEY is optional.
source "$(dirname "$0")/lib.sh"
SITE="${1%/}"; URL="$(clean_url "${SUPABASE_URL:-}")"; KEY="$(echo "${SUPABASE_ANON_KEY:-}" | tr -d '[:space:]')"
FAILS=0
check() { local name="$1"; shift; if "$@"; then echo "ok   $name"; else echo "FAIL $name"; FAILS=$((FAILS+1)); fi; }
code() { curl -sS -o /tmp/smoke.body -w '%{http_code}' --max-time 30 --retry 3 --retry-delay 5 --retry-all-errors "$@" || echo 000; }

# The site serves its pages and the config for this environment (CDNs can lag a minute after deploy).
site_ok() {
  for i in 1 2 3 4 5 6; do
    [ "$(code "$SITE/?smoke=$(date +%s)")" = 200 ] && grep -q '<html' /tmp/smoke.body \
      && { [ -z "$URL" ] || { [ "$(code "$SITE/js/config.js?smoke=$(date +%s)")" = 200 ] && grep -q "$URL" /tmp/smoke.body; }; } && return 0
    sleep 15
  done; return 1
}
check "site and config ($SITE)" site_ok
for p in tenant.html billing.html leases.html sw.js manifest.webmanifest; do check "page $p" test "$(code "$SITE/$p")" = 200; done

if [ -n "$URL" ] && [ -n "$KEY" ]; then
  check "database API (row-level security on)" bash -c '[ "$0" = 200 ] && [ "$(jq length /tmp/smoke.body)" = 0 ]' "$(code "$URL/rest/v1/properties?select=id&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY")"
  check "auth service" test "$(code "$URL/auth/v1/health" -H "apikey: $KEY")" = 200
  # Signed-out calls must be refused: proves the function is deployed and still checks sign-in.
  check "ozow-pay refuses anonymous" bash -c '[[ "$0" =~ ^(400|401|403)$ ]]' "$(code -X POST "$URL/functions/v1/ozow-pay" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}')"
  check "ozow-notify deployed" test "$(code "$URL/functions/v1/ozow-notify")" = 405
  if [ -n "${KHAPHELA_KEY:-}" ]; then
    check "ops-health" bash -c '[ "$0" = 200 ] && jq -e . /tmp/smoke.body >/dev/null' "$(code -X POST "$URL/functions/v1/ops-health" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "x-khaphela-key: $KHAPHELA_KEY")"
  fi
fi
[ "$FAILS" = 0 ] || fail "$FAILS smoke check(s) failed for $SITE"
echo "All smoke checks passed for $SITE"
