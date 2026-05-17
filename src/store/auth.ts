import { create } from 'zustand';

import { DEFAULT_SERVER_URL, DEFAULT_TOKEN } from '../config/defaults';
import { storage } from './storage';

const TOKEN_KEY = 'cicy_token';
const SERVER_KEY = 'cicy_server_url';
const CLIENT_ID_KEY = 'cicy_client_id';

type AuthState = {
  token: string | null;
  serverUrl: string | null;
  clientId: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setCredentials: (serverUrl: string, token: string) => Promise<void>;
  clear: () => Promise<void>;
};

function makeClientId() {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  serverUrl: null,
  clientId: '',
  hydrated: false,

  hydrate: async () => {
    const [storedToken, storedServer, clientId] = await Promise.all([
      storage.getItem(TOKEN_KEY),
      storage.getItem(SERVER_KEY),
      storage.getItem(CLIENT_ID_KEY),
    ]);
    let cid = clientId;
    if (!cid) {
      cid = makeClientId();
      await storage.setItem(CLIENT_ID_KEY, cid);
    }
    // Stored value wins over the compile-time default — but the default
    // pre-fills Settings so the user doesn't retype it on a fresh install.
    const serverUrl = storedServer || DEFAULT_SERVER_URL || null;
    const token = storedToken || DEFAULT_TOKEN || null;
    set({ token, serverUrl, clientId: cid, hydrated: true });
  },

  setCredentials: async (serverUrl, token) => {
    const normalized = serverUrl.replace(/\/+$/, '');
    await storage.setItem(SERVER_KEY, normalized);
    await storage.setItem(TOKEN_KEY, token);
    set({ serverUrl: normalized, token });
  },

  clear: async () => {
    await storage.removeItem(TOKEN_KEY);
    await storage.removeItem(SERVER_KEY);
    set({ token: null, serverUrl: null });
  },
}));
