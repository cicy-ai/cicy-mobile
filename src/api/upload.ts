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
): Promise<UploadResult> {
  const { serverUrl, token } = useAuthStore.getState();
  if (!serverUrl || !token) throw new Error('not authenticated');

  const safeName = sanitizeName(name);
  const form = new FormData();
  form.append('file', { uri: fileUri, name: safeName, type: mime } as any);

  const url = `${serverUrl}/assets/files?pane=${encodeURIComponent(agentId)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
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

// Absolute servable URL for an asset ref returned by uploadAttachment. The
// Bearer header is attached ONLY when the URL points at the team server itself
// (cloud's /assets/files/ is session-guarded) — never leaked to an external
// host like the OSS bucket the cloud default team may return a public URL for.
export function assetUri(pathOrUrl: string): { uri: string; headers?: Record<string, string> } {
  const { serverUrl, token } = useAuthStore.getState();
  let p = String(pathOrUrl || '');
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

// Keep filenames shell/path safe; the server also sanitizes.
function sanitizeName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
}
