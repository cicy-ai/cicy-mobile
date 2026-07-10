// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// cicy-cloud device identity + account tier — mobile port of cicy-desktop's
// src/cloud/cloud-client.js device layer:
//
//   getDeviceId()    stable per-install id, persisted in storage. Prefixed by
//                    platform so the cloud/ops can tell clients apart at a
//                    glance: Android → "adr-…", iOS → "ios-…", web → "web-…".
//   registerDevice() POST /api/device/register {deviceId, platform, arch,
//                    systemLanguage}. Idempotent upsert by (owner, deviceId);
//                    the cloud stamps last_seen on every call, so re-posting on
//                    a 60s beat doubles as device liveness (desktop parity).
//   fetchTier()      GET /api/gateway/tunnels → {tier} — the account's plan
//                    level ("personal" | "team" | "enterprise"), shown as a
//                    badge next to the signed-in account.

import { Platform } from 'react-native';

import { storage } from '@/src/store/storage';

import { CLOUD_BASE } from './cloudAuth';

const DEVICE_ID_KEY = 'cicy_device_id';

function platformPrefix(): string {
  if (Platform.OS === 'android') return 'adr';
  if (Platform.OS === 'ios') return 'ios';
  return 'web';
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const g: any = globalThis as any;
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = Math.floor(Math.random() * 256) ^ (Date.now() & 0xff);
    }
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

let cachedId: string | null = null;

/** Stable device id, minted once per install (e.g. `adr-3fa9…` on Android). */
export async function getDeviceId(): Promise<string> {
  if (cachedId) return cachedId;
  const existing = await storage.getItem(DEVICE_ID_KEY);
  if (existing) {
    cachedId = existing;
    return existing;
  }
  const id = `${platformPrefix()}-${randomHex(16)}`;
  await storage.setItem(DEVICE_ID_KEY, id);
  cachedId = id;
  return id;
}

/** Upsert this device with the cloud. Throws on HTTP failure (callers beat-and-forget). */
export async function registerDevice(session: string): Promise<void> {
  const deviceId = await getDeviceId();
  let systemLanguage = '';
  try {
    systemLanguage = Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {
    /* older Hermes without Intl — field is optional */
  }
  const res = await fetch(`${CLOUD_BASE}/api/device/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, platform: Platform.OS, arch: '', systemLanguage }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export type CloudTier = 'personal' | 'team' | 'enterprise' | '';

/** The account's plan level — same source as desktop's 套餐 badge (tunnel:status). */
export async function fetchTier(session: string): Promise<CloudTier> {
  const res = await fetch(`${CLOUD_BASE}/api/gateway/tunnels`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j: any = await res.json().catch(() => null);
  return String(j?.tier || '') as CloudTier;
}
