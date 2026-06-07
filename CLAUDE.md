@AGENTS.md

# cicy-mobile

Expo (bare workflow) + expo-router app for the CiCy agent platform — iOS / Android
native builds **and** a static web/PWA export from the same codebase. CiCy 平台的
移动端:看 agent 列表、进聊天、扫码加 team。

## Test URLs — ALWAYS give the user the external-IP URL

When you start a local server and hand the user a URL to open, the URL **must** be
the machine's external (public) IP + port — never `localhost` and never the LAN
`172.x` address. The host sits behind an HTTP proxy (`*_proxy` env vars point at
`127.0.0.1:1087`), so always resolve the IP and reach it **with the proxy bypassed**.

Get the external IP (proxy bypassed):

```bash
curl --noproxy '*' -s https://api.ipify.org   # → e.g. 43.99.56.150
```

Then the test URL is `http://<that-ip>:<port>`, and verify it the same way:

```bash
curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://<ip>:<port>/
```

Rules of thumb:
- Hand the user `http://<external-ip>:<port>`, not localhost / LAN IP.
- Any curl you run against that URL needs `--noproxy '*'` or it goes through the
  proxy and fails.
- This host's external IP is currently `43.99.56.150` (same box as the cicy-code
  server in `DEFAULT_SERVER_URL`) — re-resolve it each time rather than hardcoding.

## Web / PWA

Same code as native; web-specific behavior lives in platform-split files
(`*.web.tsx`) so native is never touched.

```bash
npx expo export -p web          # build static site → dist/
npx expo serve --port 8088      # serve dist/ (handles cleanUrls: /agents → agents.html)
```

- Platform splits: `TerminalView.tsx` (native WebView) / `TerminalView.web.tsx`
  (iframe); `app/scan.tsx` (native camera) / `app/scan.web.tsx` (paste-link form).
  expo-router uses the `.web` route when a base sibling exists.
- Web has **no voice** — chat defaults to text mode and hides the mic toggle.
- PWA shell: `app/+html.tsx` (manifest link, Apple meta, SW registration),
  `public/manifest.json`, `public/sw.js`, `public/icon.png`.
- `localhost` is a secure context (SW + install work); testing the PWA install on
  a phone needs **HTTPS** — that's the cf-worker deploy step, not the http test URL.

## Deployment — Telegram Mini App

The web build ships as a **Telegram Mini App** on Cloudflare.

**Architecture principle: the app is a PURE CLIENT — it has no backend of its
own.** It works entirely off the team server address scanned in via QR. Never
hardcode a backend address or token in client code (a hardcoded DEFAULT_TOKEN
once leaked the workspace api_token into the public bundle).

- **Mini App URLs (same assets-only Worker `cicy-mobile`):**
  - `https://telegram-bot.cicy-ai.com` — custom domain, main entry; bot
    `@cicy_ai_bot` menu button **"CiCy"** points here (`setChatMenuButton`
    web_app; bot tokens live in `~/cicy-ai/db/tg_bots.json`, never echo them).
  - `https://cicy-mobile.w3c-offical.workers.dev` — workers.dev URL, kept alive
    (`workers_dev: true`) for the old `@cicy_openclaw_bot` menu button.
- **Worker is static-only** (`wrangler.jsonc`, no `worker.js`): it just serves
  `dist/`. There is NO reverse proxy — each team's cicy-code server answers
  CORS itself (`globalCORS` echoes any Origin), so the page calls the team
  server directly cross-origin.
- **Add-team stores exactly what the QR says:** the QR carries the team
  server's own public HTTPS address (the server's `CICY_PUBLIC_URL`, e.g.
  `https://app-1001.cicy-ai.com?flag=addTeam&token=…`). The scan/paste flows
  (`scan.tsx`, `scan.web.tsx`) save `parsed.server` as-is — the server, not the
  client, is the source of truth for how to reach it. If a QR carries a raw
  http:// address, fix the server's `CICY_PUBLIC_URL` — do NOT patch around it
  client-side. Default team title is i18n `teams.defaultTitle` (我的团队 /
  "My Team").
- **QR scanning:** inside Telegram, `scan.web` uses the native scanner
  (`scanQr` → `WebApp.showScanQrPopup`, `src/lib/telegram.ts`); plain browsers
  have no reliable in-page scanner and fall back to paste.
- **Retired (2026-06-07, don't resurrect):** `worker.js` reverse proxy +
  PROXY_PREFIXES + worker-side CORS, `src/config/defaults.ts` (DEFAULT_SERVER_URL
  / DEFAULT_TOKEN / apiBase / CANONICAL_WEB_ORIGIN), `api.tgMiniAppAuth` +
  index.tsx TG auto-join, and the dedicated `cicy-mobile-api` tunnel
  (`m-api.cicy-ai.com`, stopped; config kept in `~/cicy-ai/db/`). They all
  compensated for QRs carrying a raw-IP address — fixed at the source instead.
  ⚠️ If cloudflared ever runs again: kill by PID from the `.pid` file, never
  `pkill -f "cloudflared tunnel"`; never reuse the `win` production tunnel/token.

### Deploy

```bash
cd ~/projects/cicy-mobile
npx expo export -p web                 # rebuild dist/
export CLOUDFLARE_API_TOKEN=$(node -e "process.stdout.write(require('/home/cicy/cicy-ai/db/cf.json').prod.api_token)")
export CLOUDFLARE_ACCOUNT_ID=$(node -e "process.stdout.write(require('/home/cicy/cicy-ai/db/cf.json').prod.account_id)")
npx wrangler deploy                    # assets-only
```

Post-deploy: `curl -s https://telegram-bot.cicy-ai.com/ | grep -o "entry-[a-f0-9]*.js"`
must match `dist/_expo/static/js/web/`. `https://m-1001.cicy-ai.com` (host
nginx → `expo serve` :8088, keepalive `~/cicy-ai/db/cicy-mobile-serve-keepalive.sh`)
serves `dist/` straight from disk — instant preview after export, no deploy.

## Native dev rules

See `docs/dev-rules.md`. Key point: never rsync Xcode/Gradle-managed files
(`project.pbxproj`, `Pods/`, `*.xcworkspace`, `*.entitlements`); only rsync sources.
iOS installs run through Xcode.
