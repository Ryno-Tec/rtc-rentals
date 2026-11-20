#!/usr/bin/env bash
# Restores an RTC Rentals backup. Run on your own machine; the private key never goes to GitHub.
#   scripts/devops/restore.sh <backup.tar.zst.age> <age key file> [target database URL]
# Without a target it only decrypts and unpacks into ./restore-<name>/ so you can inspect it.
# With a target (normally the STAGING database first) it loads the database into it:
#   new Supabase project: roles.sql, schema.sql, data.sql (Supabase's documented order)
#   plain Postgres:       pg_restore of db/full.dump
# Storage files are in storage/<bucket>/; upload them with the Supabase CLI or the S3 API.
set -euo pipefail
FILE="${1:?backup file}"; KEY="${2:?age key file}"; TARGET="${3:-}"
NAME="$(basename "$FILE" .tar.zst.age)"; DIR="restore-$NAME"
mkdir -p "$DIR"; age -d -i "$KEY" "$FILE" | zstd -dq | tar -C "$DIR" -x
echo "Unpacked into $DIR:"; find "$DIR" -maxdepth 2 | sed 's#^#  #'
[ -n "$TARGET" ] || exit 0
case "$TARGET" in *ubxtpreeyenwdsybjemd*) read -rp "That is PRODUCTION. Type RESTORE-PRODUCTION to continue: " a; [ "$a" = RESTORE-PRODUCTION ] || exit 1;; esac
if [ -f "$DIR/db/schema.sql" ]; then
  psql "$TARGET" -X -v ON_ERROR_STOP=1 --single-transaction \
    -c 'SET session_replication_role = replica' -f "$DIR/db/roles.sql" -f "$DIR/db/schema.sql" -f "$DIR/db/data.sql"
else
  pg_restore -d "$TARGET" --no-owner --no-acl "$DIR/db/full.dump"
fi
echo "Restored. Compare row counts with $DIR/db/counts.json."
