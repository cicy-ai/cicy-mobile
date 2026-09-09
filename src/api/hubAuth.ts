// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// CiCy Hub (cicy-ws-hub) sign-in + instance directory — the phone's ONLY
// account system. Same contract cicy-desktop/src/backends/hub-client.js uses:
//
//   POST /api/login/start {email, instanceId, name, platform} → {state}
//        (a 6-digit code + magic link is mailed to the address)
//   POST /api/login/code  {state, code}                        → approved
//   GET  /api/login/poll?state=…  → pending | expired | ready {token, owner}
//   GET  /api/instances   Bearer → every cicy-code of the same owner (email),
//        each with its hub hostname (proxyHost), liveness and an agents snapshot
//   POST /api/logout      Bearer → revokes the token
//
// The phone registers itself as a hub instance (`code-mobile-…`, platform
// `mobile-<os>`) because hub tokens are bound to (owner, instance). It never
// heartbeats, so the hub hides it from the list on both sides.
//
// Reaching an instance: https://<proxyHost>/ is the instance's own cicy-code
// API, and the hub gateway accepts the owner's hub token as Bearer (swapping in
// the node's api token on the way through) — so an instance is just a Team
// whose serverUrl is that host and whose token is the hub token.

import { Platform } from 'react-native';

import { storage } from '@/src/store/storage';

const DEFAULT_ORIGIN = 'https://ws.cicy-ai.com';
const INSTANCE_ID_KEY = 'cicy_hub_instance_id_v1';
const POLL_EVERY_MS = 2500;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000; // hub loginTTL
const FETCH_TIMEOUT_MS = 20_000;

export function hubOrigin(): string {
  const env = String(process.env.EXPO_PUBLIC_CICY_HUB_ORIGIN || '').trim();
  return (env || DEFAULT_ORIGIN).replace(/\/+$/, '');
}

export type HubSession = {
  token: string;
  /** Lower-cased owner email — the tenant. */
  email: string;
  instanceId: string;
};

/** One row of GET /api/instances (fields mobile reads). */
export type HubInstance = {
  instanceId: string;
  name: string;
  platform: string;
  /** `<slug>.hub.cicy-ai.com` — empty until the node has signed in with a name. */
  proxyHost: string;
  proxyAvailable: boolean;
  online: boolean;
  self: boolean;
  version?: string;
  arch?: string;
  lastSeenAt?: string;
  cpuCores?: number;
  memoryTotalMB?: number;
  resources?: Record<string, any> | null;
  ports?: any[];
  /** Agent snapshot the node published over its hub socket (may be absent). */
  agents?: HubAgentSnapshot[];
  agentsUpdatedAt?: string;
};

export type HubAgentSnapshot = {
  agentId: string;
  title?: string;
  agentType?: string;
  role?: string;
  status?: string;
  model?: string | null;
  online?: boolean;
  working?: boolean;
  contextUsedPct?: number;
  latestQuestion?: string;
  latestResponse?: string;
};

export type HubError = Error & { code?: string; status?: number };

function hubError(code: string, status?: number): HubError {
  const e = new Error(code) as HubError;
  e.code = code;
  e.status = status;
  return e;
}

export function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const g: any = globalThis as any;
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(Math.random() * 256) ^ (Date.now() & 0xff);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Stable per-device hub instance id (hub requires `code-` + 16..96 [A-Za-z0-9_-]).
export async function mobileInstanceId(): Promise<string> {
  let id = '';
  try {
    id = String((await storage.getItem(INSTANCE_ID_KEY)) || '');
  } catch {}
  if (/^code-[A-Za-z0-9_-]{16,96}$/.test(id)) return id;
  id = `code-mobile-${randomHex(12)}`;
  try {
    await storage.setItem(INSTANCE_ID_KEY, id);
  } catch {}
  return id;
}

async function hubFetch(
  route: string,
  { method = 'GET', token = '', body = null as any } = {},
): Promise<{ status: number; ok: boolean; json: any }> {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body != null) headers['content-type'] = 'application/json';
    const res = await fetch(hubOrigin() + route, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(killer);
  }
}

function errorCodeOf(res: { status: number; json: any }, fallback: string): string {
  return String((res.json && (res.json.error || res.json.message)) || fallback);
}

