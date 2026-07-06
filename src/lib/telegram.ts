// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Telegram Mini App glue. When the app is opened inside Telegram, the
// telegram-web-app.js SDK (loaded in app/+html.tsx) exposes
// `window.Telegram.WebApp` with a signed `initData` launch payload (the backend
// verifies its HMAC against the workspace's bot token), theme/viewport controls,
// and a native QR scanner. Everywhere else — native app, plain browser/PWA —
// `getWebApp()` returns null, `isTelegram()` is false, and the normal
// scan/paste add-team flow takes over. All functions are safe no-ops off-Telegram.

type TgWebApp = {
  initData: string;
  version?: string;
  ready: () => void;
  expand: () => void;
  isVersionAtLeast?: (v: string) => boolean;
  showScanQrPopup?: (params: { text?: string }, callback?: (text: string) => boolean) => void;
  closeScanQrPopup?: () => void;
  onEvent?: (event: string, cb: (...args: any[]) => void) => void;
  offEvent?: (event: string, cb: (...args: any[]) => void) => void;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
};

function getWebApp(): TgWebApp | null {
  if (typeof window === 'undefined') return null;
  const tg = (window as any)?.Telegram?.WebApp;
  return tg && typeof tg === 'object' ? (tg as TgWebApp) : null;
}

// True only when launched inside Telegram with a real signed payload.
export function isTelegram(): boolean {
  const tg = getWebApp();
  return !!tg && typeof tg.initData === 'string' && tg.initData.length > 0;
}

// Call once at startup: tell Telegram the app is ready and request full height.
export function initWebApp(): void {
  // The TG SDK is injected dynamically and only inside Telegram (+html.tsx —
  // telegram.org would hang the window load event elsewhere), so it may land
  // AFTER React mounts. Retry briefly until window.Telegram.WebApp appears;
  // outside Telegram the loader never runs and this gives up quietly.
  let tries = 0;
  const attempt = () => {
    const tg = getWebApp();
    if (!tg) {
      if (tries++ < 50) setTimeout(attempt, 100);
      return;
    }
    try {
      tg.ready();
    } catch {}
    try {
      tg.expand();
    } catch {}
  };
  attempt();
}

// The signed launch payload to POST to the backend for verification + token
// exchange. Empty string when not in Telegram.
export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

// Show Telegram's native header back button and wire it to `onClick` (so a
// screen can drop its own in-app nav bar and reuse Telegram's chrome — saving
// vertical space). Returns a cleanup that unhooks + hides it. No-op off-Telegram.
export function showBackButton(onClick: () => void): () => void {
  const bb = getWebApp()?.BackButton;
  if (!bb) return () => {};
  try {
    bb.onClick(onClick);
    bb.show();
  } catch {}
  return () => {
    try {
      bb.offClick(onClick);
      bb.hide();
    } catch {}
  };
}

// Whether Telegram's native QR scanner is available (Bot API 6.4+).
export function canScanQr(): boolean {
  const tg = getWebApp();
  if (!tg || typeof tg.showScanQrPopup !== 'function') return false;
  return !tg.isVersionAtLeast || tg.isVersionAtLeast('6.4');
}

// Open Telegram's native QR scanner. Resolves with the scanned text, or null if
// the user cancelled / it isn't supported. Closes the popup on the first read.
export function scanQr(prompt?: string): Promise<string | null> {
  const tg = getWebApp();
  if (!tg || typeof tg.showScanQrPopup !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      try {
        tg.offEvent?.('qrTextReceived', onReceived);
        tg.offEvent?.('scanQrPopupClosed', onClosed);
      } catch {}
      resolve(val);
    };
    const onReceived = (payload: any) => {
      const text = typeof payload === 'string' ? payload : (payload?.data ?? '');
      try {
        tg.closeScanQrPopup?.();
      } catch {}
      finish(String(text || ''));
    };
    const onClosed = () => finish(null);
    try {
      tg.onEvent?.('qrTextReceived', onReceived);
      tg.onEvent?.('scanQrPopupClosed', onClosed);
      tg.showScanQrPopup!({ text: prompt });
    } catch {
      finish(null);
    }
  });
}
