// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { useAuthStore } from '@/src/store/auth';

export type UploadResult = {
  /** Servable path on the team server, e.g. "/assets/files/2026/07/05/ab__pic.jpg". */
  url: string;
  /** Absolute file:// ref on the server host — for agents that read files. */
  fileRef: string;
  name: string;
  isImage: boolean;
  contentType: string;
  size: number;
};

// Upload a local file (image / video / document) to the team server's shared
// asset store via POST /assets/files?pane=<agent> — the SAME endpoint the
// cicy-code / cicy-cloud web chat uses. Returns a servable URL (/assets/files/…)
// that renders on both (public on self-hosted; Bearer-guarded on cloud, which
// <Image>/fetch satisfy with a header) plus the absolute file_ref agents read.
//
// RN's FormData accepts {uri, name, type}; we must NOT set Content-Type ourselves
// (RN sets the multipart boundary).
export async function uploadAttachment(
  agentId: string,
  fileUri: string,
  name: string,
  mime: string,
  endpoint?: { serverUrl: string; token: string; queryToken?: boolean } | null,
): Promise<UploadResult> {
  const { serverUrl, token } = endpoint ?? useAuthStore.getState();
  if (!serverUrl || !token) throw new Error('not authenticated');

  const safeName = sanitizeName(name);
  const form = new FormData();
  form.append('file', { uri: fileUri, name: safeName, type: mime } as any);

  // Explicit Hub-agent endpoints authenticate the hubToken via `?token=` (team
  // requests use the normal Bearer header).
  const queryAuth = !!endpoint?.queryToken;
  const url = `${serverUrl}/assets/files?pane=${encodeURIComponent(agentId)}${queryAuth ? `&token=${encodeURIComponent(token)}` : ''}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: queryAuth ? {} : { Authorization: `Bearer ${token}` },
      body: form as any,
    });
  } catch (e: any) {
    throw new Error(`network: ${String(e?.message ?? e)} (${url})`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { file?: any };
  const f = json?.file;
  if (!f?.url) throw new Error('upload returned no url');
  return {
    url: String(f.url),
    fileRef: String(f.file_ref || f.fileRef || ''),
    name: String(f.name || safeName),
    isImage: !!f.is_image || String(f.content_type || '').startsWith('image/'),
    contentType: String(f.content_type || mime),
    size: Number(f.size || 0),
  };
}

// Uploaded attachments are embedded in the message as the ABSOLUTE host path
// (from file_ref) so the agent can Read them with a file tool — same as
// cicy-code web. To DISPLAY/download one, map that absolute path back to the
// servable, token-free URL: `.../cicy-ai/assets/<rel>` → `/assets/files/<rel>`.
// Already-servable `/assets/files/…` URLs (older mobile sends) and external
// URLs pass through untouched. (Port of web's assetAbsPathToURL.)
export function assetAbsPathToURL(src: string): string {
  const s = String(src || '');
  const marker = '/cicy-ai/assets/';
  const i = s.indexOf(marker);
  if (i >= 0) {
    const rel = s.slice(i + marker.length);
    if (rel) return `/assets/files/${rel}`;
  }
  return s;
}

// True when a markdown target is one of our uploaded assets (either the servable
// URL form or an absolute host path into the shared store) — vs an ordinary link.
export function isAssetRef(src: string): boolean {
  const s = String(src || '');
  return s.includes('/assets/files/') || s.includes('/cicy-ai/assets/');
}

// Absolute servable URL for an asset ref returned by uploadAttachment. The
// Bearer header is attached ONLY when the URL points at the team server itself
// (cloud's /assets/files/ is session-guarded) — never leaked to an external
// host like the OSS bucket the cloud default team may return a public URL for.
export function assetUri(pathOrUrl: string): { uri: string; headers?: Record<string, string> } {
  const { serverUrl, token } = useAuthStore.getState();
  // Absolute host path (agent-readable form) → servable URL before resolving.
  let p = assetAbsPathToURL(String(pathOrUrl || ''));
  const isAbsolute = /^https?:\/\//i.test(p);
  let full = isAbsolute ? p : `${serverUrl ?? ''}${p.startsWith('/') ? '' : '/'}${p}`;
  const sameOrigin = !isAbsolute || (!!serverUrl && full.startsWith(serverUrl));
  // The server auto-appends ?token=<session> to the asset URL — a plaintext
  // session leak into image URLs (logs/caches). Strip it and read via the
  // Authorization header instead (same-origin only; never to an OSS host).
  if (token && sameOrigin) {
    full = full.replace(/([?&])token=[^&]*(&|$)/, (_, pre, post) => (pre === '?' && post === '' ? '' : pre)).replace(/[?&]$/, '');
    return { uri: full, headers: { Authorization: `Bearer ${token}` } };
  }
  return { uri: full };
}

// URL an EXTERNAL browser / system viewer can open on its own. The in-app
// <Image>/fetch paths authenticate with the Authorization: Bearer header, but
// Linking.openURL hands the URL to the system browser, which carries NO header —
// and assetUri deliberately strips the ?token (so the session never leaks into
// logs/caches). The result: the browser hits an UNauthenticated /assets/files
// and gets an error/empty download instead of the file ("只能下载,打不开").
// For the external-open path we therefore re-append ?token=<session> so the
// browser can authenticate itself. Same-origin only — never leak the token to
// an external (OSS) host.
export function assetBrowserUrl(pathOrUrl: string): string {
  const { serverUrl, token } = useAuthStore.getState();
  const p = assetAbsPathToURL(String(pathOrUrl || ''));
  const isAbsolute = /^https?:\/\//i.test(p);
  let full = isAbsolute ? p : `${serverUrl ?? ''}${p.startsWith('/') ? '' : '/'}${p}`;
  const sameOrigin = !isAbsolute || (!!serverUrl && full.startsWith(serverUrl));
  if (token && sameOrigin && !/[?&]token=/.test(full)) {
    full += (full.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
  }
  return full;
}

// Keep filenames shell/path safe; the server also sanitizes.
function sanitizeName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
}
