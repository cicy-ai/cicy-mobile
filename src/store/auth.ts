// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { create } from 'zustand';

import i18n from '@/src/i18n';
import { fetchCloudTeams, type CloudSession } from '@/src/api/cloudAuth';
import type { HubAgent } from '@/src/api/hubws';
import { fetchTier, registerDevice } from '@/src/api/cloudDevice';
import { storage } from './storage';

const TEAMS_KEY = 'cicy_teams_v1';
// QR-scanned custom teams, isolated PER ACCOUNT: { [email]: Team[] }. A team a
// user adds on this device belongs to that account only — a different account
// logging in must never inherit it.
const CUSTOMS_KEY = 'cicy_customs_by_account_v1';
const CLIENT_ID_KEY = 'cicy_client_id';
const SESSION_KEY = 'cicy_session';
const USER_EMAIL_KEY = 'cicy_user_email';
const USER_ID_KEY = 'cicy_user_id';
// Hub connection (parallel to teams, ONE per device): { url, token }. Scanned
// via a hub QR; `token` is a typ=hub JWT. Drives the Hub entry above the teams.
const HUB_KEY = 'cicy_hub_v1';
// Every cloud account ever signed in on this device: { email, token, userId,
// addedAt }[]. SESSION_KEY/USER_EMAIL_KEY stay the ACTIVE account (older code
// and the http layer read them); this list powers the account switcher.
const ACCOUNTS_KEY = 'cicy_accounts_v1';
// Legacy keys — migrated to a single team on first launch, then never read.
const LEGACY_TOKEN_KEY = 'cicy_token';
const LEGACY_SERVER_KEY = 'cicy_server_url';

export type Team = {
  id: string;
  title: string;
  serverUrl: string;
  token: string;
  /** epoch ms — used to seed default order in the drawer. */
  addedAt: number;
  /** cloud = came from cicy-cloud (token is the session); custom = QR-scanned;
   *  hub = derived from the connected Hub's directory (token is the hubToken,
   *  sent via the normal Bearer header — the node accepts it). */
  kind?: 'cloud' | 'custom' | 'hub';
  /**
   * The server-side team_kind of a mirrored row ('cloud' | 'custom' | 'private'
   * | 'local'). Only true cloud-hosted tenants ('cloud') use the panes-only
   * roster; self-host nodes behave like QR-scanned teams. Absent on
   * locally-scanned rows.
   */
  serverKind?: string;
  /** The built-in default team — pinned on top, not removable. */
  builtin?: boolean;
};

type Persisted = {
  teams: Team[];
  currentTeamId: string | null;
};

// A scanned Hub connection. The app can hold several; teams are sourced from
// the union of their directories (each reached with that hub's token).
export type HubConn = { id: string; url: string; token: string; title?: string };

// One hub's latest directory snapshot, handed to setHubTeams by the persistent
// HubConnector so the team list can be rebuilt across ALL connected hubs.
export type HubDirEntry = { hubId: string; hubToken: string; agents: HubAgent[] };

export type CloudAccount = {
  email: string;
  /** sk-sess-… login session for this account. */
  token: string;
  userId: string;
  addedAt: number;
};

