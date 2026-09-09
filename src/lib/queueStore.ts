// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Per-agent outbox for messages typed while a reply is in flight. It used to be
// plain screen state, so leaving the chat (back to the list, another agent,
// app backgrounded and killed) silently dropped every queued message. The
// queue now lives here — in memory for instant restore, mirrored to storage so
// it survives a restart — keyed by server + agent.
import { storage } from '@/src/store/storage';

export type QueuedMessage = { id: number; text: string };

const KEY = 'cicy_outbox_v1';
const mem = new Map<string, QueuedMessage[]>();
let loaded: Promise<void> | null = null;

function queueKey(serverUrl: string | null | undefined, agentId: string): string {
  return `${String(serverUrl || '').replace(/\/+$/, '')}|${agentId}`;
}

async function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const raw = await storage.getItem(KEY);
        const obj = raw ? JSON.parse(raw) : {};
        for (const [k, v] of Object.entries(obj)) {
          if (Array.isArray(v) && v.length && !mem.has(k)) {
            mem.set(k, v.filter((q: any) => q && typeof q.text === 'string' && q.text.trim()).map((q: any, i: number) => ({ id: Number(q.id) || i + 1, text: String(q.text) })));
          }
        }
      } catch {
        /* corrupt / unavailable → start empty */
      }
    })();
  }
  return loaded;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const obj: Record<string, QueuedMessage[]> = {};
    mem.forEach((v, k) => { if (v.length) obj[k] = v; });
    storage.setItem(KEY, JSON.stringify(obj)).catch(() => {});
  }, 150);
}

/** Queued messages for this agent (restored from storage on first call). */
export async function loadQueue(serverUrl: string | null | undefined, agentId: string): Promise<QueuedMessage[]> {
  await ensureLoaded();
  return mem.get(queueKey(serverUrl, agentId)) ?? [];
}

/** Replace this agent's queue (called on every change from the chat screen). */
export function saveQueue(serverUrl: string | null | undefined, agentId: string, queue: QueuedMessage[]): void {
  const k = queueKey(serverUrl, agentId);
  if (queue.length) mem.set(k, queue);
  else mem.delete(k);
  scheduleSave();
}
