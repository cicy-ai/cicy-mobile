// Static-serving shim ONLY (the app remains a pure client — no proxy, no
// backend): fix the 404 semantics of hashed build assets. With SPA
// not_found_handling, a request for an OLD (deleted) /_expo/static/*.js would
// get 200 + the HTML shell — which browsers then execute as JS ("Unexpected
// token '<'") and service workers may cache under the .js URL (permanent
// poison). Missing build assets must be a hard 404 so loaders fail fast and
// the chunk-heal guard (+html.tsx) can reload into the new build.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Short install link for phones: https://telegram-bot.cicy-ai.com/apk →
    // the latest Android build on the public R2 CDN (browser download →
    // system installer; replaces the USB/adb loop).
    if (pathname === '/apk') {
      return Response.redirect('https://r2.deepfetch.de5.net/cicy-mobile/cicy-latest.apk', 302);
    }
    // expo-updates manifest (self-hosted OTA). CI publishes the complete
    // protocol-1 JSON manifest to R2 (scripts/publish-ota.mjs, written last =
    // atomic); this route serves it verbatim with the protocol headers. 404
    // before the first publish = client treats as no update.
    if (pathname === '/updates/manifest') {
      const rt = request.headers.get('expo-runtime-version')
        || new URL(request.url).searchParams.get('runtime-version') || '1';
      const r = await fetch(`https://r2.deepfetch.de5.net/cicy-mobile/updates/${encodeURIComponent(rt)}/manifest.json`, {
        cf: { cacheTtl: 0 },
      });
      if (!r.ok) return new Response('no update published for this runtime', { status: 404 });
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
