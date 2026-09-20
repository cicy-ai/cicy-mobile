// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

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

// expo-updates only checks at cold start (checkAutomatically: ON_LOAD) and
// an Android app can stay warm for days, so a hot update published after the
// last cold start is never noticed. Hook: check (+ download) whenever the app
// comes to the foreground, throttled; the useUpdates() consumers then show the
// "update ready, tap to apply" banner.
const FOREGROUND_CHECK_MIN_MS = 2 * 60 * 1000;
export function useOtaForegroundCheck(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let Updates: any;
    try {
      Updates = require('expo-updates');
    } catch {
      return;
    }
    if (!Updates?.isEnabled) return;
    let last = 0;
    let busy = false;
    const check = async () => {
      if (busy || Date.now() - last < FOREGROUND_CHECK_MIN_MS) return;
      busy = true;
      last = Date.now();
      try {
        const r = await Updates.checkForUpdateAsync();
        if (r?.isAvailable) await Updates.fetchUpdateAsync();
      } catch {
        /* offline / manifest unreachable — try again next foreground */
      } finally {
        busy = false;
      }
    };
    // First check a little after launch (the ON_LOAD check may still be
    // running; a second one right away is wasted).
    const t = setTimeout(() => void check(), 15_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void check();
    });
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, []);
}
