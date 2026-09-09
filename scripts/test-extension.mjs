import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real MV3 load and worker restart, with an empty profile and network OFFLINE.
// This test never loads or reads an existing browser profile or account.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resultsDir = path.join(root, 'test-results');
fs.mkdirSync(resultsDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-mv3-test-'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true, offline:true,
    // Context offline emulation does not reliably cover service-worker sockets.
    // Fail DNS for all real hosts; routed synthetic pages still load without DNS.
    args:[`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout:15000 });
  const id = new URL(worker.url()).host;
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  assert.ok((await page.locator('body').innerText()).includes('FOMO'));
  assert.ok((await page.locator('body').innerText()).includes('J7Tracker'));
  assert.ok((await page.locator('footer').innerText()).includes('optional signed-in FOMO/J7Tracker sessions'));
  const popupGeometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(popupGeometry.scrollWidth <= popupGeometry.width, 'J7Tracker popup copy must not overflow horizontally');
  const j7Status = page.locator('#j7tracker-sync-status');
  const setJ7State = state => page.evaluate(value => chrome.storage.local.set({ j7TrackerSyncStateV1: value }), state);
  await setJ7State({ connected:false, reason:'verifying' });
  await assert.doesNotReject(() => j7Status.waitFor({ state:'visible' }));
  await page.waitForFunction(() => document.querySelector('#j7tracker-sync-status')?.textContent.includes('Verifying'));
  await setJ7State({ connected:false, reason:'session-expired' });
  await page.waitForFunction(() => document.querySelector('#j7tracker-sync-status')?.textContent.includes('expired'));
  await setJ7State({ connected:false, reason:'network' });
  await page.waitForFunction(() => document.querySelector('#j7tracker-sync-status')?.textContent.includes('retrying'));
  await setJ7State({ connected:true, displayName:'Fixture User', fomoTrackedCount:0, pumpTrackedCount:0 });
  await page.waitForFunction(() => document.querySelector('#j7tracker-sync-status')?.textContent.includes('FOMO 0 · Pump 0'));
  assert.ok(await j7Status.evaluate(element => element.classList.contains('is-warn')));
  await setJ7State({ connected:true, displayName:'Fixture User', fomoTrackedCount:2, pumpTrackedCount:3 });
  await page.waitForFunction(() => document.querySelector('#j7tracker-sync-status')?.textContent.includes('FOMO 2 · Pump 3'));
  assert.ok(await j7Status.evaluate(element => element.classList.contains('is-ok')));
  await page.screenshot({ path: path.join(resultsDir, 'popup-j7tracker.png'), fullPage: true });
  assert.deepEqual(errors, []);

  // Real settings controls, persistent worker logger, and native file download.
  assert.equal(await page.locator('#debug-logging').isChecked(),false);
  await worker.evaluate(async()=>{await gdhDebug.ready;gdhDebug.record('request',{endpoint:'user-swaps',status:500});});
  let debug=await page.evaluate(()=>chrome.runtime.sendMessage({type:'debug-export'}));
  assert.equal(debug.ok,true);assert.equal(debug.data.entries.length,0,'off by default');
  await page.locator('#debug-logging').check();
  await page.waitForFunction(async()=> (await chrome.storage.local.get('debugLogging')).debugLogging===true);
  await worker.evaluate(async()=>{await gdhDebug.setEnabled(true);gdhDebug.record('request',{endpoint:'user-swaps',status:429,durationMs:125,reason:'http-error',token:'NEVER_EXPORT_SECRET',url:'https://private.test',userId:'PRIVATE_USER'});
    const original=fetch;globalThis.fetch=async()=>new Response(JSON.stringify({statusCode:401,error:'unauthorized',token:'NEVER_EXPORT_SECRET'}),{status:200});
    try { await fomoAuthedFetch('/v2/users/PRIVATE_USER/swaps?cursor=NEVER_EXPORT_SECRET',{}); } finally { globalThis.fetch=original; }
  });
  const downloadEvent=page.waitForEvent('download');
  await page.locator('#debug-export').click();
  const download=await downloadEvent;
  const exported=fs.readFileSync(await download.path(),'utf8');
  const log=JSON.parse(exported);
  assert.ok(log.entries.some(e=>e.kind==='request' && e.status===429));
  assert.ok(log.entries.some(e=>e.endpoint==='user-swaps' && e.status===200 && e.reason==='not-connected'),'HTTP200 auth failure classified without raw payload');
  assert.ok(!/NEVER_EXPORT_SECRET|private\.test|PRIVATE_USER|fixture-j7-session/.test(exported));
  await page.locator('#debug-section').screenshot({path:path.join(resultsDir,'popup-debug.png')});
  await page.locator('#debug-clear').click();
  await page.waitForFunction(()=>document.querySelector('#debug-status').textContent==='Logs cleared.');
  debug=await page.evaluate(()=>chrome.runtime.sendMessage({type:'debug-export'}));
  assert.equal(debug.data.entries.length,0);
  await worker.evaluate(()=>gdhDebug.record('render',{source:'gmgn',reason:'rendered',received:3,eligible:2,placed:2,filtered:1}));
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'debug-export'})); // drain durable write before restart
  await page.locator('#debug-logging').uncheck();
  await worker.evaluate(()=>gdhDebug.setEnabled(false));
  await worker.evaluate(()=>gdhDebug.record('request',{endpoint:'user-swaps',status:599}));
  debug=await page.evaluate(()=>chrome.runtime.sendMessage({type:'debug-export'}));
  assert.ok(!debug.data.entries.some(e=>e.status===599));

  await context.route('https://j7tracker.io/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body><script>
      localStorage.setItem('sessionId', 'fixture-j7-session');
      localStorage.setItem('loggedInUser', 'Fixture User');
      localStorage.setItem('loggedInUserId', 'fixture-user-id');
    </script><main>J7 fixture</main></body></html>`,
  }));
  const j7Page = await context.newPage();
  await j7Page.goto('https://j7tracker.io/');
  const deadline = Date.now() + 8000;
  let j7Session = null;
  while (Date.now() < deadline) {
    j7Session = await worker.evaluate(async () => (await chrome.storage.local.get('j7TrackerSessionV1')).j7TrackerSessionV1 || null);
    if (j7Session?.token === 'fixture-j7-session') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(j7Session)), {
    token: 'fixture-j7-session', accountId: 'fixture-user-id', displayName: 'Fixture User', at: j7Session.at,
  });
  assert.ok(Number(j7Session.at) > 0);
  await context.route('https://docs.j7tracker.io/**', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><html><body>J7 subdomain fixture</body></html>',
  }));
  const j7SubdomainPage = await context.newPage();
  await j7SubdomainPage.goto('https://docs.j7tracker.io/');
  assert.equal(await j7SubdomainPage.evaluate(() => typeof window.__gdhJ7SessionBridgeStarted), 'undefined', 'the apex session bridge is not injected on J7 subdomains');
  await j7SubdomainPage.close();
  await j7Page.close();

  await worker.evaluate(async () => {
    await wakeJ7Tracker();
    await acceptJ7TrackerLiveEvent('fomo_event', {kind:'trade', data:{id:'mv3-persisted', timestamp:Date.now(), userHandle:'fixture', token:{symbol:'TEST',networkId:1}}}, j7TrackerSessionGeneration, 'fixture-j7-session');
    await j7TrackerPersistQueue;
  });
  const savedJ7 = await page.evaluate(async () => (await chrome.storage.session.get('j7TrackerCacheV1')).j7TrackerCacheV1);
  assert.equal(savedJ7.fomo[0].id, 'mv3-persisted');
  assert.ok(!JSON.stringify(savedJ7).includes('fixture-j7-session'));
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().minimum_chrome_version), '116');
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
  const restoredJ7 = await page.evaluate(() => chrome.runtime.sendMessage({ type:'fomo-feed' }));
  assert.ok(restoredJ7.events.some(e => e.id === 'mv3-persisted'), 'real worker restored session cache before offline network completion');
  assert.equal(await worker.evaluate(() => !!j7TrackerLiveSocket && j7TrackerLiveToken === 'fixture-j7-session'), true, 'wake recreated authenticated socket');
  assert.equal(response.ok, false, 'offline request is failure, never successful empty data');
  debug=await page.evaluate(()=>chrome.runtime.sendMessage({type:'debug-export'}));
  assert.equal(debug.data.enabled,false);
  assert.ok(debug.data.entries.some(e=>e.kind==='render' && e.placed===2),'diagnostics survive real worker restart');
  assert.deepEqual(errors, []);
  console.log(`MV3 ${manifest.version}: debug toggle/export/clear/sanitization/restart passed; loaded, apex-only J7 session bridged, popup states rendered at 380x600, worker stopped/reawakened, offline failure preserved.`);
} finally {
  if (context) await context.close();
  fs.rmSync(profile, { recursive:true, force:true });
}
