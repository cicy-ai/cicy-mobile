// Cross-platform key/value storage.
//
// - Native (iOS / Android): expo-secure-store backed by Keychain / EncryptedSharedPreferences.
// - Web: localStorage. Not really "secure" — but the token is no more sensitive than
//   the cicy-code session cookie that would otherwise sit in the same browser, and
//   web is only used for the preview/dev case.
//
// We import SecureStore lazily so Metro doesn't pull its native bindings into the web
// bundle (which is what was throwing `getValueWithKeyAsync is not a function`).
import { Platform } from 'react-native';

type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

const webStorage: Storage = {
  async getItem(key) {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  },
  async setItem(key, value) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  },
  async removeItem(key) {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  },
};

function makeNativeStorage(): Storage {
  // Require synchronously — on native this resolves to the real module; on web
  // we never enter this branch so Metro never asks for it.
  const SecureStore = require('expo-secure-store') as typeof import('expo-secure-store');
  return {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    removeItem: (key) => SecureStore.deleteItemAsync(key),
  };
}

export const storage: Storage = Platform.OS === 'web' ? webStorage : makeNativeStorage();
