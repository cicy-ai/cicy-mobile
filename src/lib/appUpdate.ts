// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Self-update check for the sideloaded build (no app store, no adb): CI writes
// a version manifest (after the packages, so it can never point at a missing
// file); the agents screen shows a banner when it's newer than the installed
// build. Served via the worker (m.cicy-ai.com/version.json) — a domain-stable,
// geo-agnostic URL that reads OSS first, R2 second, so the app is decoupled
// from the storage backend (todo46 R2→OSS migration).
const VERSION_URL = 'https://m.cicy-ai.com/version.json';

export type ApkUpdate = { version: string; apk: string };

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newer APK available? null when up-to-date / not Android / check failed. */
export async function checkApkUpdate(): Promise<ApkUpdate | null> {
  if (Platform.OS !== 'android') return null;
  const installed = String(Constants.expoConfig?.version ?? '').trim();
  if (!installed) return null;
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return null;
    const j = (await res.json()) as ApkUpdate;
    const latest = String(j?.version ?? '').trim();
    const apk = String(j?.apk ?? '').trim();
    if (!latest || !apk) return null;
    return cmpSemver(latest, installed) > 0 ? { version: latest, apk } : null;
  } catch {
    return null;
  }
}
