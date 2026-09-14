// Evaluate only the repository-owned profile constant; never imported user JSON.
import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../src/generation/profiles.ts', import.meta.url), 'utf8')
  .replace(/^import type .*;\s*/m, '')
  .replace('export const BUILTIN_MODEL_PROFILES: ModelProfile[]', 'const BUILTIN_MODEL_PROFILES');
const profiles = runInNewContext(`${source}\nJSON.stringify(BUILTIN_MODEL_PROFILES)`, Object.create(null));
for (const profile of JSON.parse(profiles)) {
  writeFileSync(new URL(`../backend/profiles/${profile.id}.json`, import.meta.url), `${JSON.stringify(profile, null, 2)}\n`);
}
