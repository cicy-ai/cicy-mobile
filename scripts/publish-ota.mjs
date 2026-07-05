#!/usr/bin/env node
// Publish an expo-updates OTA update to the public R2 CDN (self-hosted; no
// Expo servers — mainland-reachable). Run AFTER `npx expo export -p android`:
//
//   node scripts/publish-ota.mjs <version-label>
//
// Uploads every exported file under cicy-mobile/updates/<runtime>/<uuid>/…
// and writes the complete expo-updates protocol-1 JSON manifest LAST at
// cicy-mobile/updates/<runtime>/manifest.json (atomic switch — the worker
// serves it verbatim, so a check can never see a half-published update).
//
// Env: R2_ACCOUNT_ID, R2_API_TOKEN. Runtime version read from app.json.
import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CDN = 'https://r2.deepfetch.de5.net';
const BUCKET_BASE = (acc) => `https://api.cloudflare.com/client/v4/accounts/${acc}/r2/buckets/cicy-assets-poc/objects`;

const MIME = {
  hbc: 'application/javascript', js: 'application/javascript', bundle: 'application/javascript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  json: 'application/json', mp3: 'audio/mpeg', wav: 'audio/wav',
};

const { R2_ACCOUNT_ID, R2_API_TOKEN } = process.env;
if (!R2_ACCOUNT_ID || !R2_API_TOKEN) { console.error('missing R2 creds'); process.exit(1); }
const label = process.argv[2] || 'dev';

const appJson = JSON.parse(readFileSync('app.json', 'utf8'));
const runtime = String(appJson.expo.runtimeVersion || '1');
const meta = JSON.parse(readFileSync('dist/metadata.json', 'utf8'));

async function put(key, buf, contentType) {
  // CF API throws transient 5xx now and then — one mid-run 502 must not strand
  // a platform on an old manifest (happened: android updated, ios did not).
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(`${BUCKET_BASE(R2_ACCOUNT_ID)}/${encodeURIComponent(key).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${R2_API_TOKEN}`, 'Content-Type': contentType },
      body: buf,
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) return;
    const retriable = res.status === 0 || res.status >= 500 || res.status === 429;
    if (!retriable || attempt >= 5) throw new Error(`PUT ${key} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const delay = attempt * 2000;
    console.warn(`PUT ${key} → ${res.status}, retry ${attempt}/4 in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

// Embed the public expo config like EAS does (extra.expoClient) so
// Constants.expoConfig keeps working inside OTA bundles — without it,
// expoConfig is null when running an update (version footer vanished).
let expoClient = null;
try {
  expoClient = JSON.parse(execSync('npx expo config --json --type public', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {
  console.warn('warn: could not resolve public expo config; extra.expoClient omitted');
}

// One manifest PER PLATFORM: bundles are platform-specific (.ios/.android file
// resolution, different asset sets). Serving the android bundle to iOS —
// the original single-manifest setup — makes iOS updates fail on apply. The
// worker routes by the client's `expo-platform` request header.
const platforms = ['android', 'ios'].filter((p) => meta.fileMetadata?.[p]?.bundle);
if (platforms.length === 0) {
  console.error('dist/metadata.json has no platform bundles — run `npx expo export -p android -p ios` first');
  process.exit(1);
}

for (const platform of platforms) {
  const fm = meta.fileMetadata[platform];
  const updateId = randomUUID();
  const prefix = `cicy-mobile/updates/${runtime}/${updateId}`;

  const assetEntry = (relPath, ext) => {
    const buf = readFileSync(path.join('dist', relPath));
    const sha = createHash('sha256').update(buf).digest('base64url');
    const md5 = createHash('md5').update(buf).digest('hex'); // key matches the client's embedded-asset keys → no re-download
    const contentType = MIME[ext] || 'application/octet-stream';
    return { buf, entry: { hash: sha, key: md5, contentType, fileExtension: `.${ext}`, url: `${CDN}/${prefix}/${relPath}` }, relPath, contentType };
  };

  const launch = assetEntry(fm.bundle, 'hbc');
  const assets = (fm.assets || []).map((a) => assetEntry(a.path, a.ext));

  const manifest = {
    id: updateId,
    createdAt: new Date().toISOString(),
    runtimeVersion: runtime,
    launchAsset: launch.entry,
    assets: assets.map((a) => a.entry),
    metadata: {},
    extra: { label, ...(expoClient ? { expoClient } : {}) },
  };

  const files = [launch, ...assets];
  for (const f of files) {
    await put(`${prefix}/${f.relPath}`, f.buf, f.contentType);
    console.log(`[${platform}] uploaded`, f.relPath);
  }
  // manifests LAST — atomic switch per platform
  const body = Buffer.from(JSON.stringify(manifest));
  await put(`cicy-mobile/updates/${runtime}/manifest-${platform}.json`, body, 'application/json');
  if (platform === 'android') {
    // legacy path: pre-platform-routing clients/worker fall back to this
    await put(`cicy-mobile/updates/${runtime}/manifest.json`, body, 'application/json');
  }
  console.log(`OTA published: platform=${platform} runtime=${runtime} id=${updateId} label=${label} files=${files.length}`);
}
