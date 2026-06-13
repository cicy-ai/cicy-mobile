import { useAuthStore } from '@/src/store/auth';

export type UploadResult = { path: string; size: number; mtime?: number };

// Upload a local file (image / document) into the *agent's own workspace* via
// /api/fs/upload, so the CLI agent — which runs in that workspace — can read it
// back by the returned (workspace-relative) path. We drop everything under a
// `.uploads/` folder to keep the agent's tree tidy.
//
// Mirrors src/api/stt.ts: RN's FormData accepts {uri, name, type}; we must NOT
// set Content-Type ourselves (RN sets the multipart boundary).
export async function uploadAttachment(
  agentId: string,
  fileUri: string,
  name: string,
  mime: string,
): Promise<UploadResult> {
  const { serverUrl, token } = useAuthStore.getState();
  if (!serverUrl || !token) throw new Error('not authenticated');

  const safeName = sanitizeName(name);
  // Per-upload unique path so two files with the same name don't collide and we
  // never need ?overwrite=1.
  const target = `.uploads/${Date.now()}-${safeName}`;

  const form = new FormData();
  form.append('file', { uri: fileUri, name: safeName, type: mime } as any);

  const url =
    `${serverUrl}/api/fs/upload` +
    `?agent_id=${encodeURIComponent(agentId)}` +
    `&path=${encodeURIComponent(target)}`;

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
  const json = (await res.json()) as { path?: string; size?: number; mtime?: number };
  if (!json?.path) throw new Error('upload returned no path');
  return { path: json.path, size: json.size ?? 0, mtime: json.mtime };
}

// Keep filenames shell/path safe; the server also sanitizes, but we want the
// path we echo to the agent to match what actually landed on disk.
function sanitizeName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
}
