import { create } from 'zustand';

import i18n from '@/src/i18n';
import { storage } from './storage';

const TEAMS_KEY = 'cicy_teams_v1';
const CLIENT_ID_KEY = 'cicy_client_id';
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
  hydrate: () => Promise<void>;
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

export const useAuthStore = create<AuthState>((set, get) => ({
  teams: [],
  currentTeamId: null,
  clientId: '',
  hydrated: false,
  serverUrl: null,
  token: null,

  hydrate: async () => {
    const [teamsRaw, clientId] = await Promise.all([
      storage.getItem(TEAMS_KEY),
      storage.getItem(CLIENT_ID_KEY),
    ]);
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

  clear: async () => {
    await persist([], null);
    set({ teams: [], currentTeamId: null, serverUrl: null, token: null });
  },
}));
