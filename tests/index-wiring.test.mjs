import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const ids = [...indexSource.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual(duplicateIds, [], 'Static UI contains duplicate IDs');

const staticIdSet = new Set(ids);
const queriedIds = [
    ...indexSource.matchAll(/querySelector\(['"]#([A-Za-z0-9_-]+)['"]\)/g),
].map(match => match[1]);
const dynamicIds = new Set(['pf-overlay', 'pf-settings', 'pf-fab', 'extensions_settings2', 'extensions_settings']);
const missingIds = [...new Set(queriedIds)].filter(id => !staticIdSet.has(id) && !dynamicIds.has(id));
assert.deepEqual(missingIds, [], 'A queried UI ID is missing from the static template');

const version = indexSource.match(/const VERSION = '([^']+)'/)?.[1];
assert.equal(version, manifest.version, 'Manifest and runtime versions must match');
assert.match(indexSource, /buildPersonaSystemPrompt\(\)/);
assert.match(indexSource, /renderStructuredResult\(/);
assert.match(indexSource, /personaWorldNames/);
assert.match(indexSource, /pf-length-preset/);
assert.match(indexSource, /pf-target-length/);
assert.match(indexSource, /pf-content-jump/);
assert.match(indexSource, /resolveTargetLength/);

console.log('index wiring ok');
