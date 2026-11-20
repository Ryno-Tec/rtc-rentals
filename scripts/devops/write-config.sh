#!/usr/bin/env bash
# Writes web/js/config.js for one environment. Usage: write-config.sh <production|staging>
# Needs SUPABASE_URL and SUPABASE_ANON_KEY (public values). Without them the site runs in demo mode.
source "$(dirname "$0")/lib.sh"
ENV_NAME="${1:-production}"
URL="$(clean_url "${SUPABASE_URL:-}")"; KEY="$(echo "${SUPABASE_ANON_KEY:-}" | tr -d '[:space:]')"
if [ -z "$URL" ] || [ -z "$KEY" ]; then note "SUPABASE_URL / SUPABASE_ANON_KEY not set for $ENV_NAME; site deploys in demo mode."; exit 0; fi
echo "Supabase project ($ENV_NAME): $URL"
cat > web/js/config.js <<CFG
export const config = {
  supabaseUrl: '${URL}',
  supabaseAnonKey: '${KEY}',
  env: '${ENV_NAME}',
};
if (typeof document !== 'undefined' && config.env !== 'production') document.documentElement.dataset.env = config.env;
CFG
if [ "$ENV_NAME" != production ]; then
  # Keep staging out of search engines and away from the store apps.
  printf 'User-agent: *\nDisallow: /\n' > web/robots.txt
  rm -f web/CNAME web/.well-known/assetlinks.json
  cat > web/staticwebapp.config.json <<'SWA'
{ "globalHeaders": { "X-Robots-Tag": "noindex, nofollow" }, "navigationFallback": { "rewrite": "/index.html", "exclude": ["/js/*", "/css/*", "/icons/*", "*.{png,jpg,svg,webmanifest,json,txt}"] } }
SWA
fi
