// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { create } from 'zustand';

import i18n from '@/src/i18n';
import {
  fetchInstances,
  hubLogout,
  isReachableInstance,
  type HubInstance,
  type HubSession,
} from '@/src/api/hubAuth';
import { storage } from './storage';

const TEAMS_KEY = 'cicy_teams_v1';
// QR-scanned custom teams, isolated PER ACCOUNT: { [email]: Team[] }. A team a
// user adds on this device belongs to that account only — a different account
// logging in must never inherit it.
const CUSTOMS_KEY = 'cicy_customs_by_account_v1';
const CLIENT_ID_KEY = 'cicy_client_id';
// The ACTIVE hub account: token + owner email + this phone's hub instance id.
// Older code and the http layer read the token/email keys directly.
const SESSION_KEY = 'cicy_session';
const USER_EMAIL_KEY = 'cicy_user_email';
const USER_ID_KEY = 'cicy_user_id';
// Every hub account ever signed in on this device: { email, token, instanceId,
// addedAt }[]. Powers the account switcher.
const ACCOUNTS_KEY = 'cicy_accounts_v1';
// Last instance directory of the active account — painted instantly on launch
// while the live list refreshes in the background.
const INSTANCES_KEY = 'cicy_hub_instances_v1';
// Retired stores from the cicy-cloud / hub-QR era — wiped once on load.
const LEGACY_KEYS = ['cicy_token', 'cicy_server_url', 'cicy_hub_v1'];

export type Team = {
  id: string;
  title: string;
  serverUrl: string;
  token: string;
  /** epoch ms — used to seed default order in the drawer. */
  addedAt: number;
  /** hub = one of the owner's cicy-code instances, mirrored from the hub
   *  directory (serverUrl is its hub hostname, token is the hub token);
   *  custom = QR-scanned self-hosted node (token is the node's own). */
  kind?: 'hub' | 'custom';
  /** hub teams: the hub instance id (`code-…`). */
  instanceId?: string;
  /** hub teams: liveness from the last directory refresh. */
  online?: boolean;
  /** hub teams: the node's cicy-code version. */
  version?: string;
  /** hub teams: how many agents the node last reported to the hub. */
  agentCount?: number;
};

type Persisted = {
  teams: Team[];
  currentTeamId: string | null;
};

export type HubAccount = {
  email: string;
  token: string;
  instanceId: string;
  addedAt: number;
};

type AuthState = {
  teams: Team[];
  currentTeamId: string | null;
  clientId: string;
  hydrated: boolean;
  /** Hub token of the active account; null = signed out. */
  session: string | null;
  userEmail: string | null;
  /** Every hub account signed in on this device (active one included). */
  accounts: HubAccount[];
  /** Latest instance directory of the active account (all rows, viewers too). */
  instances: HubInstance[];
  /** True while a directory refresh is in flight. */
  instancesLoading: boolean;
  /** Last directory refresh failure (i18n-able hub error code or message). */
  instancesError: string | null;
  hydrate: () => Promise<void>;
  /** Persist a fresh hub login as the active account and load its instances. */
  loginHub: (s: HubSession) => Promise<void>;
  /** Re-fetch the owner's instances and rebuild the hub-sourced teams. No-op
   *  without a session; keeps the cached list on a network failure; signs the
   *  account out when the hub says the token is gone. */
  syncInstances: () => Promise<void>;
  /** Make `email` the active account: restore its token, reload its instances
   *  and that account's QR-scanned customs. */
  switchAccount: (email: string) => Promise<void>;
  /** Forget an account on this device. Removing the ACTIVE one switches to the
   *  next remaining account, or signs out if it was the last. */
  removeAccount: (email: string) => Promise<void>;
  /** Drop the active account (revoking its hub token) and its hub teams;
   *  QR-scanned customs stay. */
  logoutHub: () => Promise<void>;
  // Convenience derivations for the API layer that reads `serverUrl` / `token`
  // directly from the store — the *currently selected* team, or null.
  serverUrl: string | null;
  token: string | null;
  /** Add a QR-scanned team and select it. Returns the new team id. */
  addTeam: (input: { serverUrl: string; token: string; title?: string }) => Promise<string>;
  /** Remove a custom team. If it was the current one, falls back to the first remaining team or null. */
  removeTeam: (id: string) => Promise<void>;
  /** Make `id` the active team. */
  switchTeam: (id: string) => Promise<void>;
  /** Rename a team — used by the title-edit modal. */
  renameTeam: (id: string, title: string) => Promise<void>;
  /** Wipe everything — sign out completely. */
  clear: () => Promise<void>;
};

