#!/usr/bin/env bash
# Proves to Android that the store app and this website belong together, so the app opens
# full-screen without a browser bar. Needs ANDROID_CERT_SHA256 (comma-separated) once the signing key exists.
set -euo pipefail
[ -n "${ANDROID_CERT_SHA256:-}" ] || exit 0
mkdir -p web/.well-known
FPS=$(echo "$ANDROID_CERT_SHA256" | tr ',' '\n' | sed -E 's/^ *//; s/ *$//' | sed -E 's/.*/"&"/' | paste -sd, -)
printf '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"za.co.rynotec.rentals","sha256_cert_fingerprints":[%s]}}]\n' "$FPS" > web/.well-known/assetlinks.json
cat web/.well-known/assetlinks.json
