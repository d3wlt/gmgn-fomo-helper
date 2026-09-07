import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRaw = fs.readFileSync(`${root}/content.js`, 'utf8');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
await context.routeWebSocket('**/*', ws => ws.close());
await context.route('**/*', route => route.request().isNavigationRequest()
  ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
  : route.fulfill({ contentType: 'application/json', body: '{}' }));
const page = await context.newPage();
await page.goto('https://gmgn.ai/eth/token/0x1111111111111111111111111111111111111111');
await page.evaluate((version) => {
  const runtimeListeners = [];
  const storageListeners = [];
  const state = {
    j7TrackerSessionV1: { token: 'synthetic-latency-token', accountId: 'fixture' },
    enabled: true,
    enableFomoPanel: false,
    enableFomoFeed: true,
    enablePumpFeed: false,
    enableHoldingSurge: false,
    enableManifestoTab: false,
    enableManifestoToast: false,
    enableMarkedHolders: false,
    enableFlapTax: false,
    markedListMigratedV2: true,
    j7TrackerFomoConfigV1: { connected: true, trackedCount: 1, at: Date.now() },
    j7TrackerPumpConfigV1: { connected: true, trackedCount: 0, at: Date.now() },
  };
  window.__fixture = { events: [], runtimeListeners, storageListeners, pending: [], state };
  const local = {
    get(keys, callback) {
      const result = typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {};
      for (const key of (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(result))) {
        if (key in state) result[key] = state[key];
      }
      if (callback) { queueMicrotask(() => callback(result)); return; }
      return Promise.resolve(result);
    },
    set(values, callback) { Object.assign(state, values); if (callback) queueMicrotask(callback); return Promise.resolve(); },
  };
  window.chrome = {
    runtime: {
      id: 'fixture',
      lastError: null,
      getManifest: () => ({ version }),
      getURL: p => p,
      sendMessage(message, callback) {
        if (['fomo-feed','pump-feed'].includes(message.type)) { window.__fixture.pending.push(callback); return; } // stalled network/snapshot callbacks
        const response = message.type === 'fomo-feed'
          ? { ok: true, source: 'j7tracker', events: window.__fixture.events }
          : { ok: false, events: [] };
        if (callback) queueMicrotask(() => callback(response));
        else return Promise.resolve(response);
      },
      onMessage: { addListener(fn) { runtimeListeners.push(fn); } },
    },
    storage: { local, onChanged: { addListener(fn) { storageListeners.push(fn); } } },
  };
  const native = document.createElement('div');
  native.dataset.sentryComponent = 'TrackerListItem';
  native.dataset.gdhTrackAddr = '0x8888888888888888888888888888888888888888';
  native.dataset.gdhTrackTs = String(Date.now());
  const symbol = document.createElement('span');
  symbol.dataset.testid = 'follow-tracking-row-symbol'; symbol.textContent = 'NATIVE';
  const maker = document.createElement('span'); maker.dataset.testid = 'follow-tracking-row-maker'; maker.textContent = 'fixture maker';
  native.append(symbol, maker); document.body.appendChild(native);
}, JSON.parse(fs.readFileSync(`${root}/manifest.json`, 'utf8')).version);
const hooks = `window.__latency = {
  metrics() { return j7LatencyMetrics; },
  epoch() { return j7UiEpoch; },
  setScanState(ageMs, emaMs = 0) { lastFullScanAt = Date.now() - ageMs; scanCostEma = emaMs; },
  dispatch(event) {
    window.__fixture.events = [event];
    const started = performance.now();
    for (const listener of window.__fixture.runtimeListeners) listener({ type: 'gdh-fomo-push', event, epoch: j7UiEpoch, receivedAt: Date.now() });
    return started;
  }
};`;
const source = sourceRaw.replace(/\}\)\(\);\s*$/, `${hooks}\n})();`);
await page.addScriptTag({ content: source });
await page.waitForFunction(() => window.__latency?.epoch());

