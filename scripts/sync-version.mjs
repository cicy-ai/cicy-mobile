#!/usr/bin/env node
// Sync the release version into app.json before a build.
//   node scripts/sync-version.mjs <version> [versionCode]
//   e.g.  node scripts/sync-version.mjs 1.0.1 42
//
// Sets expo.version (shown on iOS/Android + web) and expo.android.versionCode
// (monotonic integer Android requires for upgrades; CI passes github.run_number).
// Used by .github/workflows/deploy.yml on a v* tag push.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , version, versionCode] = process.argv;
if (!version) {
  console.error('usage: sync-version.mjs <version> [versionCode]');
  process.exit(1);
}

const file = new URL('../app.json', import.meta.url);
const json = JSON.parse(readFileSync(file, 'utf8'));
json.expo.version = version;
if (versionCode) {
  json.expo.android = json.expo.android || {};
  json.expo.android.versionCode = Number(versionCode);
}
writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
console.log(`app.json → version=${version} versionCode=${versionCode ?? '(unchanged)'}`);
