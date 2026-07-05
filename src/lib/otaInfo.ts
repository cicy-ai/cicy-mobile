import { Platform } from 'react-native';

// Which OTA update is THIS process running? Returns the publish label (the
// u-tag / release version baked into the manifest's extra.label by
// scripts/publish-ota.mjs), or '' when running the APK-embedded bundle (or on
// web / any lookup failure). Powers the drawer's version line so every hot
// update is visibly identifiable — no more guessing which OTA landed.
export function runningOtaLabel(): string {
  if (Platform.OS === 'web') return '';
  try {
    const Updates = require('expo-updates');
    if (Updates.isEmbeddedLaunch) return '';
    const label = String(Updates.manifest?.extra?.label ?? '').trim();
    if (label) return label;
    const id = String(Updates.updateId ?? '').trim();
    return id ? id.slice(0, 8) : '';
  } catch {
    return '';
  }
}
