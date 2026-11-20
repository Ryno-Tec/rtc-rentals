#!/usr/bin/env bash
# Nightly RTC Rentals backup: database (two formats), table counts and storage files, checked by
# restoring into a throwaway Postgres, then packed and encrypted with age for BACKUP_AGE_RECIPIENT.
# Needs SUPABASE_DB_URL and BACKUP_AGE_RECIPIENT; storage needs SUPABASE_S3_KEY_ID, SUPABASE_S3_SECRET,
# SUPABASE_S3_REGION and SUPABASE_URL. Writes <OUT>/<name>.tar.zst.age and <OUT>/<name>.manifest.json.
source "$(dirname "$0")/lib.sh"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-/tmp/backup-out}"; STAMP="$(date -u +%Y-%m-%dT%H%MZ)"; NAME="rtc-rentals-$STAMP"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
[ -n "${SUPABASE_DB_URL:-}" ] || fail "SUPABASE_DB_URL is not set."
[ -n "${BACKUP_AGE_RECIPIENT:-}" ] || fail "BACKUP_AGE_RECIPIENT is not set; backups are never stored unencrypted."
install_pg17; install_age
command -v zstd >/dev/null || sudo apt-get install -y -qq zstd >/dev/null
mkdir -p "$OUT" "$WORK/pkg/db"

echo "== Database"
pg_dump "$SUPABASE_DB_URL" -Fc --no-owner --no-acl -f "$WORK/pkg/db/full.dump"
pg_restore --list "$WORK/pkg/db/full.dump" > /dev/null
# Supabase's own format (roles / schema / data), the documented way to restore into a new Supabase project.
if [ "${SKIP_SUPABASE_DUMP:-}" != 1 ]; then
supabase db dump --db-url "$SUPABASE_DB_URL" --role-only -f "$WORK/pkg/db/roles.sql"
supabase db dump --db-url "$SUPABASE_DB_URL" -f "$WORK/pkg/db/schema.sql"
supabase db dump --db-url "$SUPABASE_DB_URL" --data-only --use-copy -f "$WORK/pkg/db/data.sql"
fi

# Exact row counts for every table in public, to compare after the test restore.
COUNT_SQL="select coalesce(json_object_agg(t, n), '{}') from (select c.relname as t,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint as n
  from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','p') order by 1) x"
psql "$SUPABASE_DB_URL" -X -A -t -v ON_ERROR_STOP=1 -c "$COUNT_SQL" > "$WORK/pkg/db/counts.json"

echo "== Test restore"
PGDATA="$WORK/pg"; PORT=55439
initdb -D "$PGDATA" -U postgres -A trust >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PORT -k $PGDATA -c listen_addresses=" -l "$WORK/pg.log" -w start >/dev/null
LOCAL=(-h "$PGDATA" -p "$PORT" -U postgres -d postgres)
psql "${LOCAL[@]}" -X -q -f "$ROOT/tests/db/supabase_shim.sql" >/dev/null
pg_restore "${LOCAL[@]}" -n public --schema-only --no-owner --no-acl "$WORK/pkg/db/full.dump" 2> "$WORK/restore-schema.log" || true
pg_restore "${LOCAL[@]}" -n public --data-only --disable-triggers "$WORK/pkg/db/full.dump" 2> "$WORK/restore-data.log" || true
psql "${LOCAL[@]}" -X -A -t -c "$COUNT_SQL" > "$WORK/restored-counts.json"
pg_ctl -D "$PGDATA" -m fast stop >/dev/null
python3 - "$WORK/pkg/db/counts.json" "$WORK/restored-counts.json" <<'PY'
import json, sys
live, back = (json.load(open(p)) for p in sys.argv[1:])
bad = {t: (n, back.get(t)) for t, n in live.items() if back.get(t) != n}
print(f"{len(live)} tables, {sum(live.values())} rows; restored copy matches: {not bad}")
if bad:
    print("::error::Test restore differs (live, restored):", json.dumps(bad)); sys.exit(1)
PY

echo "== Storage files"
if [ -n "${SUPABASE_S3_KEY_ID:-}" ] && [ -n "${SUPABASE_S3_SECRET:-}" ]; then
  export AWS_ACCESS_KEY_ID="$SUPABASE_S3_KEY_ID" AWS_SECRET_ACCESS_KEY="$SUPABASE_S3_SECRET" AWS_DEFAULT_REGION="${SUPABASE_S3_REGION:?SUPABASE_S3_REGION missing}"
  EP="$(clean_url "$SUPABASE_URL")/storage/v1/s3"
  mkdir -p "$WORK/pkg/storage"
  for b in $(aws s3 ls --endpoint-url "$EP" | awk '{print $3}'); do
    aws s3 sync --only-show-errors --endpoint-url "$EP" "s3://$b" "$WORK/pkg/storage/$b"
    echo "$b: $(find "$WORK/pkg/storage/$b" -type f | wc -l) files"
  done
else
  warn "Storage keys not set; storage files (photos, signed leases) are NOT in this backup."
fi

echo "== Pack and encrypt"
printf '%s\n' "RTC Rentals backup $STAMP" "commit ${GITHUB_SHA:-local}" \
  "Restore: see docs/DEVOPS.md → Restore. Decrypt with: age -d -i <key file> $NAME.tar.zst.age | tar --zstd -x" > "$WORK/pkg/README.txt"
tar -C "$WORK/pkg" -cf - . | zstd -q -T0 -10 | age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT/$NAME.tar.zst.age"
SHA="$(sha256sum "$OUT/$NAME.tar.zst.age" | cut -d' ' -f1)"; SIZE="$(stat -c %s "$OUT/$NAME.tar.zst.age")"
python3 - "$WORK/pkg/db/counts.json" > "$OUT/$NAME.manifest.json" <<PY
import json, sys
c = json.load(open(sys.argv[1]))
print(json.dumps({"name": "$NAME", "created": "$STAMP", "file": "$NAME.tar.zst.age", "sha256": "$SHA", "bytes": $SIZE,
  "commit": "${GITHUB_SHA:-local}", "tables": len(c), "rows": sum(c.values()), "restore_test": "passed",
  "storage": $([ -d "$WORK/pkg/storage" ] && echo True || echo False), "encryption": "age"}, indent=2))
PY
cat "$OUT/$NAME.manifest.json"
echo "name=$NAME" >> "${GITHUB_OUTPUT:-/dev/null}"
