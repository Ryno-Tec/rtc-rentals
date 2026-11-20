#!/usr/bin/env bash
# Pushes $OUT to $BACKUP_REPO as orphan branch <kind>/<timestamp>, using the write deploy key in
# $BACKUP_REPO_KEY, and deletes that kind's branches older than RETAIN_DAYS_GITHUB (default 30).
source "$(dirname "$0")/lib.sh"
KIND="$1"; OUT="${OUT:-/tmp/backup-out}"; KEEP="${RETAIN_DAYS_GITHUB:-30}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
install -m 600 /dev/null "$W/key"; printf '%s\n' "$BACKUP_REPO_KEY" > "$W/key"
export GIT_SSH_COMMAND="ssh -i $W/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$W/known"
REMOTE="git@github.com:$BACKUP_REPO.git"; BR="$KIND/$(date -u +%Y-%m-%dT%H%MZ)"
git init -q -b "$BR" "$W/repo"; cd "$W/repo"
git config user.name "rtc-backup"; git config user.email "backup@ryno-tec.co.za"
for f in "$OUT"/*; do
  if [ "$(stat -c %s "$f")" -gt 94371840 ]; then split -b 90m -d -a 3 "$f" "$(basename "$f").part-"; else cp "$f" .; fi
done
printf 'Encrypted backup. Parts (if any) join with: cat <file>.part-* > <file>\n' > README.txt
git add -A && git commit -qm "Backup $BR" && git push -q "$REMOTE" "HEAD:refs/heads/$BR"
echo "pushed $BR"
CUTOFF="$(date -u -d "-$KEEP days" +%Y-%m-%d)"
git ls-remote --heads "$REMOTE" "refs/heads/$KIND/*" | awk '{print $2}' | sed 's#refs/heads/##' | while read -r b; do
  d="${b#"$KIND"/}"; d="${d:0:10}"
  if [[ "$d" < "$CUTOFF" ]]; then git push -q "$REMOTE" --delete "$b" && echo "pruned $b"; fi
done
