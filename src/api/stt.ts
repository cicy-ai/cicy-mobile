import { File } from 'expo-file-system';

import { useAuthStore } from '@/src/store/auth';

type STTResult = { text: string };

// Upload a recorded audio file to /api/stt and return the transcript.
// Throws on any failure; the MicButton component shows the message to the user.
export async function transcribeAudio(fileUri: string, opts?: { language?: string }): Promise<STTResult> {
  const { serverUrl, token } = useAuthStore.getState();
  if (!serverUrl || !token) throw new Error('not authenticated');

  // Sanity-check the recording before we tie up the network. expo-audio sometimes
  // returns a URI before the file is fully flushed on Android — surface that
  // here instead of letting the upload silently fail with "Network request failed".
  let bytes = 0;
  try {
    const f = new File(fileUri);
    if (!f.exists) throw new Error(`audio file not found: ${fileUri}`);
    bytes = f.size ?? 0;
  } catch (e: any) {
    console.warn('[stt] file stat failed:', String(e?.message ?? e));
    throw new Error(`audio not readable: ${String(e?.message ?? e)}`);
  }
  if (bytes <= 1024) {
    throw new Error(`recording too short (${bytes} bytes)`);
  }

  // RN's FormData accepts {uri, name, type}. The uri must keep its file:// prefix
  // on iOS (sandbox path), but Android sometimes wants it stripped — try the URI
  // as-given first.
  const form = new FormData();
  form.append('file', {
    uri: fileUri,
    name: 'audio.m4a',
    type: 'audio/m4a',
  } as any);
  if (opts?.language) form.append('language', opts.language);

  const url = `${serverUrl}/api/stt`;
  console.log('[stt] upload', { url, bytes, uri: fileUri });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // Don't set Content-Type — RN sets the multipart boundary itself.
        Authorization: `Bearer ${token}`,
      },
      body: form as any,
    });
  } catch (e: any) {
    // RN's fetch throws "Network request failed" with no detail. Wrap with
    // context so the user sees what URL we tried.
    console.warn('[stt] fetch threw', String(e?.message ?? e), 'url=', url);
    throw new Error(`network: ${String(e?.message ?? e)} (${url})`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`stt ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as STTResult;
  if (!json?.text) throw new Error('empty transcript');
  return json;
}
