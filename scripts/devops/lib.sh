#!/usr/bin/env bash
# Shared helpers for the deploy and backup scripts. Source it; don't run it.
set -euo pipefail

note()  { echo "::notice::$*"; }
warn()  { echo "::warning::$*"; }
fail()  { echo "::error::$*"; exit 1; }
clean_url() { echo "${1:-}" | tr -d '[:space:]' | sed -E 's#/rest/v1/?$##; s#/+$##'; }
project_ref() { clean_url "$1" | sed -E 's#https?://([^.]+)\..*#\1#'; }
supabase() { npx -y supabase@2 "$@"; }

# PostgreSQL 17 client/server from the PostgreSQL apt repo: pg_dump must be at least the server's version.
install_pg17() {
  if [ -x /usr/lib/postgresql/17/bin/pg_dump ]; then export PATH="/usr/lib/postgresql/17/bin:$PATH"; return; fi
  sudo apt-get install -y -qq postgresql-common >/dev/null
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  sudo apt-get install -y -qq "postgresql-17" >/dev/null
  export PATH="/usr/lib/postgresql/17/bin:$PATH"
}

install_age() {
  command -v age >/dev/null || { sudo apt-get install -y -qq age >/dev/null; }
}
