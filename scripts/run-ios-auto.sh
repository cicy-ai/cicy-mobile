#!/bin/bash
# Run cicy-mobile on iOS simulator (Mac via SSH)
set -e
MAC="mac"
SIM_ID="62CFF72A-4483-4864-90C8-5A4A400A2B4F"
PROJ="$HOME/projects/cicy-mobile"

echo "=== rsync to Mac ==="
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='ios/Pods' \
  --exclude='ios/Podfile.lock' \
  --exclude='ios/*.xcworkspace' \
  --exclude='android' \
  "$PROJ/" "$MAC:~/projects/cicy-mobile/"

echo "=== pod install ==="
ssh "$MAC" "cd ~/projects/cicy-mobile/ios && \
  PATH=/usr/local/opt/ruby/bin:/Users/ton/.local/share/gem/ruby/4.0.0/bin:\$PATH \
  LANG=en_US.UTF-8 pod install 2>&1 | tail -5"

echo "=== patch ==="
ssh "$MAC" "
# 1. Pods pbxproj: SWIFT_VERSION = 5.9
sed -i '' 's/SWIFT_VERSION = 6.0;/SWIFT_VERSION = 5.9;/g' ~/projects/cicy-mobile/ios/Pods/Pods.xcodeproj/project.pbxproj
sed -i '' 's/SWIFT_VERSION = 6;/SWIFT_VERSION = 5.9;/g'  ~/projects/cicy-mobile/ios/Pods/Pods.xcodeproj/project.pbxproj

# 2. ExpoModulesCore xcconfig: disable-actor-data-race-checks
python3 /tmp/patch_all_xcconfig.py 2>/dev/null || python3 << 'PYEOF'
import os, re
pods = '/Users/ton/projects/cicy-mobile/ios/Pods/Target Support Files/'
for target in ['ExpoModulesCore','ExpoImage','ExpoRouter','Expo','ExpoAsset','ExpoCamera',
               'ExpoFont','ExpoHaptics','ExpoKeepAwake','ExpoLinking','ExpoLocalization',
               'ExpoLogBox','ExpoSecureStore','ExpoSplashScreen','ExpoSymbols','ExpoSystemUI',
               'ExpoWebBrowser','ExpoAudio','ExpoFileSystem','EXConstants','ExpoGlassEffect',
               'RCTSwiftUI','RCTSwiftUIWrapper']:
    for cfg in ['debug','release']:
        path = f'{pods}{target}/{target}.{cfg}.xcconfig'
        if not os.path.exists(path): continue
        c = open(path).read()
        if 'SWIFT_VERSION' not in c: c = 'SWIFT_VERSION = 5.9\n' + c
        if '-disable-actor-data-race-checks' not in c:
            c = re.sub(r'^OTHER_SWIFT_FLAGS = ', 'OTHER_SWIFT_FLAGS = -Xfrontend -disable-actor-data-race-checks ', c, flags=re.MULTILINE)
        open(path,'w').write(c)
print('xcconfig patched')
PYEOF

# 3. expo-configure-project.sh: remove LinkPreview/RouterToolbar from provider
python3 << 'PYEOF'
import re, os
path = '/Users/ton/projects/cicy-mobile/ios/Pods/Target Support Files/Pods-mobile/expo-configure-project.sh'
c = open(path).read()
if 'LinkPreviewNativeModule' not in c:
    provider = '/Users/ton/projects/cicy-mobile/ios/Pods/Target Support Files/Pods-mobile/ExpoModulesProvider.swift'
    c += f'\n\nsed -i \"\" \"/LinkPreviewNativeModule/d\" \"{provider}\" 2>/dev/null || true\nsed -i \"\" \"/RouterToolbarModule/d\" \"{provider}\" 2>/dev/null || true\n'
    open(path,'w').write(c)
    print('expo-configure-project.sh patched')
PYEOF

# 4. RNSScreenWindowTraits: disable assert
python3 << 'PYEOF'
import re
path = '/Users/ton/projects/cicy-mobile/node_modules/react-native-screens/ios/RNSScreenWindowTraits.mm'
c = open(path).read()
c2 = re.sub(
    r'(\+ \(void\)assertViewControllerBasedStatusBarAppearenceSet\s*\{).*?(\+ \(void\)updateStatusBarAppearance)',
    r'\1\n  // disabled\n}\n\n\2',
    c, flags=re.DOTALL
)
if c2 != c:
    open(path,'w').write(c2)
    print('RNSScreenWindowTraits patched')
PYEOF
"

echo "=== build ==="
ssh "$MAC" "
xcrun simctl boot $SIM_ID 2>/dev/null; true
mkdir -p ~/ddata
nohup sh -c 'nice -n 15 xcodebuild \
  -workspace /Users/ton/projects/cicy-mobile/ios/mobile.xcworkspace \
  -scheme mobile -configuration Debug \
  -destination id=$SIM_ID \
  -derivedDataPath ~/ddata -jobs 1 \
  build > ~/xbuild.log 2>&1; echo exit:\$? >> ~/xbuild.log' >/dev/null 2>&1 &
echo build started"

echo "Waiting for build..."
for i in \$(seq 1 120); do
  sleep 60
  result=\$(ssh -o ConnectTimeout=10 $MAC "grep -E 'BUILD SUCCEEDED|BUILD FAILED|exit:' ~/xbuild.log 2>/dev/null | head -2" 2>/dev/null)
  echo "[\${i}min] \${result:-building...}"
  echo "\$result" | grep -qE 'BUILD SUCCEEDED|BUILD FAILED' && break
done

echo "=== install & launch ==="
ssh "$MAC" "
# patch Info.plist in app bundle
/usr/libexec/PlistBuddy -c 'Set :UIViewControllerBasedStatusBarAppearance NO' ~/ddata/Build/Products/Debug-iphonesimulator/mobile.app/Info.plist 2>/dev/null || true
xcrun simctl install booted ~/ddata/Build/Products/Debug-iphonesimulator/mobile.app
xcrun simctl terminate booted ai.cicy.mobile 2>/dev/null; true
sleep 1
# set Metro bundler URL
xcrun simctl spawn booted defaults write ai.cicy.mobile RCT_packager_hostname localhost 2>/dev/null || true
xcrun simctl launch booted ai.cicy.mobile
"

echo "=== start Metro ==="
ssh "$MAC" "cd ~/projects/cicy-mobile && pkill -f 'expo start' 2>/dev/null; true
nohup npx expo start --port 8081 > ~/metro.log 2>&1 &
echo Metro started"

echo "=== Done! App launched on simulator ==="
