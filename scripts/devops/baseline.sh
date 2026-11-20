#!/usr/bin/env bash
# One-off: tells Supabase's migration history that migrations up to and including <last> were already
# applied by hand (in the SQL editor), so the pipeline only runs newer ones.
# Usage: SUPABASE_DB_URL='postgresql://…' scripts/devops/baseline.sh 018
source "$(dirname "$0")/lib.sh"
LAST="${1:?Give the last migration you ran by hand, e.g. 018}"
[ -n "${SUPABASE_DB_URL:-}" ] || fail "Set SUPABASE_DB_URL first."
VERS=()
for f in supabase/migrations/*.sql; do v="$(basename "$f" | cut -d_ -f1)"; [ "$((10#$v))" -le "$((10#$LAST))" ] && VERS+=("$v"); done
echo "Marking as applied: ${VERS[*]}"
supabase migration repair --db-url "$SUPABASE_DB_URL" --status applied "${VERS[@]}"
