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
    const res = await env.ASSETS.fetch(request);
    if (pathname.startsWith('/_expo/') && /text\/html/i.test(res.headers.get('content-type') || '')) {
      return new Response('asset from an old deploy — gone', { status: 404 });
    }
    return res;
  },
};