async function sample(age, index, ema = 0) {
  const key = `latency-${age}-${ema}-${index}`;
  const started = await page.evaluate(({ age, key, index, ema }) => {
    // Retain normal production map/DOM lifecycle between samples.
    window.__latency.setScanState(age, ema);
    return window.__latency.dispatch({ key, source: 'j7-fomo', type: 'buy', ts: Date.now(), name: 'Latency', handle: 'latency', symbol: `L${index}`, addr: `0x${String(index + 1).padStart(40, '0')}`, chain: 'eth', usd: 1 });
  }, { age, key, index, ema });
  await page.waitForFunction(key => document.querySelector(`[data-gdh-fomo-key="${key}"]`), key, { timeout: 5000 });
  const elapsed = await page.evaluate(started => performance.now() - started, started);
  assert.ok(elapsed < 750, `synthetic eligible push exceeded750ms: ${elapsed}`);
  return elapsed;
}

const immediate = [];
for (let i = 0; i < 10; i++) { immediate.push(await sample(901, i)); await page.waitForTimeout(30); }
const throttled = [];
for (let i = 0; i < 10; i++) { throttled.push(await sample(0, 100 + i)); await page.waitForTimeout(30); }
const medium = [];
for (let i = 0; i < 5; i++) { medium.push(await sample(0, 200 + i, 30)); await page.waitForTimeout(30); }
const heavy = [];
for (let i = 0; i < 5; i++) { heavy.push(await sample(0, 300 + i, 60)); await page.waitForTimeout(30); }
function stats(values) {
  const a = [...values].sort((x,y) => x-y);
  const p = q => a[Math.round((a.length - 1) * q)];
  return { n:a.length, min:p(0), p50:p(.5), p95:p(.95), max:p(1), raw:values };
}
// Simulated visibilityState is deterministic in headless Chromium; real rAF/DOM still run.
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
await page.evaluate(() => window.__latency.dispatch({ key:'hidden-event', source:'j7-fomo', type:'buy', ts:Date.now(), symbol:'HIDDEN', handle:'hidden', addr:'0x7777777777777777777777777777777777777777', chain:'eth' }));
await page.waitForTimeout(80);
assert.equal(await page.locator('[data-gdh-fomo-key="hidden-event"]').count(), 0);
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable:true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForFunction(() => document.querySelector('[data-gdh-fomo-key="hidden-event"]'));
const oldEpoch = await page.evaluate(() => window.__latency.epoch());
await page.evaluate(() => {
  for (const fn of window.__fixture.storageListeners) fn({ j7TrackerSessionV1: { newValue:null } }, 'local');
  for (const callback of window.__fixture.pending) callback?.({ok:true,events:window.__fixture.events});
});
await page.evaluate(epoch => { for (const fn of window.__fixture.runtimeListeners) fn({type:'gdh-fomo-push',epoch,event:{key:'old-account',source:'j7-fomo',type:'buy',ts:Date.now()}}); }, oldEpoch);
await page.waitForTimeout(80);
assert.equal(await page.locator('.gdh-fomofeed').count(), 0, 'logout rejects queued old snapshots and pushes');
const metrics = await page.evaluate(() => window.__latency.metrics());
assert.ok(metrics.length > 0 && metrics.length <= 100);
assert.ok(metrics.every(m => Object.keys(m).join() === 'receiveToInsertionMs' && Number.isFinite(m.receiveToInsertionMs)));
const result = { synthetic:true, externalNetwork:'blocked', immediate:stats(immediate), throttled:stats(throttled), medium:stats(medium), heavy:stats(heavy), hiddenVisible:'passed (simulated visibility)', logoutRace:'passed', metrics };
fs.mkdirSync(`${root}/test-results`, {recursive:true});
fs.writeFileSync(`${root}/test-results/j7-latency.json`, JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
await context.close(); await browser.close();
