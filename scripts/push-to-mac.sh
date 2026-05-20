#!/bin/bash
# push-to-mac.sh — rsync cicy-mobile to Mac, then optionally run simulator.
# Usage:
#   ./scripts/push-to-mac.sh           # sync only
#   ./scripts/push-to-mac.sh ios       # sync + run iOS simulator
#   ./scripts/push-to-mac.sh android   # sync + run Android emulator

set -e

MAC_HOST="mac"                          # ~/.ssh/config alias
MAC_DIR="/Users/ton/projects/cicy-mobile"
PLATFORM="${1:-}"

echo "▶ rsync → ${MAC_HOST}:${MAC_DIR}"
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.expo' \
  --exclude='*.log' \
  /home/cicy/projects/cicy-mobile/ \
  "${MAC_HOST}:${MAC_DIR}/"

echo "✔ sync done"

if [ -z "$PLATFORM" ]; then
  exit 0
fi

echo "▶ npm install on Mac"
ssh "$MAC_HOST" "cd '${MAC_DIR}' && npm install --legacy-peer-deps 2>&1 | tail -3"

case "$PLATFORM" in
  ios)
    echo "▶ run iOS simulator"
    ssh "$MAC_HOST" "cd '${MAC_DIR}' && npx react-native run-ios 2>&1 &"
    ;;
  android)
    echo "▶ run Android emulator"
    ssh "$MAC_HOST" "cd '${MAC_DIR}' && npx react-native run-android 2>&1 &"
    ;;
  *)
    echo "unknown platform: $PLATFORM (use ios or android)"
    exit 1
    ;;
esac
