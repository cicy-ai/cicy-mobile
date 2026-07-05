import { create } from 'zustand';

import i18n from '@/src/i18n';
import { CLOUD_BASE, fetchCloudTeams, type CloudSession } from '@/src/api/cloudAuth';
import { storage } from './storage';

const TEAMS_KEY = 'cicy_teams_v1';
const CLIENT_ID_KEY = 'cicy_client_id';
const SESSION_KEY = 'cicy_session';
const USER_EMAIL_KEY = 'cicy_user_email';
const USER_ID_KEY = 'cicy_user_id';
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
  /** cloud = came from cicy-cloud (token is the session); custom = QR-scanned. */
  kind?: 'cloud' | 'custom';
  /** The built-in default team — pinned on top, not removable. */
  builtin?: boolean;
};

type Persisted = {
  teams: Team[];
  currentTeamId: string | null;
};

type AuthState = {
  teams: Team[];
  currentTeamId: string | null;
  clientId: string;
  hydrated: boolean;
  /** cicy-cloud session (sk-sess-…); null = not signed in to the cloud. */
  session: string | null;
  userEmail: string | null;
  hydrate: () => Promise<void>;
  /** Persist a fresh cloud login: session + built-in default team + cloud team list. */
  loginCloud: (s: CloudSession) => Promise<void>;
  /** Drop the cloud session and every cloud-sourced team; QR-scanned customs stay. */
  logoutCloud: () => Promise<void>;
  // Convenience derivations exposed for the API layer that still reads
  // `serverUrl` / `token` directly from the store. These shadow Team fields
  // for the *currently selected* team. When no team is selected they're null,
  // and `requireAuth()` in http.ts throws as it always did.
  serverUrl: string | null;
  token: string | null;
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

function selectCurrent(teams: Team[], currentTeamId: string | null) {
  const cur = teams.find((tm) => tm.id === currentTeamId) ?? null;
  return {
    serverUrl: cur?.serverUrl ?? null,
    token: cur?.token ?? null,
  };
}

// The default-team title is localized; cloud teams keep their cloud titles.
function defaultCloudTeamTitle(): string {
  return i18n.t('teams.cloudDefaultTitle', { defaultValue: '默认团队' });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  teams: [],
  currentTeamId: null,
  clientId: '',
  hydrated: false,
  session: null,
  userEmail: null,
  serverUrl: null,
  token: null,

  hydrate: async () => {
    const [teamsRaw, clientId, session, userEmail] = await Promise.all([
      storage.getItem(TEAMS_KEY),
      storage.getItem(CLIENT_ID_KEY),
      storage.getItem(SESSION_KEY),
      storage.getItem(USER_EMAIL_KEY),
    ]);
    set({ session: session || null, userEmail: userEmail || null });
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

    const { serverUrl, token } = selectCurrent(teams, currentTeamId);
    set({ teams, currentTeamId, clientId: cid, hydrated: true, serverUrl, token });
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
    const sel = selectCurrent(teams, team.id);
    set({ teams, currentTeamId: team.id, ...sel });
    return team.id;
  },

  removeTeam: async (id) => {
    const remaining = get().teams.filter((tm) => tm.id !== id);
    let next = get().currentTeamId;
    if (next === id) next = remaining[0]?.id ?? null;
    await persist(remaining, next);
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
    await Promise.all([
      storage.setItem(SESSION_KEY, s.token),
      storage.setItem(USER_EMAIL_KEY, s.email),
      storage.setItem(USER_ID_KEY, s.userId),
    ]);

    // A) Synthesize the built-in default team and select it. The cloud lazily
    //    seeds its cicy roles on the first /api/panes hit — nothing else needed.
    const now = Date.now();
    let teams = get().teams.filter((tm) => !(tm.kind === 'cloud')); // re-login replaces cloud rows
    const builtin: Team = {
      id: 'cloud-default',
      title: defaultCloudTeamTitle(),
      serverUrl: CLOUD_BASE,
      token: s.token,
      addedAt: now,
      kind: 'cloud',
      builtin: true,
    };
    teams = [builtin, ...teams];

    // B) Merge the user's cloud teams (kind=cloud/private → session auth).
    //    Tokenless customs from the cloud are skipped — they need a QR scan
    //    for their own token anyway; never clobber locally scanned rows.
    try {
      const cloudTeams = await fetchCloudTeams(s.token);
      const seen = new Set(teams.map((tm) => tm.serverUrl.replace(/\/+$/, '')));
      for (const ct of cloudTeams) {
        const kind = String(ct.kind || 'cloud');
        if (kind === 'custom') continue;
        const url = String(ct.workspace_url || ct.host_url || CLOUD_BASE).replace(/\/+$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        teams.push({
          id: `cloud-${ct.id ?? url}`,
          title: String(ct.title || url.replace(/^https?:\/\//, '')),
          serverUrl: url,
          token: s.token,
          addedAt: now,
          kind: 'cloud',
        });
      }
    } catch {
      // team list is a nice-to-have — the default team alone is a full login
    }

    await persist(teams, builtin.id);
    const sel = selectCurrent(teams, builtin.id);
    set({ teams, currentTeamId: builtin.id, session: s.token, userEmail: s.email, ...sel });
  },

  logoutCloud: async () => {
    await Promise.all([
      storage.removeItem(SESSION_KEY).catch(() => {}),
      storage.removeItem(USER_EMAIL_KEY).catch(() => {}),
      storage.removeItem(USER_ID_KEY).catch(() => {}),
    ]);
    const remaining = get().teams.filter((tm) => tm.kind !== 'cloud');
    let next = get().currentTeamId;
    if (!remaining.some((tm) => tm.id === next)) next = remaining[0]?.id ?? null;
    await persist(remaining, next);
    const sel = selectCurrent(remaining, next);
    set({ teams: remaining, currentTeamId: next, session: null, userEmail: null, ...sel });
  },

  clear: async () => {
    await Promise.all([
      storage.removeItem(SESSION_KEY).catch(() => {}),
      storage.removeItem(USER_EMAIL_KEY).catch(() => {}),
      storage.removeItem(USER_ID_KEY).catch(() => {}),
    ]);
    await persist([], null);
    set({ teams: [], currentTeamId: null, session: null, userEmail: null, serverUrl: null, token: null });
  },
}));
