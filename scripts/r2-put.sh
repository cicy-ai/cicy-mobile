#!/usr/bin/env bash
# PUT one object into the cicy-assets-poc R2 bucket through the Cloudflare API
# (pure curl; Linux AND macOS CI). Public read at https://r2.deepfetch.de5.net/.
# Creds from $R2_ACCOUNT_ID / $R2_API_TOKEN (the same pair every release step used
# for the version.json mirror). Retries transient failures.
#   r2_put <key> <local_file> <content_type>
R2_BUCKET="${R2_BUCKET:-cicy-assets-poc}"
r2_put() {
  local key="$1" file="$2" ct="$3" attempt
  local base="https://api.cloudflare.com/client/v4/accounts/${R2_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects"
  for attempt in 1 2 3 4; do
    if curl -fsS -X PUT "${base}/${key}" \
        -H "Authorization: Bearer ${R2_API_TOKEN}" \
        -H "Content-Type: ${ct}" \
        --data-binary @"${file}" >/dev/null; then
      echo "r2 put ${key}"; return 0
    fi
    echo "r2 put ${key} failed (attempt ${attempt})" >&2; sleep $((attempt * 5))
  done
  return 1
}

# Point the in-app update manifest at the RAW apk of <version> (must already be
# on R2 — checked first so the banner can never link a missing file).
#   write_version_json <version>
write_version_json() {
  local ver="$1"
  local apk="https://r2.deepfetch.de5.net/cicy-mobile/cicy-${ver}.apk"
  local ct
  ct=$(curl -sSI -o /dev/null -w '%{content_type}' "$apk" || true)
  case "$ct" in
    application/vnd.android.package-archive*) ;;
    *) echo "raw apk missing on R2: $apk (content-type '$ct')" >&2; return 1 ;;
  esac
  # `zip:false`: the app opens the link and Android installs it straight away.
  printf '{"version":"%s","apk":"%s","zip":false}' "$ver" "$apk" > version.json
  r2_put "cicy-mobile/version.json" version.json application/json
  echo "version.json → R2 (apk=${apk})"
}
