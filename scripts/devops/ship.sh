#!/usr/bin/env bash
# Sends every file in $OUT to each configured backup destination and prunes old copies there.
# A destination that isn't configured is reported and skipped; one that fails fails the run,
# but only after the others have been tried. Usage: ship.sh <kind>   (rtc-rentals | github-repos)
source "$(dirname "$0")/lib.sh"
KIND="${1:?kind}"; OUT="${OUT:-/tmp/backup-out}"; DAY="$(date -u +%Y/%m/%d)"; HERE="$(dirname "$0")"
RETAIN_DAYS="${RETAIN_DAYS:-90}"
FILES=("$OUT"/*); [ -e "${FILES[0]}" ] || fail "Nothing to ship in $OUT."
declare -A RESULT

# 1. Azure Blob (Storage account from rtc-platform; lifecycle rules there move to Cool and delete after 90 days)
if [ "${AZ_LOGIN:-}" = success ] && [ -n "${BACKUP_STORAGE_ACCOUNT:-}" ]; then
  to_azure() {
    for f in "${FILES[@]}"; do
      az storage blob upload --only-show-errors --auth-mode login --account-name "$BACKUP_STORAGE_ACCOUNT" \
        -c "$KIND" -n "$DAY/$(basename "$f")" -f "$f" --tier Cool --no-progress >/dev/null || return 1
    done
  }
  if to_azure; then RESULT[azure]=ok; else RESULT[azure]=FAILED; fi
else RESULT[azure]="not configured"; fi

# 2. Private GitHub repo: one orphan branch per backup, so history never piles up; old branches deleted.
if [ -n "${BACKUP_REPO:-}" ] && [ -n "${BACKUP_REPO_KEY:-}" ]; then
  if bash "$HERE/ship-github.sh" "$KIND"; then RESULT[github]=ok; else RESULT[github]=FAILED; fi
else RESULT[github]="not configured"; fi

# 3. SharePoint document library (Microsoft Graph, Sites.Selected on one site only)
if [ "${AZ_LOGIN:-}" = success ] && [ -n "${BACKUP_SP_SITE_ID:-}" ]; then
  if python3 "$HERE/ship-sharepoint.py" "$KIND" "${FILES[@]}"; then RESULT[sharepoint]=ok; else RESULT[sharepoint]=FAILED; fi
else RESULT[sharepoint]="not configured"; fi

{ echo "### Backup: $KIND"; echo "| Destination | Result |"; echo "|---|---|"
  for d in azure github sharepoint; do echo "| $d | ${RESULT[$d]} |"; done; } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
OKS=0; for d in azure github sharepoint; do [ "${RESULT[$d]}" = ok ] && OKS=$((OKS+1)); [ "${RESULT[$d]}" = FAILED ] && BAD=1; done
[ "$OKS" -gt 0 ] || fail "The backup was made but reached no destination."
[ -z "${BAD:-}" ] || fail "At least one backup destination failed (see table)."
for d in azure github sharepoint; do [ "${RESULT[$d]}" = ok ] || warn "Backup destination $d: ${RESULT[$d]}"; done
