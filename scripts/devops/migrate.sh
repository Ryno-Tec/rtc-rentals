#!/usr/bin/env bash
# Applies new files in supabase/migrations to one database, recording them in Supabase's migration history.
# Needs SUPABASE_DB_URL (Dashboard → Connect → Session pooler URI, with the password filled in).
# Writes the list of pending versions to $PENDING_FILE (default /tmp/pending-migrations) for the caller.
# Refuses to run against a database that already has the app's tables but no migration history:
# run scripts/devops/baseline.sh once for that database first.
source "$(dirname "$0")/lib.sh"
PENDING_FILE="${PENDING_FILE:-/tmp/pending-migrations}"; : > "$PENDING_FILE"
[ -n "${SUPABASE_DB_URL:-}" ] || { note "SUPABASE_DB_URL not set; migrations not applied (run them in the SQL editor)."; exit 0; }
DRY="${DRY_RUN:-false}"
q() { psql "$SUPABASE_DB_URL" -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }

has_history="$(q "select to_regclass('supabase_migrations.schema_migrations') is not null")"
has_app="$(q "select to_regclass('public.properties') is not null")"
if [ "$has_history" = t ]; then applied="$(q "select version from supabase_migrations.schema_migrations")"; else applied=""; fi
if [ "$has_history" != t ] && [ "$has_app" = t ]; then
  fail "This database already has RTC Rentals tables but no migration history. Run scripts/devops/baseline.sh against it once (see docs/DEVOPS.md)."
fi
for f in supabase/migrations/*.sql; do
  v="$(basename "$f" | cut -d_ -f1)"
  grep -qx "$v" <<<"$applied" || echo "$v" >> "$PENDING_FILE"
done
if [ ! -s "$PENDING_FILE" ]; then echo "Database is up to date."; exit 0; fi
echo "Pending migrations: $(paste -sd' ' "$PENDING_FILE")"
[ "$DRY" = true ] && exit 0
# --include-all: a migration older than the newest applied one (e.g. 017 skipped by hand) still runs.
supabase db push --db-url "$SUPABASE_DB_URL" --include-all --yes
echo "Applied: $(paste -sd' ' "$PENDING_FILE")"
