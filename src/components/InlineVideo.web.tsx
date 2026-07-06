// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Web fallback — expo-video is native-only. A plain <video> tag works in the
// browser (headers can't be attached, but web assets are same-origin cookies
// / the ?token URL still works there).
export function InlineVideo({ uri }: { uri: string; headers?: Record<string, string> }) {
  const V = 'video' as any;
  return <V src={uri} controls style={{ width: 240, maxWidth: '100%', borderRadius: 12, background: '#000' }} />;
}