function makeClientId() {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTeamId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
// Persist the custom (non-hub) subset of `teams` under the given account.
async function saveAccountCustoms(email: string | null | undefined, teams: Team[]) {
  try {
    const raw = await storage.getItem(CUSTOMS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[accountKey(email)] = teams.filter((tm) => tm.kind !== 'hub');
    await storage.setItem(CUSTOMS_KEY, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

// ── device account store ──────────────────────────────────────────────────────
async function loadAccounts(): Promise<HubAccount[]> {
  try {
    const raw = await storage.getItem(ACCOUNTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((a) => a?.email && a?.token) : [];
  } catch {
    return [];
  }
}
async function saveAccounts(list: HubAccount[]) {
  try {
    await storage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}
// Insert or refresh an account (keyed by lowercased email; keeps addedAt so the
// switcher order is stable across re-logins).
function upsertAccount(list: HubAccount[], s: HubSession): HubAccount[] {
  const key = accountKey(s.email);
  const prev = list.find((a) => accountKey(a.email) === key);
  const next: HubAccount = {
    email: s.email,
    token: s.token,
    instanceId: s.instanceId || prev?.instanceId || '',
    addedAt: prev?.addedAt ?? Date.now(),
  };
  return [...list.filter((a) => accountKey(a.email) !== key), next].sort(
    (a, b) => a.addedAt - b.addedAt,
  );
}

async function loadCachedInstances(): Promise<HubInstance[]> {
  try {
    const raw = await storage.getItem(INSTANCES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
async function saveCachedInstances(list: HubInstance[]) {
  try {
    await storage.setItem(INSTANCES_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

function selectCurrent(teams: Team[], currentTeamId: string | null) {
  const cur = teams.find((tm) => tm.id === currentTeamId) ?? null;
  return {
    serverUrl: cur?.serverUrl ?? null,
    token: cur?.token ?? null,
  };
}

// Map the hub directory into local Team rows — one per openable instance. The
// node base is its hub hostname; the hub token is the credential (the gateway
// swaps in the node's api token). addedAt is preserved from an existing row of
// the same id so re-syncs don't reshuffle the drawer order.
function buildHubTeams(session: string, instances: HubInstance[], now: number, prev: Team[]): Team[] {
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const out: Team[] = [];
  for (const inst of instances) {
    // Only machines that can actually be opened become teams; the rest are
    // hidden everywhere (list, drawer) until their tunnel comes back.
    if (!isReachableInstance(inst)) continue;
    const id = `inst:${inst.instanceId}`;
    out.push({
      id,
      title: inst.name || inst.proxyHost.split('.')[0],
      serverUrl: `https://${inst.proxyHost}`,
      token: session,
      addedAt: prevById.get(id)?.addedAt ?? now,
      kind: 'hub',
      instanceId: inst.instanceId,
      online: inst.online,
      version: inst.version || '',
      agentCount: Array.isArray(inst.agents) ? inst.agents.length : undefined,
    });
  }
  // Online machines first, then by name — the same order the desktop uses.
  out.sort((a, b) => Number(!!b.online) - Number(!!a.online) || a.title.localeCompare(b.title));
  return out;
}

// Merge hub teams + the account's customs, keeping the current selection when
// it still exists (else the first team). Writes store + persisted blob.
async function applyTeams(
  hubTeams: Team[],
  customs: Team[],
  preferredId: string | null,
  set: (p: Partial<AuthState>) => void,
) {
  const mirrored = new Set(hubTeams.map((tm) => tm.serverUrl));
  const teams = [...hubTeams, ...customs.filter((tm) => !mirrored.has(tm.serverUrl))];
  let currentTeamId = preferredId;
  if (!teams.some((tm) => tm.id === currentTeamId)) currentTeamId = teams[0]?.id ?? null;
  await persist(teams, currentTeamId);
  set({ teams, currentTeamId, ...selectCurrent(teams, currentTeamId) });
}

// Directory heartbeat: while signed in, re-fetch the owner's instances every
// 60s so liveness / new machines / removed machines propagate to the list.
// One shared timer for the whole app — a fresh login/switch resets it, logout
// stops it. Each beat is best-effort.
const HUB_HEARTBEAT_MS = 60_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat() {
  stopHeartbeat();
  void useAuthStore.getState().syncInstances(); // fire once now, then on the interval
  heartbeatTimer = setInterval(() => void useAuthStore.getState().syncInstances(), HUB_HEARTBEAT_MS);
  if (heartbeatTimer && typeof (heartbeatTimer as any).unref === 'function') {
    (heartbeatTimer as any).unref();
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  teams: [],
  currentTeamId: null,
  clientId: '',
  hydrated: false,
  session: null,
  userEmail: null,
  accounts: [],
  instances: [],
  instancesLoading: false,
  instancesError: null,
  serverUrl: null,
  token: null,

  hydrate: async () => {
    const [teamsRaw, clientId, session, userEmail, instanceId, accountsLoaded, cachedInstances] =
      await Promise.all([
        storage.getItem(TEAMS_KEY),
        storage.getItem(CLIENT_ID_KEY),
        storage.getItem(SESSION_KEY),
        storage.getItem(USER_EMAIL_KEY),
        storage.getItem(USER_ID_KEY),
        loadAccounts(),
        loadCachedInstances(),
      ]);
    // Wipe the retired cloud-session / hub-QR stores. A cicy-cloud `sk-sess-…`
    // session in SESSION_KEY is NOT a hub token — treat it as signed out so the
    // user is taken to the (new) hub login instead of hitting 401s forever.
    for (const k of LEGACY_KEYS) await storage.removeItem(k).catch(() => {});
    const validSession = session && !session.startsWith('sk-sess-') ? session : null;
    if (session && !validSession) {
      await Promise.all([
        storage.removeItem(SESSION_KEY).catch(() => {}),
        storage.removeItem(USER_EMAIL_KEY).catch(() => {}),
        storage.removeItem(USER_ID_KEY).catch(() => {}),
      ]);
    }
    // Accounts from the cloud era carried cloud sessions — drop those rows.
    let accounts = accountsLoaded.filter((a) => !String(a.token).startsWith('sk-sess-'));
    if (accounts.length !== accountsLoaded.length) await saveAccounts(accounts);
    // Migration: seed the account list with the active account if missing.
    if (validSession && userEmail && !accounts.some((a) => accountKey(a.email) === accountKey(userEmail))) {
      accounts = upsertAccount(accounts, { token: validSession, email: userEmail, instanceId: instanceId || '' });
      await saveAccounts(accounts);
    }
    set({
      session: validSession,
      userEmail: validSession ? userEmail || null : null,
      accounts,
      instances: validSession ? cachedInstances : [],
    });
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
        /* corrupt — start empty */
      }
    }
    // Rows of retired kinds (cloud-mirrored, hub-QR directory, the fabricated
    // default team) can only be stale — keep customs + this-era hub rows.
    const keep = (tm: Team) =>
      !(tm as any).builtin &&
      tm.id !== 'cloud-default' &&
      ((tm.kind === 'hub' && !!tm.instanceId) || tm.kind === 'custom' || tm.kind == null);
    if (!teams.every(keep)) teams = teams.filter(keep);
    // Hub rows belong to the active session; without one they cannot be reached.
    if (!validSession) teams = teams.filter((tm) => tm.kind !== 'hub');
    // Hub rows always carry the ACTIVE token (it may have been refreshed).
    if (validSession) teams = teams.map((tm) => (tm.kind === 'hub' ? { ...tm, token: validSession } : tm));
    if (!teams.some((tm) => tm.id === currentTeamId)) currentTeamId = teams[0]?.id ?? null;
    await persist(teams, currentTeamId);

    const { serverUrl, token } = selectCurrent(teams, currentTeamId);
    set({ teams, currentTeamId, clientId: cid, hydrated: true, serverUrl, token });

    if (validSession) startHeartbeat();
  },

  loginHub: async (s) => {
    const accounts = upsertAccount(get().accounts, s);
    await Promise.all([
      storage.setItem(SESSION_KEY, s.token),
      storage.setItem(USER_EMAIL_KEY, s.email),
      storage.setItem(USER_ID_KEY, s.instanceId || ''),
      saveAccounts(accounts),
    ]);
    const switching = accountKey(get().userEmail) !== accountKey(s.email);
    set({ session: s.token, userEmail: s.email, accounts, instancesError: null });
    if (switching) {
      // Another account's hub teams / customs must not linger; rebuild from
      // this account's customs now, hub teams arrive with the first sync.
      const customs = await loadAccountCustoms(s.email);
      set({ instances: [] });
      await applyTeams([], customs, null, set);
    } else {
      const teams = get().teams.map((tm) => (tm.kind === 'hub' ? { ...tm, token: s.token } : tm));
      await persist(teams, get().currentTeamId);
      set({ teams, ...selectCurrent(teams, get().currentTeamId) });
    }
    stopHeartbeat();
    // First directory fetch is awaited so the caller can route straight to
    // the machine list with real rows; the heartbeat then keeps it fresh.
    await get().syncInstances();
    startHeartbeat();
  },

  syncInstances: async () => {
    const session = get().session;
    if (!session) return;
    set({ instancesLoading: true });
    let fetched: HubInstance[];
    try {
      const r = await fetchInstances(session);
      fetched = r.instances;
    } catch (e: any) {
      const code = String(e?.code || e?.message || e);
      if (e?.code === 'unauthorized' && get().session === session) {
        // Token revoked (logout elsewhere / hub reset): drop this account so
        // the next launch asks for a fresh login instead of failing silently.
        set({ instancesLoading: false, instancesError: 'unauthorized' });
        await get().logoutHub();
        return;
      }
      set({ instancesLoading: false, instancesError: code });
      return; // network hiccup → keep the cached list
    }
    if (get().session !== session) return; // account switched mid-flight
    await saveCachedInstances(fetched);
    set({ instances: fetched, instancesLoading: false, instancesError: null });
    const hubTeams = buildHubTeams(session, fetched, Date.now(), get().teams);
    const customs = get().teams.filter((tm) => tm.kind !== 'hub');
    await applyTeams(hubTeams, customs, get().currentTeamId, set);
  },

  switchAccount: async (email) => {
    const acct = get().accounts.find((a) => accountKey(a.email) === accountKey(email));
    if (!acct || accountKey(get().userEmail) === accountKey(acct.email)) return;
    await get().loginHub({ token: acct.token, email: acct.email, instanceId: acct.instanceId });
  },

  removeAccount: async (email) => {
    const key = accountKey(email);
    const removed = get().accounts.find((a) => accountKey(a.email) === key);
    const accounts = get().accounts.filter((a) => accountKey(a.email) !== key);
    await saveAccounts(accounts);
    set({ accounts });
    if (removed && accountKey(get().userEmail) !== key) {
      await hubLogout(removed.token); // inactive account — revoke + list edit only
      return;
    }
    const fallback = accounts[0];
    if (fallback) {
      const active = get().session;
      if (active) await hubLogout(active);
      await get().loginHub({ token: fallback.token, email: fallback.email, instanceId: fallback.instanceId });
    } else {
      await get().logoutHub();
    }
  },

  logoutHub: async () => {
    const session = get().session;
    // Signing out forgets the ACTIVE account on this device too — a lingering
    // list entry with a revoked token is a switch-to-nothing trap.
    const accounts = get().accounts.filter((a) => accountKey(a.email) !== accountKey(get().userEmail));
    await Promise.all([
      storage.removeItem(SESSION_KEY).catch(() => {}),
      storage.removeItem(USER_EMAIL_KEY).catch(() => {}),
      storage.removeItem(USER_ID_KEY).catch(() => {}),
      storage.removeItem(INSTANCES_KEY).catch(() => {}),
      saveAccounts(accounts),
    ]);
    stopHeartbeat();
    if (session) await hubLogout(session);
    const remaining = get().teams.filter((tm) => tm.kind !== 'hub');
    let next = get().currentTeamId;
    if (!remaining.some((tm) => tm.id === next)) next = remaining[0]?.id ?? null;
    await persist(remaining, next);
    set({
      teams: remaining,
      currentTeamId: next,
      session: null,
      userEmail: null,
      accounts,
      instances: [],
      instancesLoading: false,
      instancesError: null,
      ...selectCurrent(remaining, next),
    });
  },

  addTeam: async ({ serverUrl, token, title }) => {
    const url = normalizeServerUrl(serverUrl);
    // De-dupe: if a team with the same server+token already exists, switch to
    // it instead of adding a duplicate row.
    const existing = get().teams.find((tm) => tm.serverUrl === url && tm.token === token);
    if (existing) {
      const teams = get().teams;
      await persist(teams, existing.id);
      set({ currentTeamId: existing.id, ...selectCurrent(teams, existing.id) });
      return existing.id;
    }
    const team: Team = {
      id: makeTeamId(),
      title: title?.trim() || defaultTeamTitle(),
      serverUrl: url,
      token,
      addedAt: Date.now(),
      kind: 'custom',
    };
    const teams = [...get().teams, team];
    await persist(teams, team.id);
    await saveAccountCustoms(get().userEmail, teams); // scope the new custom to this account
    set({ teams, currentTeamId: team.id, ...selectCurrent(teams, team.id) });
    return team.id;
  },

  removeTeam: async (id) => {
    const remaining = get().teams.filter((tm) => tm.id !== id);
    let next = get().currentTeamId;
    if (next === id) next = remaining[0]?.id ?? null;
    await persist(remaining, next);
    await saveAccountCustoms(get().userEmail, remaining); // keep this account's custom store in sync
    set({ teams: remaining, currentTeamId: next, ...selectCurrent(remaining, next) });
  },

  switchTeam: async (id) => {
    if (!get().teams.some((tm) => tm.id === id)) return;
    const teams = get().teams;
    await persist(teams, id);
    set({ currentTeamId: id, ...selectCurrent(teams, id) });
  },

  renameTeam: async (id, title) => {
    const teams = get().teams.map((tm) => (tm.id === id ? { ...tm, title: title.trim() || tm.title } : tm));
    await persist(teams, get().currentTeamId);
    set({ teams });
  },

  clear: async () => {
    const session = get().session;
    await Promise.all([
      storage.removeItem(SESSION_KEY).catch(() => {}),
      storage.removeItem(USER_EMAIL_KEY).catch(() => {}),
      storage.removeItem(USER_ID_KEY).catch(() => {}),
      storage.removeItem(ACCOUNTS_KEY).catch(() => {}),
      storage.removeItem(INSTANCES_KEY).catch(() => {}),
    ]);
    await persist([], null);
    stopHeartbeat();
    if (session) await hubLogout(session);
    set({
      teams: [],
      currentTeamId: null,
      session: null,
      userEmail: null,
      accounts: [],
      instances: [],
      instancesLoading: false,
      instancesError: null,
      serverUrl: null,
      token: null,
    });
  },
}));
