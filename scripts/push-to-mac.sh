#!/bin/bash
# push-to-mac.sh — rsync cicy-mobile to Mac, then optionally run simulator.
# Usage:
#   ./scripts/push-to-mac.sh              # sync only
#   ./scripts/push-to-mac.sh ios          # sync + pod install + run iOS simulator
#   ./scripts/push-to-mac.sh android      # sync + run Android emulator
#   ./scripts/push-to-mac.sh ios --no-pods  # skip pod install

set -e

MAC_HOST="mac"
MAC_DIR="/Users/ton/projects/cicy-mobile"
# Brew ruby + gem path on the Mac (avoid system Ruby 2.6 which lacks filter_map)
MAC_PATH="/usr/local/opt/ruby/bin:/Users/ton/.local/share/gem/ruby/4.0.0/bin"
PLATFORM="${1:-}"
SKIP_PODS="${2:-}"

echo "▶ rsync → ${MAC_HOST}:${MAC_DIR}"
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.expo' \
  --exclude='ios/Pods' \
  --exclude='ios/build' \
  --exclude='ios/*.xcworkspace' \
  --exclude='ios/Podfile.lock' \
  --exclude='android/build' \
  --exclude='android/.gradle' \
  --exclude='*.log' \
  /home/cicy/projects/cicy-mobile/ \
  "${MAC_HOST}:${MAC_DIR}/"
echo "✔ sync done"

[ -z "$PLATFORM" ] && exit 0

echo "▶ npm install on Mac"
ssh "$MAC_HOST" "cd '${MAC_DIR}' && npm install --legacy-peer-deps 2>&1 | tail -3"

case "$PLATFORM" in
  ios)
    if [ "$SKIP_PODS" != "--no-pods" ]; then
      echo "▶ pod install (via socks5 proxy)"
      ssh "$MAC_HOST" "cd '${MAC_DIR}/ios' && PATH=${MAC_PATH}:\$PATH ALL_PROXY=socks5://127.0.0.1:1085 pod install 2>&1 | tail -5"
    fi
    echo "▶ run iOS simulator"
    ssh -t "$MAC_HOST" "cd '${MAC_DIR}' && PATH=${MAC_PATH}:\$PATH npx react-native run-ios"
    ;;
  android)
    echo "▶ run Android emulator"
    ssh -t "$MAC_HOST" "cd '${MAC_DIR}' && npx react-native run-android"
    ;;
  *)
    echo "unknown platform: $PLATFORM (use ios or android)"
    exit 1
    ;;
esac