type AuthState = {
  teams: Team[];
  currentTeamId: string | null;
  clientId: string;
  hydrated: boolean;
  /** cicy-cloud session (sk-sess-…); null = not signed in to the cloud. */
  session: string | null;
  userEmail: string | null;
  /** Account plan level from the cloud ("personal" | "team" | "enterprise");
   *  null = unknown / not signed in. Refreshed on the 60s cloud heartbeat. */
  tier: string | null;
  /** Every cloud account signed in on this device (active one included). */
  accounts: CloudAccount[];
  /** Make `email` the active account: restore its session and rebuild the team
   *  list (mirrored cloud teams + that account's QR-scanned customs). */
  switchAccount: (email: string) => Promise<void>;
  /** Forget an account on this device. Removing the ACTIVE one switches to the
   *  next remaining account, or signs out of the cloud if it was the last. */
  removeAccount: (email: string) => Promise<void>;
  hydrate: () => Promise<void>;
  /** Persist a fresh cloud login: session + the user's cloud team list (mirrored
   *  from the server — no client-fabricated default team). */
  loginCloud: (s: CloudSession) => Promise<void>;
  /** Re-mirror cloud teams from the server so deletions/additions propagate to
   *  the local list. QR-scanned customs are untouched. No-op without a session;
   *  keeps the cache on a fetch failure. */
  syncCloudTeams: () => Promise<void>;
  /** Drop the cloud session and every cloud-sourced team; QR-scanned customs stay. */
  logoutCloud: () => Promise<void>;
  // Convenience derivations exposed for the API layer that still reads
  // `serverUrl` / `token` directly from the store. These shadow Team fields
  // for the *currently selected* team. When no team is selected they're null,
  // and `requireAuth()` in http.ts throws as it always did.
  serverUrl: string | null;
  token: string | null;
  /** Replace the team list with the connected Hub's teams — one per `<team>`
   *  group in the directory, reached at the node base with the hubToken via
   *  `?token=`. Called by the HubScreen whenever the directory changes. */
  setHubTeams: (entries: HubDirEntry[]) => Promise<void>;
  /** Add a new team and select it. Returns the new team id. */
  addTeam: (input: { serverUrl: string; token: string; title?: string }) => Promise<string>;
  /** Remove a team. If it was the current one, falls back to the first remaining team or null. */
  removeTeam: (id: string) => Promise<void>;
  /** Make `id` the active team. */
  switchTeam: (id: string) => Promise<void>;
  /** Rename a team — used by the title-edit modal. */
  renameTeam: (id: string, title: string) => Promise<void>;
  /** Wipe everything — sign out completely. */
  clear: () => Promise<void>;

  // ── Hubs (several scanned connections; teams are sourced from them) ──
  /** Every scanned Hub connection on this device. */
  hubs: HubConn[];
  /** Add a scanned Hub connection (from a hub QR). Appends; de-dupes by url. */
  connectHub: (p: { url: string; token: string; title?: string }) => Promise<void>;
  /** Forget one Hub connection by id. */
  disconnectHub: (id: string) => Promise<void>;
};

