#!/bin/bash
# run-ios-auto.sh — Mac 侧全自动脚本：pod install + patch + Metro + build + install + launch
# 在 Mac 上直接运行：bash ~/projects/cicy-mobile/scripts/run-ios-auto.sh

set -e
LOG=/tmp/run-ios-auto.log
exec > >(tee -a "$LOG") 2>&1
echo "[$(date)] === run-ios-auto.sh START ==="

PROJ_DIR="$HOME/projects/cicy-mobile"
POD_BIN_DIR="/usr/local/opt/ruby/bin:/Users/ton/.local/share/gem/ruby/4.0.0/bin"
export PATH="$POD_BIN_DIR:/usr/local/bin:$PATH"
export LANG=en_US.UTF-8
SIM_ID="62CFF72A-4483-4864-90C8-5A4A400A2B4F"  # iPhone 14

# 1. pod install
echo "[$(date)] pod install..."
cd "$PROJ_DIR/ios"
ALL_PROXY=socks5://127.0.0.1:1085 pod install 2>&1 | tail -5

# 2. patch pbxproj: SWIFT_VERSION 5.0 → 5.9 (支持 @MainActor)
echo "[$(date)] patch pbxproj SWIFT_VERSION..."
sed -i '' 's/SWIFT_VERSION = 5.0;/SWIFT_VERSION = 5.9;/g' Pods/Pods.xcodeproj/project.pbxproj
grep 'SWIFT_VERSION' Pods/Pods.xcodeproj/project.pbxproj | sort -u

# 3. patch ExpoModulesCore xcconfig: 加 -disable-actor-data-race-checks
echo "[$(date)] patch ExpoModulesCore xcconfig..."
python3 << 'PYEOF'
import re, glob
for path in glob.glob('/Users/ton/projects/cicy-mobile/ios/Pods/Target Support Files/ExpoModulesCore/ExpoModulesCore.*.xcconfig'):
    content = open(path).read()
    def add_flag(m):
        line = m.group(0).rstrip()
        if '-disable-actor-data-race-checks' in line:
            return line
        return line + ' -Xfrontend -disable-actor-data-race-checks'
    content = re.sub(r'OTHER_SWIFT_FLAGS = .*', add_flag, content)
    open(path, 'w').write(content)
    print(f"  patched: {path}")
PYEOF

# 4. 启动 iOS 模拟器
echo "[$(date)] booting simulator $SIM_ID..."
xcrun simctl boot "$SIM_ID" 2>/dev/null || true
open -a Simulator 2>/dev/null || true
sleep 3

# 5. 启动 Metro bundler (后台)
echo "[$(date)] starting Metro bundler..."
cd "$PROJ_DIR"
pkill -f 'expo start' 2>/dev/null || true
pkill -f 'react-native start' 2>/dev/null || true
sleep 1
nohup /usr/local/bin/npx expo start --no-dev --port 8081 > /tmp/metro.log 2>&1 &
METRO_PID=$!
echo "Metro PID: $METRO_PID"
sleep 8

# 6. xcodebuild
echo "[$(date)] xcodebuild..."
cd "$PROJ_DIR/ios"
xcodebuild \
  -workspace mobile.xcworkspace \
  -scheme mobile \
  -configuration Debug \
  -destination "id=$SIM_ID" \
  -derivedDataPath /tmp/cicy-mobile-ddata \
  build 2>&1 | grep -E '^(Build|error:|warning:|.*BUILD|Compiling|Linking|Installing|Launching)' | tail -30

# 7. 找 .app 安装到模拟器
APP_PATH=$(find /tmp/cicy-mobile-ddata -name "mobile.app" -type d 2>/dev/null | head -1)
if [ -n "$APP_PATH" ]; then
  echo "[$(date)] installing $APP_PATH..."
  xcrun simctl install "$SIM_ID" "$APP_PATH"
  echo "[$(date)] launching app..."
  xcrun simctl launch "$SIM_ID" "ai.cicy.mobile"
  echo "[$(date)] === iOS DONE ==="
else
  echo "[$(date)] ERROR: mobile.app not found, build may have failed"
  exit 1
fi
