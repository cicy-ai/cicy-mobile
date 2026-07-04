import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { useShareStore } from '@/src/store/share';

// Web Share Target endpoint (public/manifest.json `share_target`): the browser
// opens /share?title=…&text=…&url=… when the user shares to the installed PWA.
// Park the payload in the share store and bounce to the agent list, where the
// user picks who receives it. Native never navigates here.
export default function Share() {
  const params = useLocalSearchParams<{ title?: string; text?: string; url?: string }>();
  // useState initializer = run-once side effect, before the redirect renders.
  useState(() => {
    const pick = (v: unknown) => String(Array.isArray(v) ? v[0] : (v ?? '')).trim();
    const title = pick(params.title);
    const text = pick(params.text);
    const url = pick(params.url);
    // Browsers often duplicate the URL inside `text` — keep unique parts only.
    const parts: string[] = [];
    for (const p of [title, text, url]) {
      if (p && !parts.some((x) => x.includes(p))) parts.push(p);
    }
    const combined = parts.join('\n').trim();
    if (combined) useShareStore.getState().setShare(combined);
    return null;
  });
  return <Redirect href="/agents" />;
}
