// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

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

// Hook: is a freshly-downloaded OTA update waiting to be applied? Wraps
// expo-updates' useUpdates so callers stay platform-safe (web/no-module → false).
export function useOtaReady(): { ready: boolean; apply: () => void } {
  if (Platform.OS === 'web') return { ready: false, apply: () => {} };
  try {
    const Updates = require('expo-updates');
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { isUpdatePending } = Updates.useUpdates();
    return {
      ready: !!isUpdatePending,
      apply: () => { Updates.reloadAsync().catch(() => {}); },
    };
  } catch {
    return { ready: false, apply: () => {} };
  }
}
