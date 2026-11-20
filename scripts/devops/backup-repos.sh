#!/usr/bin/env bash
# Weekly: every GitHub repo as a git bundle (all branches and tags), packed and encrypted.
# BACKUP_REPOS: space-separated owner/repo list. Tokens: GH_TOKEN_RYNO_TEC for Ryno-Tec/*, GH_TOKEN_KG for the rest.
source "$(dirname "$0")/lib.sh"
OUT="${OUT:-/tmp/backup-out}"; STAMP="$(date -u +%Y-%m-%dT%H%MZ)"; NAME="github-repos-$STAMP"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
[ -n "${BACKUP_AGE_RECIPIENT:-}" ] || fail "BACKUP_AGE_RECIPIENT is not set."
install_age; command -v zstd >/dev/null || sudo apt-get install -y -qq zstd >/dev/null
mkdir -p "$OUT" "$WORK/pkg"; FAILED=()
for r in ${BACKUP_REPOS:?BACKUP_REPOS missing}; do
  case "$r" in Ryno-Tec/*) T="${GH_TOKEN_RYNO_TEC:-}";; *) T="${GH_TOKEN_KG:-}";; esac
  [ -n "$T" ] || { warn "No token for $r; skipped."; FAILED+=("$r"); continue; }
  if git clone -q --mirror "https://x-access-token:$T@github.com/$r.git" "$WORK/m" 2>/dev/null \
     && git -C "$WORK/m" bundle create -q "$WORK/pkg/${r//\//__}.bundle" --all && git bundle verify -q "$WORK/pkg/${r//\//__}.bundle" 2>/dev/null; then
    echo "ok   $r ($(du -h "$WORK/pkg/${r//\//__}.bundle" | cut -f1))"
  else warn "Could not back up $r"; FAILED+=("$r"); fi
  rm -rf "$WORK/m"
done
printf 'GitHub repositories %s\nRestore one: git clone <owner__repo>.bundle <folder>\n' "$STAMP" > "$WORK/pkg/README.txt"
tar -C "$WORK/pkg" -cf - . | zstd -q -T0 -10 | age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT/$NAME.tar.zst.age"
SHA="$(sha256sum "$OUT/$NAME.tar.zst.age" | cut -d' ' -f1)"
printf '{"name":"%s","created":"%s","file":"%s.tar.zst.age","sha256":"%s","bytes":%s,"repos":%s,"failed":%s}\n' \
  "$NAME" "$STAMP" "$NAME" "$SHA" "$(stat -c %s "$OUT/$NAME.tar.zst.age")" "$(ls "$WORK/pkg"/*.bundle 2>/dev/null | wc -l)" "${#FAILED[@]}" > "$OUT/$NAME.manifest.json"
cat "$OUT/$NAME.manifest.json"
[ ${#FAILED[@]} = 0 ] || fail "Not backed up: ${FAILED[*]}"
