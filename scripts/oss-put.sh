#!/usr/bin/env bash
# Signed OSS PUT (v1 signature) — pure curl + openssl, cross-platform (Linux CI
# AND macOS CI; no ossutil binary). Mirrors the signing in publish-ota.mjs.
# Creds from $OSS_ACCESS_KEY_ID / $OSS_ACCESS_KEY_SECRET.
#   oss_put <key> <local_file> <content_type>
OSS_BUCKET="${OSS_BUCKET:-cicy-1372193042-cn}"
OSS_ENDPOINT="${OSS_ENDPOINT:-oss-cn-shanghai.aliyuncs.com}"
oss_put() {
  local key="$1" file="$2" ct="$3"
  local host="${OSS_BUCKET}.${OSS_ENDPOINT}"
  local date sts sig
  date="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S GMT')"
  sts="$(printf 'PUT\n\n%s\n%s\n/%s/%s' "$ct" "$date" "$OSS_BUCKET" "$key")"
  sig="$(printf '%s' "$sts" | openssl dgst -sha1 -hmac "$OSS_ACCESS_KEY_SECRET" -binary | base64)"
  curl -fsS -X PUT "https://${host}/${key}" \
    -H "Host: ${host}" -H "Date: ${date}" -H "Content-Type: ${ct}" \
    -H "Authorization: OSS ${OSS_ACCESS_KEY_ID}:${sig}" \
    --data-binary @"${file}"
}
