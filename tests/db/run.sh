#!/usr/bin/env bash
# Runs the schema migration and behaviour tests against a throwaway local Postgres.
# Usage: tests/db/run.sh   (needs PostgreSQL 15+ binaries on PATH or in /usr/lib/postgresql/*/bin)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")"
DATA="$(mktemp -d)"
PORT=55432
trap '"$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=" -l "$DATA/log" -w start >/dev/null \
  || { echo "Postgres failed to start:"; cat "$DATA/log"; exit 1; }
PSQL=("$PGBIN/psql" -h "$DATA" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f "$ROOT/tests/db/supabase_shim.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/001_initial_schema.sql"
"${PSQL[@]}" -f "$ROOT/tests/db/test_schema.sql"
