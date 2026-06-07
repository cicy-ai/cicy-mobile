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

        {/* Telegram Mini App SDK — injects window.Telegram.WebApp when opened
            inside Telegram. Harmless in a plain browser. MUST be async: a
            plain head script render-blocks, and telegram.org is unreachable
            from mainland-China browsers — a sync (or defer, which stalls the
            in-order deferred queue) load would freeze first paint until the
            connection times out. Consumers read window.Telegram lazily. */}
        <script async src="https://telegram.org/js/telegram-web-app.js" />

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

const SW_REGISTER = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (e) {
      console.warn('SW registration failed:', e);
    });
  });
}
`;
