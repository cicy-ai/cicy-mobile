// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Static-serving shim ONLY (the app remains a pure client — no proxy, no
// backend): fix the 404 semantics of hashed build assets. With SPA
// not_found_handling, a request for an OLD (deleted) /_expo/static/*.js would
// get 200 + the HTML shell — which browsers then execute as JS ("Unexpected
// token '<'") and service workers may cache under the .js URL (permanent
// poison). Missing build assets must be a hard 404 so loaders fail fast and
// the chunk-heal guard (+html.tsx) can reload into the new build.
// Asset store. Cloudflare R2 (public read via r2.deepfetch.de5.net) is the
// primary again: Alibaba OSS, primary during the todo46 migration, now
// answers 403 to public reads, so it is only consulted as a last resort for
// keys never republished to R2. Both are public buckets; we only READ here.
const R2 = 'https://r2.deepfetch.de5.net/cicy-mobile';
const OSS = 'https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com/cicy-mobile';

// Fetch a key from R2 first, OSS second. Returns the first ok Response, or the
// last (non-ok) one so callers can 404.
async function dualRead(relPath, cfOpts) {
  let r = await fetch(`${R2}/${relPath}`, cfOpts).catch(() => null);
  if (r && r.ok) return r;
  const o = await fetch(`${OSS}/${relPath}`, cfOpts).catch(() => null);
  return o || r || new Response('not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Short install link for phones: https://m.cicy-ai.com/apk → the latest
    // raw Android build on R2 (no apk sniffer there — installs straight away).
    if (pathname === '/apk') {
      return Response.redirect(`${R2}/cicy-latest.apk`, 302);
    }
    // Version manifest for the in-app / skill update check. Geo-agnostic single
    // URL; storage is R2 (OSS as a last-resort fallback).
    if (pathname === '/version.json') {
      const r = await dualRead('version.json', { cf: { cacheTtl: 0 } });
      if (!r.ok) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(r.body, {
        headers: {
          'cache-control': 'public, max-age=30',
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
        },
      });
    }
    // expo-updates manifest (self-hosted OTA). CI publishes the complete
    // protocol-1 JSON manifest (scripts/publish-ota.mjs, written last = atomic);
    // this route serves it verbatim with the protocol headers. 404 before the
    // first publish = client treats as no update.
    if (pathname === '/updates/manifest') {
      const rt = request.headers.get('expo-runtime-version')
        || new URL(request.url).searchParams.get('runtime-version') || '1';
      // Bundles are platform-specific — route on the client's expo-platform
      // header (ios|android), falling back to the legacy android manifest for
      // anything that predates per-platform publishing.
      const plat = (request.headers.get('expo-platform')
        || new URL(request.url).searchParams.get('platform') || 'android').toLowerCase();
      const dir = `updates/${encodeURIComponent(rt)}`;
      let r = await dualRead(`${dir}/manifest-${plat === 'ios' ? 'ios' : 'android'}.json`, { cf: { cacheTtl: 0 } });
      if (!r.ok && plat !== 'ios') r = await dualRead(`${dir}/manifest.json`, { cf: { cacheTtl: 0 } });
      if (!r.ok) return new Response('no update published for this runtime/platform', { status: 404 });
      return new Response(r.body, {
        headers: {
          'expo-protocol-version': '1',
          'expo-sfv-version': '0',
          'cache-control': 'private, max-age=0',
          'content-type': 'application/json; charset=utf-8',
        },
      });
    }
    const res = await env.ASSETS.fetch(request);
    if (pathname.startsWith('/_expo/') && /text\/html/i.test(res.headers.get('content-type') || '')) {
      return new Response('asset from an old deploy — gone', { status: 404 });
    }
    return res;
  },
};
