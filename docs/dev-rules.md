# cicy-mobile 开发规范

## rsync 规则

### ✅ 允许 rsync 的文件

| 类型 | 路径 |
|------|------|
| JS/TS 源码 | `app/**` `src/**` |
| iOS Swift/ObjC 源文件 | `ios/CiCy/*.swift` `ios/CiCy/*.m` `ios/CiCy/*.h` |
| iOS Info.plist | `ios/CiCy/Info.plist` |
| iOS storyboard / xcassets | `ios/CiCy/*.storyboard` `ios/CiCy/Images.xcassets/` |
| Android Kotlin/Java | `android/app/src/main/java/**` |
| Android res / assets | `android/app/src/main/res/**` `android/app/src/main/assets/**` |
| Android Manifest | `android/app/src/main/AndroidManifest.xml` |
| Android build.gradle (限 namespace/applicationId) | `android/app/build.gradle` |
| app.json | `app.json` |
| package.json (依赖变更时) | `package.json` |

### ❌ 禁止 rsync 的文件（Xcode / Gradle 管理）

| 文件 | 原因 |
|------|------|
| `ios/**/*.xcodeproj/project.pbxproj` | Signing / Team / Build settings — Xcode 管理 |
| `ios/Podfile.lock` | pod install 产物，版本锁由 mac 管 |
| `ios/Pods/` | pod install 产物 |
| `ios/*.xcworkspace/` | Xcode workspace，不能覆盖 |
| `ios/CiCy/*.entitlements` | Signing entitlements，Xcode 管理 |
| `android/build/` `android/.gradle/` | Gradle 缓存 |
| `node_modules/` | npm install 产物 |

---

## Bundle ID 修改规范

**不允许**直接 rsync `project.pbxproj` 改 bundle id。

正确做法：
1. 修改 `app.json` 的 `ios.bundleIdentifier` / `android.package`（允许 rsync）
2. Android：修改 `android/app/build.gradle` 的 `namespace` / `applicationId`，移动 Java/Kotlin 目录
3. iOS：在 mac Xcode「Signing & Capabilities」面板改，或 ssh 到 mac 用：
   ```bash
   sed -i '' 's/OLD_BUNDLE_ID/NEW_BUNDLE_ID/g' ~/projects/cicy-mobile/ios/CiCy.xcodeproj/project.pbxproj
   ```
   **只改 bundle id 那一行，不整个文件 rsync**

---

## rsync 命令模板

```bash
# 同步 TS/JS 源码
rsync -av \
  --include='app/***' \
  --include='src/***' \
  --exclude='*' \
  /home/cicy/projects/cicy-mobile/ \
  mac:projects/cicy-mobile/

# 同步单个文件（常用）
rsync -av /home/cicy/projects/cicy-mobile/app/agents.tsx \
  mac:projects/cicy-mobile/app/agents.tsx

# 同步 iOS Swift 源文件（不含 pbxproj）
rsync -av \
  --exclude='*.pbxproj' \
  --exclude='*.xcworkspace' \
  --exclude='Pods/' \
  --exclude='Podfile.lock' \
  --exclude='*.entitlements' \
  /home/cicy/projects/cicy-mobile/ios/CiCy/ \
  mac:projects/cicy-mobile/ios/CiCy/

# 同步 Android Kotlin 源文件
rsync -av \
  /home/cicy/projects/cicy-mobile/android/app/src/main/java/ \
  mac:projects/cicy-mobile/android/app/src/main/java/
```

---

## Android build 安装

```bash
ssh mac "
cd ~/projects/cicy-mobile/android
./gradlew assembleDebug 2>&1 | tail -5
adb -s XGIJUSDM4TRS6PX4 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s XGIJUSDM4TRS6PX4 reverse tcp:8081 tcp:8081
"
```

## iOS build

**用 Xcode 跑**（⌘R），不要从命令行 xcodebuild——避免 keychain unlock 问题。

打开：`~/projects/cicy-mobile/ios/CiCy.xcworkspace`

---

## 注意事项

1. `app/chat/[agentId].tsx` 等含方括号的文件**不能用 rsync 直接同步**，用：
   ```bash
   cat app/chat/[agentId].tsx | ssh mac "cat > ~/projects/cicy-mobile/app/chat/\[agentId\].tsx"
   ```
2. Metro 需要在 mac 上跑（`npm start`），Android 用 `adb reverse tcp:8081 tcp:8081`
3. iOS debug build 依赖 Metro，确保 `npm start` 已启动
