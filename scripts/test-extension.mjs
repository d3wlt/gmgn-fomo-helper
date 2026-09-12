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
  const retiredTraffic=[];
  context.on('request',request=>{if(/j7tracker|debot\.ai/.test(request.url()) && !request.isNavigationRequest())retiredTraffic.push(request.url());});
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout:15000 });
  const id = new URL(worker.url()).host;
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  assert.ok((await page.locator('body').innerText()).includes('FOMO'));
  assert.equal(await page.locator('#enable-pump-feed, #j7tracker-sync-status').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /J7Tracker|DeBot/);
  const popupGeometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(popupGeometry.scrollWidth <= popupGeometry.width, 'popup copy must not overflow horizontally');
  await page.screenshot({ path: path.join(resultsDir, 'popup-retired-integrations.png'), fullPage: true });
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

  // Saved legacy ON/session/cache values must be inert, including after MV3 restart.
  await page.evaluate(async () => {
    await chrome.storage.local.set({enablePumpFeed:true, enableFomoFeed:true, debotFomoPanelOpen:true, debotFomoPanelTab:"swaps",
      j7TrackerSessionV1:{token:'fixture-j7-session',accountId:'fixture'},
      j7TrackerFomoConfigV1:{connected:true},j7TrackerPumpConfigV1:{connected:true}});
    await chrome.storage.session.set({j7TrackerCacheV1:{fomo:[{id:'retired'}],pump:[{id:'retired'}]}});
    await chrome.alarms.create('985gmgn-j7tracker-sync',{periodInMinutes:5});
  });
  await page.locator('#save').click();
  assert.equal(await page.locator('#enable-fomo-feed').isChecked(), true);
  for (const type of ['fomo-feed','pump-feed','j7tracker-session-updated']) {
    assert.equal(await page.evaluate(async type => {
      try { return (await chrome.runtime.sendMessage({type})) ?? null; } catch { return null; }
    }, type), null, `retired message ${type} has no handler`);
  }
  // Real MV3 injection retirement, routed synthetic DeBot token/tracker pages only.
  await context.route('https://debot.ai/**',route=>route.fulfill({contentType:'text/html',body:
    '<!doctype html><html><body><main id="native">Native fixture unchanged</main><table><tbody><tr id="native-row"><td><a href="/token/eth/0x1111111111111111111111111111111111111111">Native token</a></td></tr></tbody></table></body></html>'}));
  const retiredPage=await context.newPage();
  const retiredCdp=await context.newCDPSession(retiredPage), executionContexts=[];
  retiredCdp.on('Runtime.executionContextCreated',({context})=>executionContexts.push(context));
  await retiredCdp.send('Runtime.enable');
  for(const route of ['/track?tab=track','/token/eth/0x1111111111111111111111111111111111111111']) {
    executionContexts.length=0;
    await retiredPage.goto(`https://debot.ai${route}`);
    await retiredPage.waitForTimeout(1300);
    assert.equal(await retiredPage.locator('#native').innerText(),'Native fixture unchanged');
    assert.equal(await retiredPage.locator('[class*="gdh-"], [data-gdh-debot-track-chain], [data-gdh-debot-fomo-key]').count(),0);
    assert.ok(!executionContexts.some(ctx=>ctx.origin===`chrome-extension://${id}`),'no extension isolated world on retired host');
    const before=retiredPage.url();
    await retiredPage.evaluate(()=>document.dispatchEvent(new CustomEvent('gdh-debot-navigate',{detail:{href:'/token/bsc/0x2222222222222222222222222222222222222222'}})));
    assert.equal(retiredPage.url(),before,'retired MAIN navigation bridge absent');
  }
  await retiredPage.close();
  assert.deepEqual(retiredTraffic,[],'no retired provider requests with legacy settings');
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
  assert.equal(await worker.evaluate(() => typeof wakeJ7Tracker), 'undefined');
  assert.equal(await page.evaluate(async () => (await chrome.storage.session.get('j7TrackerCacheV1')).j7TrackerCacheV1 ?? null), null);
  assert.equal(await page.evaluate(async () => (await chrome.alarms.get('985gmgn-j7tracker-sync')) ?? null), null);
  assert.equal(response.ok, false, 'offline request is failure, never successful empty data');
  debug=await page.evaluate(()=>chrome.runtime.sendMessage({type:'debug-export'}));
  assert.equal(debug.data.enabled,false);
  assert.ok(debug.data.entries.some(e=>e.kind==='render' && e.placed===2),'diagnostics survive real worker restart');
  assert.deepEqual(errors, []);
  assert.deepEqual(retiredTraffic,[]);
  console.log(`MV3 ${manifest.version}: debug toggle/export/clear/sanitization/restart passed; loaded, legacy J7 data/messages inert and DeBot injection/traffic absent, popup Save verified at 380x600, worker stopped/reawakened, offline failure preserved.`);
} finally {
  if (context) await context.close();
  fs.rmSync(profile, { recursive:true, force:true });
}
