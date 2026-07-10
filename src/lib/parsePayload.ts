// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Parse a QR / deep-link payload into team credentials. Shared by the native
// camera scanner (app/scan.tsx) and the web paste-form fallback
// (app/scan.web.tsx). Two canonical formats:
//
//   1. http(s)://<server>?flag=addTeam&token=<token>  ← preferred (the marker
//      cicy-code's web QR generator emits; also works pasted into any browser)
//   2. cicy://addTeam?url=&token=&title=               ← explicit deep link
//
// Older formats are still tolerated:
//   - cicy://login?server=&token=        legacy alias
//   - JSON: {"url":"...","token":"..."}   manual / debug
export type ParsedPayload = {
  server?: string;
  token?: string;
  title?: string;
  // A Hub connection (parallel to teams): scanned QR is
  // { v:1, type:'hub', url:'https://hub.cicy-ai.com', token:<hubToken> }
  // or deeplink cicy://hub?u=<url>&t=<hubToken>. hub.token is a typ=hub JWT.
  hub?: { url: string; token: string };
};

export function parsePayload(raw: string): ParsedPayload | null {
  const s = raw.trim();
  if (!s) return null;

  // Hub deeplink: cicy://hub?u=<url>&t=<hubToken>
  const hubDeep = s.match(/^cicy:\/\/hub\?(.+)$/i);
  if (hubDeep) {
    const p = new URLSearchParams(hubDeep[1]);
    const url = p.get('u') || p.get('url') || '';
    const token = p.get('t') || p.get('token') || '';
    if (url && token) return { hub: { url: url.replace(/\/+$/, ''), token } };
  }

  // Plain http(s) URL — only treated as a team-add when the URL carries
  // ?flag=addTeam. This way arbitrary http URLs scanned by accident don't try
  // to "log in" the user.
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.searchParams.get('flag') !== 'addTeam') return null;
      const token = u.searchParams.get('token') || undefined;
      // Strip the query/hash so the team's serverUrl is the bare origin.
      const server = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
      const title = u.searchParams.get('title') || undefined;
      return { server, token, title };
    } catch {
      return null;
    }
  }

  // cicy://addTeam?... (deep link) and the legacy cicy://login?... alias.
  const m = s.match(/^cicy:\/\/(addTeam|login)\?(.+)$/i);
  if (m) {
    const params = new URLSearchParams(m[2]);
    const server = params.get('url') || params.get('server') || params.get('serverUrl') || undefined;
    const token = params.get('token') || params.get('apiToken') || undefined;
    const title = params.get('title') || undefined;
    if (server || token) return { server, token, title };
  }
  // JSON for power-users / debug — plus the Hub QR ({ type:'hub', url, token }).
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (String(obj?.type || '').toLowerCase() === 'hub' && obj?.url && obj?.token) {
        return { hub: { url: String(obj.url).replace(/\/+$/, ''), token: String(obj.token) } };
      }
      const server = obj.url || obj.server || obj.serverUrl;
      const token = obj.token || obj.apiToken;
      const title = obj.title;
      if (server || token) return { server, token, title };
    } catch {}
  }
  return null;
}
