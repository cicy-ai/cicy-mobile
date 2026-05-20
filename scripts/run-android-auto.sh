#!/bin/bash
# run-android-auto.sh — Mac 侧全自动 Android：安装 SDK + 启动模拟器 + 运行 app

set -e
LOG=/tmp/run-android-auto.log
exec > >(tee -a "$LOG") 2>&1
echo "[$(date)] === run-android-auto.sh START ==="

PROJ_DIR="$HOME/projects/cicy-mobile"
export PATH="/usr/local/bin:$PATH"
export LANG=en_US.UTF-8

ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_HOME
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# 1. 安装 Android SDK（如果没有）
if [ ! -f "$ANDROID_HOME/platform-tools/adb" ]; then
  echo "[$(date)] Android SDK not found, installing via Homebrew..."
  brew install --cask android-commandlinetools 2>&1 | tail -5
  # 接受 licenses
  yes | sdkmanager --licenses 2>&1 | tail -3
  # 安装必要组件
  sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" \
    "system-images;android-34;google_apis;x86_64" "emulator" 2>&1 | tail -10
  echo "[$(date)] Android SDK installed"
else
  echo "[$(date)] Android SDK found at $ANDROID_HOME"
fi

# 2. 创建 AVD（如果不存在）
AVD_NAME="cicy_android"
if ! avdmanager list avd 2>/dev/null | grep -q "$AVD_NAME"; then
  echo "[$(date)] creating AVD $AVD_NAME..."
  echo "no" | avdmanager create avd \
    -n "$AVD_NAME" \
    -k "system-images;android-34;google_apis;x86_64" \
    --device "pixel_4" 2>&1 | tail -5
fi

# 3. 启动模拟器（后台）
echo "[$(date)] starting Android emulator..."
emulator -avd "$AVD_NAME" -no-window -no-boot-anim &
EMU_PID=$!
echo "Emulator PID: $EMU_PID"

# 等 emulator 启动
echo "[$(date)] waiting for emulator to boot..."
adb wait-for-device
for i in $(seq 1 60); do
  BOOT=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$BOOT" = "1" ] && { echo "[$(date)] emulator booted"; break; }
  sleep 5
done

# 4. 启动 Metro (后台)
echo "[$(date)] starting Metro bundler..."
cd "$PROJ_DIR"
pkill -f 'expo start' 2>/dev/null || true
sleep 1
nohup /usr/local/bin/npx expo start --no-dev --port 8081 > /tmp/metro-android.log 2>&1 &
sleep 8

# 5. Build + install Android
echo "[$(date)] running react-native run-android..."
cd "$PROJ_DIR"
/usr/local/bin/npx react-native run-android --no-packager 2>&1 | tail -20

echo "[$(date)] === Android DONE ==="
