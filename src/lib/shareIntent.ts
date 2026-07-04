import { Platform } from 'react-native';

// Bridge to the local Expo module (modules/cicy-share-intent) that receives
// Android ACTION_SEND. Android-only: on web the share arrives via the
// /share route (Web Share Target), and iOS has no share extension yet —
// both fall through to the no-op branch.

function nativeModule(): any | null {
  if (Platform.OS !== 'android') return null;
  try {
    const { requireNativeModule } = require('expo-modules-core');
    return requireNativeModule('CicyShareIntent');
  } catch {
    return null; // module absent (old binary / Expo Go)
  }
}

/** Text shared while the app was cold-starting, if any. Clears on read. */
export function getInitialShare(): string | null {
  const mod = nativeModule();
  if (!mod) return null;
  try {
    const t = mod.getInitialShare();
    return typeof t === 'string' && t.trim() ? t : null;
  } catch {
    return null;
  }
}

/** Subscribe to shares arriving while the app is already running. */
export function subscribeShare(cb: (text: string) => void): () => void {
  const mod = nativeModule();
  if (!mod) return () => {};
  try {
    const { EventEmitter } = require('expo-modules-core');
    const emitter = new EventEmitter(mod);
    const sub = emitter.addListener('onShareIntent', (e: { text?: string }) => {
      const t = String(e?.text ?? '').trim();
      if (t) cb(t);
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}
