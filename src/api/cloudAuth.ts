// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// cicy-cloud email magic-link DEVICE-POLL login — verbatim port of
// cicy-desktop/src/backends/auth-email.js (cloud contract by w-10122):
//
//   1. generate a high-entropy `state` (it IS the retrieval credential)
//   2. POST /api/auth/email/request {email, state, flow:'desktop_poll'}
//   3. user clicks the magic link on ANY device
//   4. poll GET /api/auth/desktop/poll?state=… until `ready` (one-time
//      consumed) → { token: sk-sess-…, email, user_id }
//
// The sk-sess- session is the SOLE Bearer for every cloud /api/* — mobile
// treats {serverUrl: cicy-ai.com, token: session} as just another Team.

export const CLOUD_BASE = 'https://cicy-ai.com';
const REQUEST_URL = `${CLOUD_BASE}/api/auth/email/request`;
const POLL_URL = `${CLOUD_BASE}/api/auth/desktop/poll`;
const POLL_EVERY_MS = 2500;
const TIMEOUT_MS = 600_000; // 10 min — matches the cloud state TTL

export type CloudSession = {
  token: string;
  email: string;
  userId: string;
};

// High-entropy hex. Web + modern Hermes have crypto.getRandomValues; the
// Math.random mix is a functional fallback only (state is one-time, 10-min
// TTL, TLS-only).
export function randomState(): string {
  const bytes = new Uint8Array(24);
  const g: any = globalThis as any;
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256) ^ (Date.now() & 0xff);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

/** Step 1+2: register state and trigger the magic-link email. */
export async function requestEmailLogin(email: string, state: string): Promise<void> {
  const res = await fetch(REQUEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), state, flow: 'desktop_poll' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export type PollOutcome =
  | { ok: true; session: CloudSession }
  | { ok: false; error: 'timeout' | 'expired' | 'cancelled' };

/**
 * Step 4: poll until ready/expired/timeout. `isCancelled` is checked between
 * ticks so the caller (login screen unmount / retry) can stop the loop.
 */
export async function pollForSession(
  state: string,
  isCancelled: () => boolean,
): Promise<PollOutcome> {
  const startedAt = Date.now();
  for (;;) {
    if (isCancelled()) return { ok: false, error: 'cancelled' };
    if (Date.now() - startedAt > TIMEOUT_MS) return { ok: false, error: 'timeout' };
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    if (isCancelled()) return { ok: false, error: 'cancelled' };
    try {
      const r = await fetch(`${POLL_URL}?state=${encodeURIComponent(state)}`);
      if (r.status === 404) return { ok: false, error: 'expired' };
      const j: any = await r.json().catch(() => ({}));
      if (j.status === 'ready' && j.token) {
        return {
          ok: true,
          session: {
            token: String(j.token),
            email: String(j.email || ''),
            userId: j.user_id != null ? String(j.user_id) : '',
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

/** Cloud team list (post-login) — merged into the drawer by the auth store. */
export type CloudTeam = {
  id?: number | string;
  title?: string;
  kind?: string; // cloud | private | custom
  host_url?: string;
  workspace_url?: string;
  // zero-trust gateway address (<slug>.gw.cicy-ai.com) — preferred serverUrl when
  // present (the team's node is reached through the gateway). Empty otherwise.
  gateway_url?: string;
  api_key?: string;
};

export async function fetchCloudTeams(session: string): Promise<CloudTeam[]> {
  const res = await fetch(`${CLOUD_BASE}/api/teams`, {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j: any = await res.json().catch(() => null);
  if (Array.isArray(j)) return j;
  if (Array.isArray(j?.teams)) return j.teams;
  if (Array.isArray(j?.data)) return j.data;
  return [];
}
