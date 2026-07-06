// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Platform } from 'react-native';

import type { HistoryTurn } from '@/src/api/types';

// Two-tier cache for an agent's committed history window, so reopening an agent
// paints the last-seen conversation INSTANTLY instead of showing a spinner on
// every open (the "每次都要loading" problem). Mirrors cicy-code's web approach
// (in-memory `window._cacheHistory` + persistent IndexedDB):
//
//   • memory  — a module-level Map; survives in-session navigation, zero cost.
//   • persistent — web: localStorage; native: expo-file-system (new sync API).
//                  Survives a full reload / app restart.
//
// Both reads are synchronous, so `get()` can feed the first render with no async
// gap. The cache is best-effort and NOT authoritative: HistoryView always
// refetches fresh on open and reconciles, so a slightly stale cached frame is
// only ever shown for the ~300ms until the network responds. Positional
// history_ids can drift, which is exactly why we never *trust* the cache — we
// only use it to avoid the blank loading state.

export type HistorySnapshot = {
  conversationId: string;
  maxId: number;
  minId: number;
  hasMore: boolean;
  turns: HistoryTurn[];
  ts: number;
  v: number;
};

const V = 1; // bump when HistorySnapshot / HistoryTurn shape changes (invalidates old)
const MAX_TURNS = 40; // cap persisted size (a window is ~16; keep a little extra)
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ignore cache older than a week
const key = (id: string) => `cicy_hist_${id}`;

const MEM = new Map<string, HistorySnapshot>();

function nativeFile(id: string): any | null {
  try {
    // Lazy require so the web bundle never pulls native bindings.
    const { File, Paths } = require('expo-file-system');
    return new File(Paths.cache, `${key(id)}.json`);
  } catch {
    return null;
  }
}

function readPersisted(id: string): HistorySnapshot | null {
  try {
    let raw: string | null = null;
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return null;
      raw = localStorage.getItem(key(id));
    } else {
      const f = nativeFile(id);
      if (!f || !f.exists) return null;
      raw = f.text();
    }
    if (!raw) return null;
    const snap = JSON.parse(raw) as HistorySnapshot;
    if (!snap || snap.v !== V) return null;
    if (!snap.ts || Date.now() - snap.ts > MAX_AGE_MS) return null;
    return snap;
  } catch {
    return null;
  }
}

function writePersisted(id: string, snap: HistorySnapshot) {
  try {
    const raw = JSON.stringify(snap);
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key(id), raw);
      return;
    }
    const f = nativeFile(id);
    if (!f) return;
    if (!f.exists) f.create();
    f.write(raw);
  } catch {
    /* cache is best-effort; quota/IO errors are non-fatal */
  }
}

export const historyCache = {
  /** Synchronous read: memory first, then persistent (hydrates memory). */
  get(id: string): HistorySnapshot | null {
    const m = MEM.get(id);
    if (m) return m;
    const p = readPersisted(id);
    if (p) MEM.set(id, p);
    return p;
  },
  /** Write-through to memory + persistent. */
  put(id: string, snap: Omit<HistorySnapshot, 'ts' | 'v'>) {
    const full: HistorySnapshot = {
      ...snap,
      turns: snap.turns.slice(-MAX_TURNS),
      ts: Date.now(),
      v: V,
    };
    MEM.set(id, full);
    writePersisted(id, full);
  },
};