function makeClientId() {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTeamId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeHubId() {
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Default title for a team added without one — localized "My Team". The
// configured i18n singleton is imported via '@/src/i18n' (initialized at app
// root before any addTeam can run). The user can rename later via the
// title-edit modal.
function defaultTeamTitle(): string {
  return i18n.t('teams.defaultTitle', { defaultValue: 'My Team' });
}

function normalizeServerUrl(s: string): string {
  return s.trim().replace(/\/+$/, '');
}

async function persist(teams: Team[], currentTeamId: string | null) {
  const payload: Persisted = { teams, currentTeamId };
  await storage.setItem(TEAMS_KEY, JSON.stringify(payload));
}

// ── per-account custom-team store ─────────────────────────────────────────────
function accountKey(email: string | null | undefined): string {
  return String(email || '').toLowerCase();
}
async function loadAccountCustoms(email: string | null | undefined): Promise<Team[]> {
  try {
    const raw = await storage.getItem(CUSTOMS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const list = map[accountKey(email)];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
// Persist the custom (non-cloud) subset of `teams` under the given account.
async function saveAccountCustoms(email: string | null | undefined, teams: Team[]) {
  try {
    const raw = await storage.getItem(CUSTOMS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[accountKey(email)] = teams.filter((tm) => tm.kind !== 'cloud');
    await storage.setItem(CUSTOMS_KEY, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

// ── device account store ──────────────────────────────────────────────────────
async function loadAccounts(): Promise<CloudAccount[]> {
  try {
    const raw = await storage.getItem(ACCOUNTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((a) => a?.email && a?.token) : [];
  } catch {
    return [];
  }
}
async function saveAccounts(list: CloudAccount[]) {
  try {
    await storage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}
// Insert or refresh an account (keyed by lowercased email; keeps addedAt so the
// switcher order is stable across re-logins).
function upsertAccount(list: CloudAccount[], s: CloudSession): CloudAccount[] {
  const key = accountKey(s.email);
  const prev = list.find((a) => accountKey(a.email) === key);
  const next: CloudAccount = {
    email: s.email,
    token: s.token,
    userId: s.userId,
    addedAt: prev?.addedAt ?? Date.now(),
  };
  return [...list.filter((a) => accountKey(a.email) !== key), next].sort(
    (a, b) => a.addedAt - b.addedAt,
  );
}

function selectCurrent(teams: Team[], currentTeamId: string | null) {
  const cur = teams.find((tm) => tm.id === currentTeamId) ?? null;
  return {
    serverUrl: cur?.serverUrl ?? null,
    token: cur?.token ?? null,
  };
}

// Cloud heartbeat (desktop parity, MAIN-process equivalent): while signed in,
// every 60s re-register this device (the cloud stamps last_seen → device
// liveness), re-mirror the team list, and refresh the account tier badge. One
// shared timer for the whole app — a fresh login/switch resets it, logout stops
// it. Each beat is best-effort: a failed leg never throws out of here.
const CLOUD_HEARTBEAT_MS = 60_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function cloudBeat() {
  const st = useAuthStore.getState();
  const session = st.session;
  if (!session) {
    stopCloudHeartbeat();
    return;
  }
  await registerDevice(session).catch(() => {});
  // Teams come from the connected Hub now — no longer mirrored from /api/teams.
  // (The cloud session still drives device liveness + the account tier badge.)
  try {
    const tier = await fetchTier(session);
    // Guard against a race: only apply if the same account is still active.
    if (useAuthStore.getState().session === session) useAuthStore.setState({ tier });
  } catch {
    /* keep the last-known tier on a network blip */
  }
}

function startCloudHeartbeat() {
  stopCloudHeartbeat();
  void cloudBeat(); // fire once now, then on the interval
  heartbeatTimer = setInterval(() => void cloudBeat(), CLOUD_HEARTBEAT_MS);
  if (heartbeatTimer && typeof (heartbeatTimer as any).unref === 'function') {
    (heartbeatTimer as any).unref();
  }
}

function stopCloudHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Map the server's cloud team list into local Team rows (the cloud is the source
// of truth). Only rows with a reachable address become teams — /api/teams also
// returns dead "local" registration residue (host_url empty); those must NOT
// fall back to CLOUD_BASE (cicy-ai.com is not a cicy-code API), they're skipped.
// Self-host rows (custom/private) embed the node's token in host_url (?token=…):
// split it out so serverUrl is the bare origin and token is the node credential;
// cloud-hosted rows authenticate with the login session. Dedupe by URL.
// addedAt is preserved from an existing row of the same id so re-syncs don't
// reshuffle the drawer order.
function buildCloudTeams(session: string, now: number, fetched: any[], prev: Team[]): Team[] {
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const out: Team[] = [];
  const seen = new Set<string>();
  for (const ct of Array.isArray(fetched) ? fetched : []) {
    const raw = String(ct?.gateway_url || ct?.workspace_url || ct?.host_url || '').trim();
    if (!raw) continue; // dead registration row — no address, not a team
    let url: string;
    let token = session;
    try {
      const u = new URL(raw);
      const embedded = u.searchParams.get('token');
      if (embedded) token = embedded;
      url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const id = `cloud-${ct?.id ?? url}`;
    out.push({
      id,
      title: String(ct?.title || url.replace(/^https?:\/\//, '')),
      serverUrl: url,
      token,
      addedAt: prevById.get(id)?.addedAt ?? now,
      kind: 'cloud',
      serverKind: String(ct?.team_kind || ct?.kind || 'cloud'),
    });
  }
  return out;
}

// Map the connected Hub's directory into local Team rows — one per `<team>`
// group. The node base is the agent's reach_url (https://<team>.hub.cicy-ai.com),
// shared by every agent in that team; the hubToken is the team's token, sent via
// the normal Bearer header (the node accepts it). addedAt is preserved from an
// existing row of the same id so re-syncs don't reshuffle the drawer order.
function buildHubTeams(entries: HubDirEntry[], now: number, prev: Team[]): Team[] {
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const out: Team[] = [];
  const seen = new Set<string>();
  for (const { hubId, hubToken, agents } of entries) {
    for (const a of agents) {
      const team = a.team;
      if (!team) continue;
      // Team id is scoped to its hub so the same team name on two hubs doesn't
      // collide (and disconnectHub can prune by the `hub:<hubId>:` prefix).
      const id = `hub:${hubId}:${team}`;
      if (seen.has(id)) continue;
      const serverUrl = String(a.reach_url || '').replace(/\/+$/, '');
      if (!serverUrl) continue;
      seen.add(id);
      out.push({
        id,
        title: team,
        serverUrl,
        token: hubToken,
        addedAt: prevById.get(id)?.addedAt ?? now,
        kind: 'hub',
      });
    }
  }
  return out;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  teams: [],
  currentTeamId: null,
  clientId: '',
  hydrated: false,
  session: null,
  userEmail: null,
  tier: null,
  accounts: [],
  serverUrl: null,
  token: null,
  hubs: [],

  connectHub: async (p) => {
    const url = p.url.replace(/\/+$/, '');
    const existing = get().hubs.find((h) => h.url === url);
    // Re-scanning a known hub refreshes its token in place (no duplicate row).
    const hubs = existing
      ? get().hubs.map((h) => (h.url === url ? { ...h, token: p.token, title: p.title ?? h.title } : h))
      : [...get().hubs, { id: makeHubId(), url, token: p.token, title: p.title }];
    await storage.setItem(HUB_KEY, JSON.stringify(hubs));
    set({ hubs });
  },
  disconnectHub: async (id) => {
    const hubs = get().hubs.filter((h) => h.id !== id);
    await storage.setItem(HUB_KEY, JSON.stringify(hubs));
    set({ hubs });
    // Its teams disappear on the connector's next recompute; also prune now so
    // the drawer updates immediately even if that hub's socket is already gone.
    const teams = get().teams.filter((tm) => !tm.id.startsWith(`hub:${id}:`));
    let currentTeamId = get().currentTeamId;
    if (!teams.some((tm) => tm.id === currentTeamId)) currentTeamId = teams[0]?.id ?? null;
    await persist(teams, currentTeamId);
    set({ teams, currentTeamId, ...selectCurrent(teams, currentTeamId) });
  },

  setHubTeams: async (entries) => {
    const prev = get().teams;
    const now = Date.now();
    const hubTeams = buildHubTeams(entries, now, prev);
    // The directory streams agent_upsert frames on every metric tick — rebuild
    // only writes the store when the TEAM SET actually changed (id+url+token),
    // otherwise each tick would churn the team list and loop React updates.
    const sig = (ts: Team[]) => ts.map((t) => `${t.id}|${t.serverUrl}|${t.token}`).sort().join(',');
    if (sig(prev) === sig(hubTeams)) return;
    // The Hub is the sole source of teams now — replace the list entirely.
    // Keep the current selection if that team is still present, else pick the
    // first (the coordinator's team tends to sort first in the directory).
    let currentTeamId = get().currentTeamId;
    if (!hubTeams.some((tm) => tm.id === currentTeamId)) currentTeamId = hubTeams[0]?.id ?? null;
    await persist(hubTeams, currentTeamId);
    const sel = selectCurrent(hubTeams, currentTeamId);
    set({ teams: hubTeams, currentTeamId, ...sel });
  },

  hydrate: async () => {
    const [teamsRaw, clientId, session, userEmail, userId, accountsLoaded, hubRaw] = await Promise.all([
      storage.getItem(TEAMS_KEY),
      storage.getItem(CLIENT_ID_KEY),
      storage.getItem(SESSION_KEY),
      storage.getItem(USER_EMAIL_KEY),
      storage.getItem(USER_ID_KEY),
      loadAccounts(),
      storage.getItem(HUB_KEY),
    ]);
    let hubs: HubConn[] = [];
    try {
      const parsed = hubRaw ? JSON.parse(hubRaw) : null;
      // New format: an array of HubConn. Legacy: a single { url, token } object.
      const rows = Array.isArray(parsed) ? parsed : parsed?.url ? [parsed] : [];
      hubs = rows
        .filter((h: any) => h?.url && h?.token)
        .map((h: any) => ({
          id: String(h.id || makeHubId()),
          url: String(h.url).replace(/\/+$/, ''),
          token: String(h.token),
          title: h.title ? String(h.title) : undefined,
        }));
    } catch { /* ignore corrupt */ }
    set({ hubs });
    // Migration: devices signed in before the account switcher existed have a
    // session but an empty ACCOUNTS_KEY — seed the list with the active account.
    let accounts = accountsLoaded;
    if (session && userEmail && !accounts.some((a) => accountKey(a.email) === accountKey(userEmail))) {
      accounts = upsertAccount(accounts, { token: session, email: userEmail, userId: userId || '' });
      await saveAccounts(accounts);
    }
    set({ session: session || null, userEmail: userEmail || null, accounts });
    let cid = clientId;
    if (!cid) {
      cid = makeClientId();
      await storage.setItem(CLIENT_ID_KEY, cid);
    }

    let teams: Team[] = [];
    let currentTeamId: string | null = null;

    if (teamsRaw) {
      try {
        const parsed = JSON.parse(teamsRaw) as Persisted;
        if (Array.isArray(parsed.teams)) teams = parsed.teams;
        currentTeamId = parsed.currentTeamId ?? (teams[0]?.id ?? null);
      } catch {
        /* corrupt — fall through to migration */
      }
    }

    // Migration: if we found no teams blob but the device still has legacy
    // single-team creds in SecureStore, promote them to teams[0]. Then drop
    // the legacy keys so we don't keep migrating.
    if (teams.length === 0) {
      const [legacyToken, legacyServer] = await Promise.all([
        storage.getItem(LEGACY_TOKEN_KEY),
        storage.getItem(LEGACY_SERVER_KEY),
      ]);
      if (legacyToken && legacyServer) {
        const team: Team = {
          id: makeTeamId(),
          title: defaultTeamTitle(),
          serverUrl: normalizeServerUrl(legacyServer),
          token: legacyToken,
          addedAt: Date.now(),
        };
        teams = [team];
        currentTeamId = team.id;
        await persist(teams, currentTeamId);
        await storage.removeItem(LEGACY_TOKEN_KEY).catch(() => {});
        await storage.removeItem(LEGACY_SERVER_KEY).catch(() => {});
      }
    }

    // Purge the retired built-in default team (client-fabricated; no longer
    // served cloud-side). It was pinned locally and never synced, so it lingers
    // in old persisted blobs — drop it on load.
    if (teams.some((tm) => tm.builtin || tm.id === 'cloud-default')) {
      teams = teams.filter((tm) => !(tm.builtin || tm.id === 'cloud-default'));
      if (!teams.some((tm) => tm.id === currentTeamId)) currentTeamId = teams[0]?.id ?? null;
      await persist(teams, currentTeamId);
    }

    const { serverUrl, token } = selectCurrent(teams, currentTeamId);
    set({ teams, currentTeamId, clientId: cid, hydrated: true, serverUrl, token });

    // Signed in to the cloud → start the desktop-parity heartbeat: register
    // this device, mirror the team list, refresh the account tier — then keep
    // beating every 60s. Non-blocking; keeps cache on failure.
    if (session) startCloudHeartbeat();
  },

  addTeam: async ({ serverUrl, token, title }) => {
    const url = normalizeServerUrl(serverUrl);
    // De-dupe: if a team with the same server+token already exists, switch to
    // it instead of adding a duplicate row.
    const existing = get().teams.find((tm) => tm.serverUrl === url && tm.token === token);
    if (existing) {
      const teams = get().teams;
      await persist(teams, existing.id);
      const sel = selectCurrent(teams, existing.id);
      set({ currentTeamId: existing.id, ...sel });
      return existing.id;
    }
    const team: Team = {
      id: makeTeamId(),
      title: (title?.trim() || defaultTeamTitle()),
      serverUrl: url,
      token,
      addedAt: Date.now(),
    };
    const teams = [...get().teams, team];
    await persist(teams, team.id);
    await saveAccountCustoms(get().userEmail, teams); // scope the new custom to this account
    const sel = selectCurrent(teams, team.id);
    set({ teams, currentTeamId: team.id, ...sel });
    return team.id;
  },

  removeTeam: async (id) => {
    const remaining = get().teams.filter((tm) => tm.id !== id);
    let next = get().currentTeamId;
    if (next === id) next = remaining[0]?.id ?? null;
    await persist(remaining, next);
    await saveAccountCustoms(get().userEmail, remaining); // keep this account's custom store in sync
    const sel = selectCurrent(remaining, next);
    set({ teams: remaining, currentTeamId: next, ...sel });
  },

  switchTeam: async (id) => {
    if (!get().teams.some((tm) => tm.id === id)) return;
    const teams = get().teams;
    await persist(teams, id);
    const sel = selectCurrent(teams, id);
    set({ currentTeamId: id, ...sel });
  },

  renameTeam: async (id, title) => {
    const teams = get().teams.map((tm) => (tm.id === id ? { ...tm, title: title.trim() || tm.title } : tm));
    await persist(teams, get().currentTeamId);
    set({ teams });
  },

  loginCloud: async (s) => {
    // Record the account on the device list (switcher), then activate it.
    const accounts = upsertAccount(get().accounts, s);
    await Promise.all([
      storage.setItem(SESSION_KEY, s.token),
      storage.setItem(USER_EMAIL_KEY, s.email),
      storage.setItem(USER_ID_KEY, s.userId),
      saveAccounts(accounts),
    ]);
    // Teams come from the connected Hubs now — NOT from /api/teams. Cloud login
    // only drives the account switcher + device liveness + the tier badge; the
    // team list is left to the HubConnector. (buildCloudTeams / fetchCloudTeams
    // are retired here on purpose.)
    set({ session: s.token, userEmail: s.email, tier: null });
    startCloudHeartbeat();
  },

  syncCloudTeams: async () => {
    const session = get().session;
    if (!session) return;
    let fetched: any[];
    try {
      fetched = await fetchCloudTeams(session);
    } catch {
      return; // network hiccup → keep the cached list, don't wipe cloud rows
    }
    const now = Date.now();
    const cloudTeams = buildCloudTeams(session, now, fetched, get().teams);
    const customs = get().teams.filter((tm) => tm.kind !== 'cloud');
    // Mirrored row wins over a locally-scanned duplicate of the same node.
    const mirrored = new Set(cloudTeams.map((tm) => tm.serverUrl));
    const teams = [...cloudTeams, ...customs.filter((tm) => !mirrored.has(tm.serverUrl))];
    let currentTeamId = get().currentTeamId;
    if (!teams.some((tm) => tm.id === currentTeamId)) currentTeamId = teams[0]?.id ?? null;
    await persist(teams, currentTeamId);
    const sel = selectCurrent(teams, currentTeamId);
    set({ teams, currentTeamId, ...sel });
  },

  switchAccount: async (email) => {
    const acct = get().accounts.find((a) => accountKey(a.email) === accountKey(email));
    if (!acct || accountKey(get().userEmail) === accountKey(acct.email)) return;
    // Reuse the login path: it re-upserts the account (no-op), activates the
    // session, and rebuilds teams (mirrored cloud rows + THIS account's customs).
    // An expired session degrades gracefully — buildCloudTeams fetch fails and
    // the drawer shows customs only; re-login from the account refreshes it.
    await get().loginCloud({ token: acct.token, email: acct.email, userId: acct.userId });
  },

  removeAccount: async (email) => {
    const key = accountKey(email);
    const accounts = get().accounts.filter((a) => accountKey(a.email) !== key);
    await saveAccounts(accounts);
    set({ accounts });
    if (accountKey(get().userEmail) !== key) return; // inactive account — list edit only
    const fallback = accounts[0];
    if (fallback) {
      await get().loginCloud({ token: fallback.token, email: fallback.email, userId: fallback.userId });
    } else {
      await get().logoutCloud();
    }
  },

  logoutCloud: async () => {
    // Signing out forgets the ACTIVE account on this device too — a lingering
    // list entry with a possibly-revoked session is a switch-to-nothing trap.
    const accounts = get().accounts.filter(
      (a) => accountKey(a.email) !== accountKey(get().userEmail),
    );
    await Promise.all([
      storage.removeItem(SESSION_KEY).catch(() => {}),
      storage.removeItem(USER_EMAIL_KEY).catch(() => {}),
      storage.removeItem(USER_ID_KEY).catch(() => {}),
      saveAccounts(accounts),
    ]);
    const remaining = get().teams.filter((tm) => tm.kind !== 'cloud');
    let next = get().currentTeamId;
    if (!remaining.some((tm) => tm.id === next)) next = remaining[0]?.id ?? null;
    await persist(remaining, next);
    const sel = selectCurrent(remaining, next);
    stopCloudHeartbeat();
    set({ teams: remaining, currentTeamId: next, session: null, userEmail: null, tier: null, accounts, ...sel });
  },

  clear: async () => {
    await Promise.all([
      storage.removeItem(SESSION_KEY).catch(() => {}),
      storage.removeItem(USER_EMAIL_KEY).catch(() => {}),
      storage.removeItem(USER_ID_KEY).catch(() => {}),
      storage.removeItem(ACCOUNTS_KEY).catch(() => {}),
      storage.removeItem(HUB_KEY).catch(() => {}),
    ]);
    await persist([], null);
    stopCloudHeartbeat();
    set({ teams: [], currentTeamId: null, session: null, userEmail: null, tier: null, accounts: [], serverUrl: null, token: null, hubs: [] });
  },
}));