/** Step 1: mail a code + link to `email`. Returns the poll state. */
export async function startLogin(email: string): Promise<{ state: string; expiresInSec: number }> {
  const addr = email.trim().toLowerCase();
  if (!isValidEmail(addr)) throw hubError('invalid_email');
  const instanceId = await mobileInstanceId();
  const os = Platform.OS === 'web' ? 'web' : Platform.OS;
  const name = `mobile-${os}-${instanceId.slice(-4)}`;
  const res = await hubFetch('/api/login/start', {
    method: 'POST',
    body: { email: addr, instanceId, name, platform: `mobile-${os}` },
  });
  if (!res.ok || !res.json?.state) throw hubError(errorCodeOf(res, 'login_start_failed'), res.status);
  return { state: String(res.json.state), expiresInSec: Number(res.json.expiresInSec || 0) };
}

/** Step 2a: approve the pending login with the mailed 6-digit code. */
export async function submitCode(state: string, code: string): Promise<void> {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) throw hubError('invalid_code');
  const res = await hubFetch('/api/login/code', { method: 'POST', body: { state, code: c } });
  if (!res.ok) throw hubError(errorCodeOf(res, 'invalid_code'), res.status);
}

export type PollOutcome =
  | { ok: true; session: HubSession }
  | { ok: false; error: 'timeout' | 'expired' | 'cancelled' };

/**
 * Step 2b/3: poll until the login is approved (by code OR by the mail link,
 * on any device). `isCancelled` is checked between ticks. `kick` resolves a
 * pending wait early (call it right after a successful submitCode so the
 * token is fetched at once instead of after the next tick).
 */
export async function pollLogin(
  state: string,
  isCancelled: () => boolean,
  kick?: { wake: () => void },
): Promise<PollOutcome> {
  const startedAt = Date.now();
  for (;;) {
    if (isCancelled()) return { ok: false, error: 'cancelled' };
    if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) return { ok: false, error: 'timeout' };
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, POLL_EVERY_MS);
      if (kick) kick.wake = () => { clearTimeout(t); resolve(); };
    });
    if (isCancelled()) return { ok: false, error: 'cancelled' };
    try {
      const res = await hubFetch(`/api/login/poll?state=${encodeURIComponent(state)}`);
      const j = res.json || {};
      if (j.status === 'ready' && j.token) {
        return {
          ok: true,
          session: {
            token: String(j.token),
            email: String(j.owner || '').toLowerCase(),
            instanceId: String(j.instanceId || ''),
          },
        };
      }
      if (j.status === 'expired') return { ok: false, error: 'expired' };
      // pending → keep polling
    } catch {
      // transient network blip — keep polling until the overall timeout
    }
  }
}

/** The owner's instances. Throws a HubError with code 'unauthorized' on 401. */
export async function fetchInstances(token: string): Promise<{ owner: string; instances: HubInstance[] }> {
  const res = await hubFetch('/api/instances', { token });
  if (res.status === 401) throw hubError('unauthorized', 401);
  if (!res.ok || !res.json) throw hubError(errorCodeOf(res, 'instances_failed'), res.status);
  const list: any[] = Array.isArray(res.json.instances) ? res.json.instances : [];
  const instances: HubInstance[] = list.map((i) => ({
    instanceId: String(i.instanceId || ''),
    name: String(i.name || (i.proxyHost ? String(i.proxyHost).split('.')[0] : i.instanceId || '')),
    platform: String(i.platform || ''),
    proxyHost: String(i.proxyHost || ''),
    proxyAvailable: !!i.proxyAvailable,
    online: !!i.online,
    self: !!i.self,
    version: i.version ? String(i.version) : '',
    arch: i.arch ? String(i.arch) : '',
    lastSeenAt: i.lastSeenAt ? String(i.lastSeenAt) : '',
    cpuCores: Number(i.cpuCores || 0),
    memoryTotalMB: Number(i.memoryTotalMB || 0),
    resources: i.resources && typeof i.resources === 'object' ? i.resources : null,
    ports: Array.isArray(i.ports) ? i.ports : [],
    agents: Array.isArray(i.agents) ? i.agents : undefined,
    agentsUpdatedAt: i.agentsUpdatedAt ? String(i.agentsUpdatedAt) : '',
  }));
  return { owner: String(res.json.owner || '').toLowerCase(), instances };
}

/** Is this row a real cicy-code node the phone can open (not a viewer login)? */
export function isOpenableInstance(i: HubInstance): boolean {
  if (i.self) return false;
  if (/^(desktop|mobile)/i.test(i.platform)) return false;
  return !!i.proxyHost;
}

export async function hubLogout(token: string): Promise<void> {
  try {
    await hubFetch('/api/logout', { method: 'POST', token });
  } catch {
    /* best-effort: the local credential is dropped regardless */
  }
}
