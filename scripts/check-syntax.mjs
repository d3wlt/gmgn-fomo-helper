import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [...fs.readdirSync(root).filter(f => f.endsWith('.js')), ...fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.mjs')).map(f => `scripts/${f}`)];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap(s => [...s.js || [], ...s.css || []])]) assert.ok(fs.statSync(path.join(root, file)).size > 0, file);
console.log(`Syntax passed for ${files.length} JavaScript files; MV3 references exist.`);
