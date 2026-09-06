import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real MV3 load and worker restart, with an empty profile and network OFFLINE.
// This test never loads or reads an existing browser profile or account.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-mv3-test-'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true, offline:true,
    args:[`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout:15000 });
  const id = new URL(worker.url()).host;
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  assert.ok((await page.locator('body').innerText()).includes('FOMO'));
  assert.deepEqual(errors, []);
  const cdp = await context.newCDPSession(page);
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find(t => t.type === 'service_worker' && t.url === worker.url());
  assert.ok(target, 'real background target exists');
  await worker.evaluate(() => { globalThis.__mv3RestartSentinel = 'fixture'; });
  const versionEvent = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker version discovery timed out')), 10000);
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const found = versions.find(v => v.scriptURL === target.url && v.runningStatus === 'running');
      if (found) { clearTimeout(timer); resolve(found.versionId); }
    });
  });
  await cdp.send('ServiceWorker.enable');
  const versionId = await versionEvent;
  const stoppedEvent = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker stop timed out')), 10000);
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      if (versions.some(v => v.versionId === versionId && v.runningStatus === 'stopped')) { clearTimeout(timer); resolve(); }
    });
  });
  await cdp.send('ServiceWorker.stopWorker', { versionId });
  await stoppedEvent;
  // Chrome wakes the stopped worker for an actual extension runtime message.
  // Chromium/Playwright can reuse target IDs and Worker wrappers, so verify
  // the stopped lifecycle event AND erased worker memory, not just an ID.
  const response = await page.evaluate(() => chrome.runtime.sendMessage({
    type:'fomo-token-feed', payload:{ kind:'swaps', networkId:1, tokenAddress:'0x1111111111111111111111111111111111111111' },
  }));
  const after = await cdp.send('Target.getTargets');
  const restarted = after.targetInfos.find(t => t.type === 'service_worker' && t.url === target.url);
  assert.ok(restarted, 'worker target is running after a runtime message');
  worker = context.serviceWorkers().find(w => w.url() === target.url);
  assert.ok(worker);
  assert.equal(await worker.evaluate(() => typeof globalThis.__mv3RestartSentinel), 'undefined', 'worker memory was reset');
  assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  assert.equal(response.ok, false, 'offline request is failure, never successful empty data');
  assert.deepEqual(errors, []);
  console.log(`MV3 ${manifest.version}: loaded, popup rendered, worker stopped/reawakened, offline failure preserved.`);
} finally {
  if (context) await context.close();
  fs.rmSync(profile, { recursive:true, force:true });
}
