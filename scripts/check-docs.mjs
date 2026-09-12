import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = new URL('../', import.meta.url);
export const read = name => fs.readFileSync(new URL(name, root), 'utf8');
export function validateDocs(load = read) {
  const manifest = JSON.parse(load('manifest.json'));
  const version = manifest.version;
  const readme = load('README.md');
  const changelog = load('CHANGELOG.md');
  assert.ok(changelog.includes(`\n## ${version} - `), 'CHANGELOG.md needs the current version');
  assert.ok(readme.includes(`**${version}**`), 'README version must match manifest');
  assert.ok(readme.includes(`--tag v${version}`), 'README build example must match manifest');
  assert.ok(!readme.includes('## Repository'), 'Do not restore the removed Repository section');
  const repo = manifest.homepage_url;
  assert.equal(repo, 'https://github.com/d3wlt/gmgn-fomo-helper');
  assert.equal(manifest.name, 'GMGN FOMO Helper');
  const pkg = JSON.parse(load('package.json')), lock = JSON.parse(load('package-lock.json'));
  assert.equal(pkg.name, 'gmgn-fomo-helper');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  for (const file of ['README.md','PRODUCT.md','PRIVACY.md','site/index.html','popup.html']) {
    const text = load(file);
    assert.ok(!text.includes('985gmgn-helper-private'), `${file}: stale repository link`);
    for (const match of text.matchAll(/https:\/\/github\.com\/d3wlt\/gmgn-fomo-helper#([a-z0-9-]+)/g)) {
      const anchors = [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(m => m[1].toLowerCase().replace(/[^a-z0-9 -]/g,'').replace(/ /g,'-'));
      assert.ok(anchors.includes(match[1]), `${file}: missing README anchor ${match[1]}`);
    }
  }
  assert.doesNotMatch(load('PRIVACY.md'), /custom HTTPS (?:BSC )?RPC/i, 'Privacy must not advertise retired custom RPC');
  assert.ok(load('PRODUCT.md').includes('can execute a real trade'), 'Product must disclose native trade controls');
  const note = load(`release-notes/v${version}.md`);
  assert.ok([`# GMGN FOMO Helper v${version}\n`,`# better gmgn v${version}\n`].some(t => note.startsWith(t)), 'Release-note title must match version');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateDocs();
  for (const [file, from, to] of [
    ['CHANGELOG.md', `## ${JSON.parse(read('manifest.json')).version} - `, '## missing - '],
    ['README.md', '## Features', '## Missing heading'],
    ['PRIVACY.md', 'hosts declared in the manifest:', 'hosts declared in the manifest or a custom HTTPS BSC RPC:'],
  ]) {
    assert.ok(read(file).includes(from), `negative fixture target exists: ${file}`);
    assert.throws(() => validateDocs(name => name === file ? read(name).replace(from,to) : read(name)), undefined, `reject documentation drift: ${file}`);
  }
  console.log('PASS documentation: current changelog/version, package identity, repository links, popup anchor, RPC/privacy and native trading disclosure; negative drift fixtures rejected.');
}
