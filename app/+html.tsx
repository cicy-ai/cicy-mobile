// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

// Root HTML wrapper for the static web/PWA export. Expo Router renders every
// route inside this shell at build time. We use it to attach the PWA manifest,
// Apple "add to home screen" metadata, theme colors, and to register the
// service worker. Native (iOS/Android) builds never touch this file.
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* viewport-fit=cover so the app paints under the notch / home indicator
            when launched full-screen from the home screen. maximum-scale stops
            iOS auto-zooming form fields, which feels broken in a standalone app. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
        />

        {/* Telegram Mini App SDK — loaded ONLY when actually running inside
            Telegram (tgWebApp* in the launch hash / TelegramWebviewProxy).
            telegram.org is unreachable from mainland-China browsers, and even
            an async <script> holds the window `load` event hostage until the
            connection times out — which kept embedding hosts (e.g. cicy-code's
            artifact iframe overlay, which waits for `load`) spinning forever.
            Inside Telegram the script resolves via TG's own webview network. */}
        <script dangerouslySetInnerHTML={{ __html: CHUNK_HEAL }} />
        <script dangerouslySetInnerHTML={{ __html: TG_SDK_LOADER }} />

        {/* PWA manifest + theme color (light/dark aware for the browser chrome). */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#FAF9F5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#1A1915" media="(prefers-color-scheme: dark)" />

        {/* iOS "add to home screen" — full-screen standalone app, no Safari chrome. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="CiCy" />
        <link rel="apple-touch-icon" href="/icon.png" />
        <link rel="icon" href="/favicon.png" />

        {/* Avoid a flash of white before React paints — match the light theme bg.
            (Dark-mode users get a brief light flash; acceptable for a first cut.) */}
        <style dangerouslySetInnerHTML={{ __html: BACKGROUND_CSS }} />

        <ScrollViewStyleReset />

        <script dangerouslySetInnerHTML={{ __html: SW_REGISTER }} />
      </head>
      <body>
        {children}
        {/* Boot splash — pure HTML/CSS so it paints the instant the document
            parses, long before the multi-megabyte JS bundle finishes. The app
            removes #boot-splash from _layout.tsx once React mounts. */}
        <div id="boot-splash">
          <div className="boot-spinner" />
        </div>
        <style dangerouslySetInnerHTML={{ __html: SPLASH_CSS }} />
      </body>
    </html>
  );
}

const SPLASH_CSS = `
#boot-splash {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background-color: #FAF9F5;
}
@media (prefers-color-scheme: dark) {
  #boot-splash { background-color: #1A1915; }
}
.boot-spinner {
  width: 28px; height: 28px;
  border: 3px solid rgba(128,128,128,0.25);
  border-top-color: #E8651A;
  border-radius: 50%;
  animation: boot-spin 0.8s linear infinite;
}
@keyframes boot-spin { to { transform: rotate(360deg); } }
`;

const BACKGROUND_CSS = `
html, body { background-color: #FAF9F5; }
@media (prefers-color-scheme: dark) {
  html, body { background-color: #1A1915; }
}
/* RN-web renders TextInput as <input>/<textarea>, which the browser gives a
   focus outline. The app draws its own focused border, so kill the default. */
input, textarea, [contenteditable] { outline: none !important; }
`;

// Self-heal after a deploy: a session loaded before the deploy may lazy-load a
// route chunk whose URL no longer exists (the SPA fallback answers with HTML)
// or whose module ids no longer match ("Requiring unknown module"). Detect
// those signatures, wipe caches, and reload ONCE (sessionStorage guard; the
// flag is cleared after a healthy boot in bootSplash.ts).
const CHUNK_HEAL = `
(function () {
  function bad(msg) {
    return /Requiring unknown module|Unexpected token '<'|ChunkLoadError|dynamically imported module|Importing a module script failed|AsyncRequireError|Loading module .* failed/.test(msg || '');
  }
  function heal() {
    try {
      if (sessionStorage.getItem('cicy-chunk-heal')) return;
      sessionStorage.setItem('cicy-chunk-heal', '1');
      var reload = function () { location.reload(); };
      if (window.caches && caches.keys) {
        caches.keys().then(function (ks) {
          return Promise.all(ks.map(function (k) { return caches.delete(k); }));
        }).then(reload, reload);
        setTimeout(reload, 1500);
      } else {
        reload();
      }
    } catch (e) {
      location.reload();
    }
  }
  window.addEventListener('error', function (e) { if (bad(e && e.message)) heal(); }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var m = e && e.reason && (e.reason.message || String(e.reason));
    if (bad(m)) heal();
  });
})();
`;

const TG_SDK_LOADER = `
(function () {
  // Load the Telegram Mini App SDK so window.Telegram.WebApp exists (needed for
  // the in-Telegram QR scanner, theme, etc). Two constraints:
  //   1. It MUST load inside every Telegram client — the previous gate
  //      (tgWebApp in hash/search || TelegramWebviewProxy) missed some clients,
  //      so the scanner silently disappeared.
  //   2. It must NEVER hold the window 'load' event hostage: telegram.org is
  //      unreachable from mainland China and even an async <script> in <head>
  //      keeps embedding hosts (e.g. cicy-code's artifact iframe, which waits
  //      for 'load') spinning until the connection times out.
  // So: if we can already tell we're inside Telegram, inject immediately (fast
  // path for the scanner). Otherwise inject only AFTER 'load' has fired — the
  // SDK still arrives (initWebApp/canScanQr poll for it), but it can no longer
  // block first paint or the embedder's load event.
  function inject() {
    try {
      if (window.Telegram && window.Telegram.WebApp) return;
      var s = document.createElement('script');
      s.src = 'https://telegram.org/js/telegram-web-app.js';
      s.async = true;
      document.head.appendChild(s);
    } catch (e) {}
  }
  try {
    var inTg = /tgWebApp/i.test(location.hash) || /tgWebApp/i.test(location.search) ||
      typeof window.TelegramWebviewProxy !== 'undefined';
    if (inTg) { inject(); return; }
    if (document.readyState === 'complete') setTimeout(inject, 0);
    else window.addEventListener('load', function () { setTimeout(inject, 0); });
  } catch (e) {}
})();
`;

const SW_REGISTER = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (e) {
      console.warn('SW registration failed:', e);
    });
  });
}
`;
