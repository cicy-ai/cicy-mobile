#!/usr/bin/env node
// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Publish an expo-updates OTA update to Alibaba OSS (self-hosted; no Expo
// servers — mainland-reachable; todo46 moved this off R2). Run AFTER
// `npx expo export -p android -p ios`:
//
//   node scripts/publish-ota.mjs <version-label>
//
// Uploads every exported file under cicy-mobile/updates/<runtime>/<uuid>/… and
// writes the complete expo-updates protocol-1 JSON manifest LAST at
// cicy-mobile/updates/<runtime>/manifest-<platform>.json (atomic switch — the
// worker serves it verbatim, so a check can never see a half-published update).
//
// Env: OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET. Runtime version read from app.json.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const OSS_BUCKET = 'cicy-1372193042-cn';
const OSS_ENDPOINT = 'oss-cn-shanghai.aliyuncs.com';
const OSS_HOST = `${OSS_BUCKET}.${OSS_ENDPOINT}`;
// Public read URL prefix — the bundle `url`s baked into the manifest, and where
// the worker's dualRead() finds the manifests.
const CDN = `https://${OSS_HOST}`;

const MIME = {
  hbc: 'application/javascript', js: 'application/javascript', bundle: 'application/javascript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  json: 'application/json', mp3: 'audio/mpeg', wav: 'audio/wav',
};

const { OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET } = process.env;
if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) { console.error('missing OSS creds'); process.exit(1); }
const label = process.argv[2] || 'dev';

const appJson = JSON.parse(readFileSync('app.json', 'utf8'));
const runtime = String(appJson.expo.runtimeVersion || '1');
const meta = JSON.parse(readFileSync('dist/metadata.json', 'utf8'));

// Sign + PUT a single object to OSS. Signature is the standard OSS v1 scheme:
//   StringToSign = "PUT\n\n<Content-Type>\n<Date>\n/<bucket>/<key>"
//   Authorization: "OSS <keyId>:base64(hmac-sha1(secret, StringToSign))"
// key is the full object key (e.g. "cicy-mobile/updates/2/<uuid>/bundle.hbc").
async function put(key, buf, contentType) {
  for (let attempt = 1; ; attempt += 1) {
    const date = new Date().toUTCString();
    const resource = `/${OSS_BUCKET}/${key}`;
    const stringToSign = `PUT\n\n${contentType}\n${date}\n${resource}`;
    const signature = createHmac('sha1', OSS_ACCESS_KEY_SECRET).update(stringToSign, 'utf8').digest('base64');
    const url = `${CDN}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Host: OSS_HOST,
        Date: date,
        'Content-Type': contentType,
        Authorization: `OSS ${OSS_ACCESS_KEY_ID}:${signature}`,
      },
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
