import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// These are synthetic fixtures, not live FOMO/API observations. The complete
// production content scripts and styles execute in a real Chromium document.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const address = '0x1111111111111111111111111111111111111111';
const secondAddress = '0x2222222222222222222222222222222222222222';
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const reports = [];
const browser = await chromium.launch({ headless: true });
const fixture = '<!doctype html><html lang="en"><head><title>Isolated extension test fixture</title><style>body{margin:0;background:#101114;color:#ededed;font:14px Arial}main{padding:24px}button{font:inherit}</style></head><body><main><h1>Extension browser regression fixture</h1><p>Synthetic data. No live services or accounts.</p></main></body></html>';

async function boot(site, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: fixture })
    : route.fulfill({ contentType: 'application/json', body: '{}' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(site === 'gmgn' ? `https://gmgn.ai/eth/token/${address}` : `https://debot.ai/token/eth/${address}`);
  await page.evaluate(({ version, address }) => {
    const listeners = [];
    const state = {
      enabled: true, enableFomoPanel: true, fomoPanelOpen: true, debotFomoPanelOpen: true,
      fomoTranslate: false, enableFomoFeed: true, enablePumpFeed: true,
      enableHoldingSurge: false, enableManifestoTab: false, enableManifestoToast: false,
      enableMarkedHolders: false, enableFlapTax: false, markedListMigratedV2: true,
      j7TrackerFomoConfigV1: { connected:true, trackedCount:2, at:Date.now() },
      j7TrackerPumpConfigV1: { connected:true, trackedCount:2, at:Date.now() },
    };
    window.__fixture = { calls: [], pending: [], mode: 'success', source: 'holder-history', partial: true, followingKnown: true, address, copied: '' };
    const user = (name) => ({ id: name, userHandle: name, displayName: name });
    const item = (name, followed, side, action, ts) => ({
      id: name, user: user(name), followed, side, positionAction: action,
      createdAt: new Date(ts).toISOString(), humanAmount: 1200, usdAmount: 24,
      inTokenAddress: side === 'sell' ? address : '0x0000000000000000000000000000000000000000',
      outTokenAddress: side === 'buy' ? address : '0x0000000000000000000000000000000000000000',
      outToken: { address, ticker: 'TEST' }, inToken: { address, ticker: 'TEST' },
      trade: { id: name, tokenAddress: address },
    });
    window.__fixture.response = () => ({
      ok: true, source: window.__fixture.source, partial: window.__fixture.partial,
      followingKnown: window.__fixture.followingKnown, fetchedAt: Date.now() - 20000,
      coverage: { attempted: 3, succeeded: 2, limit: 50, truncated: false },
      total: 3, count: 3, items: [item('alice_fixture', true, 'buy', 'More', Date.now()-2000), item('bob_fixture', false, 'buy', 'First', Date.now()-1000), item('exit_fixture', true, 'sell', 'All', Date.now()-3000)],
      token: 'SECRET_SENTINEL', message: 'SECRET_SENTINEL',
    });
    window.__fixture.j7Fomo = () => ({ ok:true, source:'j7tracker', events:[
      { key:'j7-fomo-buy', source:'j7-fomo', type:'buy', ts:Date.now()-1000, name:'Alice Fixture', handle:'alice_fixture', symbol:'BUY', addr:'0x3333333333333333333333333333333333333333', chain:'bsc', usd:42, mc:750000, img:'https://images.fixture/token.png' },
      { key:'j7-fomo-sell', source:'j7-fomo', type:'sell', ts:Date.now()-2000, name:'Alice Fixture', handle:'alice_fixture', symbol:'SELL', addr:'0x4444444444444444444444444444444444444444', chain:'bsc', usd:24, mc:700000 },
      { key:'j7-fomo-thesis', source:'j7-fomo', type:'thesis', ts:Date.now()-3000, name:'Alice Fixture', handle:'alice_fixture', symbol:'NOTE', addr:'0x5555555555555555555555555555555555555555', chain:'bsc', comment:'Synthetic J7Tracker narrative' },
    ] });
    window.__fixture.j7Pump = () => ({ ok:true, source:'j7tracker', events:[
      { key:'j7-pump-callout', source:'j7-pump', type:'callout', ts:Date.now()-4000, name:'Bob Fixture', handle:'bob_fixture', symbol:'CALL', addr:'0x6666666666666666666666666666666666666666', chain:'bsc', mc:650000, comment:'Synthetic J7Tracker callout' },
      { key:'j7-pump-reply', source:'j7-pump', type:'reply', ts:Date.now()-5000, name:'Bob Fixture', handle:'bob_fixture', symbol:'REPLY', addr:'0x7777777777777777777777777777777777777777', chain:'bsc', comment:'Synthetic J7Tracker reply' },
    ] });
    function sendMessage(message, callback) {
      window.__fixture.calls.push(message.type);
      let promise;
      if (message.type === 'fomo-token-feed') {
        const f = window.__fixture;
        if (f.mode === 'pending') promise = new Promise(resolve => f.pending.push(resolve));
        else if (f.mode === 'throw') promise = Promise.reject(new Error('Extension context invalidated. SECRET_SENTINEL'));
        else if (f.mode === 'network') promise = Promise.resolve({ ok: false, reason: 'network', message: 'SECRET_SENTINEL' });
        else if (f.mode === 'rate') promise = Promise.resolve({ ok: false, reason: 'http-429', status: 429, retryAt: Date.now() + 60000 });
        else promise = Promise.resolve(f.response());
      } else if (message.type === 'fomo-feed') promise = Promise.resolve(window.__fixture.j7Fomo());
      else if (message.type === 'pump-feed') promise = Promise.resolve(window.__fixture.j7Pump());
      else if (message.type === 'fomo-followed-feed') promise = Promise.resolve({ ok:true, events:[], coverageGap:true, gapReason:'page-cap', updatedAt:Date.now(), fetchedAt:Date.now() });
      else promise = Promise.resolve({ ok: false, reason: 'fixture-disabled', items: [], events: [] });
      if (callback) { promise.then(callback, () => callback(undefined)); return; }
      return promise;
    }
    const local = {
      get(keys, callback) {
        const result = typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {};
        for (const key of (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(result))) if (key in state) result[key] = state[key];
        if (callback) { queueMicrotask(() => callback(result)); return; }
        return Promise.resolve(result);
      },
      set(values, callback) { Object.assign(state, values); if (callback) queueMicrotask(callback); return Promise.resolve(); },
    };
    window.__fixture.storageChange = changes => listeners.forEach(fn => fn(changes, 'local'));
    window.chrome = { runtime: { id: 'fixture', getManifest: () => ({ version }), sendMessage, onMessage: { addListener() {} }, getURL: p => p }, storage: { local, onChanged: { addListener: fn => listeners.push(fn) } } };
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText: async text => { window.__fixture.copied = text; } } });
  }, { version: manifest.version, address });
  const file = site === 'gmgn' ? 'content.js' : 'debot-content.js';
  const hooks = site === 'gmgn'
    ? 'window.__test = { shift: setFomoFeedRowShift, insertionShift: fomoFeedInsertionShift, gap: renderFomoFollowedGap, relativeTime: fomoFeedRelTime, feedCard: event => fomoFeedCardFor(event), pollJ7Fomo: () => pollFomoFeed(), pollJ7Pump: () => pollPumpFeed(), scanJ7Feed: () => scanFomoFeed(), load: () => loadFomoData(true), sync: () => scanVisibleCards(), tab: value => {fomoTab=value;return loadFomoData(true);}, close: () => {setFomoOpen(false);scanVisibleCards();}, open: () => {setFomoOpen(true);scanVisibleCards();} };'
    : 'window.__test = { gap: renderFomoFollowedGap, feedCard: event => buildFeedCard(event), load: () => loadPanel(true), sync: () => syncRoute(), tab: value => {panelTab=value;return loadPanel(true);}, close: () => {settings.debotFomoPanelOpen=false;syncPanel();}, open: () => {settings.debotFomoPanelOpen=true;syncPanel();} };';
  const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\}\)\(\);\s*$/, `${hooks}\n})();`);
  await page.addStyleTag({ path: path.join(root, site === 'gmgn' ? 'styles.css' : 'debot-styles.css') });
  await page.addScriptTag({ content: source });
  const panel = site === 'gmgn' ? '.gdh-fomo-panel' : '.gdh-debot-fomo';
  await page.locator(panel).waitFor({ timeout: 10000 });
  return { context, page, errors, panel };
}

try {
  for (const site of ['gmgn', 'debot']) {
    const { context, page, errors, panel } = await boot(site);
    try {
      await page.getByRole('button', { name: 'Trades', exact: true }).click();
      await page.waitForFunction(() => document.body.innerText.includes('alice_fixture'));
      assert.match(await page.locator(panel).innerText(), /holder histor/i);
      assert.match(await page.locator(panel).innerText(), /partial|incomplete/i);
      await page.getByRole('button', { name: 'Following only' }).click();
      const list = page.locator(`${panel} [data-fomo-list]`);
      assert.match(await list.innerText(), /alice_fixture/);
      assert.doesNotMatch(await list.innerText(), /bob_fixture/);
      assert.match(await list.innerText(), /exit_fixture/);
      reports.push({ site, scenario: 'following filter preserves buys and exits', passed:true });
      await page.getByRole('button', { name: 'Copy diagnostics', exact:true }).click();
      const copied = await page.evaluate(() => window.__fixture.copied);
      assert.doesNotMatch(copied, /SECRET_SENTINEL|alice_fixture|0x1111/);
      assert.deepEqual(Object.keys(JSON.parse(copied)).sort(), ['chain','coverage','source','status','tab','timestamps','version']);
      reports.push({ site, scenario: 'clipboard diagnostics whitelist', passed:true });
      await page.evaluate(() => { window.__fixture.followingKnown = false; return window.__test.load(); });
      assert.match(await list.innerText(), /Following lookup unavailable/);
      assert.doesNotMatch(await list.innerText(), /No followed/);
      reports.push({ site, scenario: 'unknown following is not empty activity', passed:true });
      await page.evaluate(() => { window.__fixture.followingKnown = true; return window.__test.load(); });
      await page.screenshot({ path: path.join(output, `${site}-trust-desktop.png`) });
      reports.push({ site, scenario: 'source and partial coverage rendered', passed:true });
      const callout = await page.evaluate(() => {
        const card = window.__test.feedCard({
          key: 'j7-callout-fixture', source: 'j7-pump', type: 'callout',
          ts: Date.now() - 2000, name: 'J7 Fixture', handle: 'j7_fixture',
          addr: '0x3333333333333333333333333333333333333333', chain: 'bsc',
          ticker: 'J7T', mc: 750000, comment: 'Synthetic J7Tracker callout text',
        });
        card.dataset.j7Fixture = '1';
        if (card.classList.contains('gdh-debot-feed__row')) {
          card.style.gridTemplateColumns = '220px 160px 100px 100px 100px 80px';
        }
        document.body.appendChild(card);
        const rect = card.getBoundingClientRect();
        const computed = getComputedStyle(card);
        return { text: card.innerText, className: card.className, height: rect.height, gridRows: computed.gridTemplateRows, position: computed.position };
      });
      assert.match(callout.text, /J7 · Pump/);
      assert.match(callout.text, /Callout/);
      assert.match(callout.text, /Synthetic J7Tracker callout text/);
      assert.match(callout.className, /is-callout/);
      assert.ok(callout.height <= 120, `${site}: J7 callout card is unexpectedly ${callout.height}px tall (${callout.gridRows}, ${callout.position})`);
      await page.locator('[data-j7-fixture="1"]').screenshot({ path: path.join(output, `${site}-j7-callout.png`) });
      await page.evaluate(() => document.querySelector('[data-j7-fixture="1"]')?.remove());
      reports.push({ site, scenario: 'J7Tracker Pump callout label and narrative render in a real card', passed:true });
      if (site === 'gmgn') {
        const integrated = await page.evaluate(async () => {
          const native = document.createElement('div');
          native.dataset.sentryComponent = 'TrackerListItem';
          native.dataset.gdhTrackAddr = '0x8888888888888888888888888888888888888888';
          native.dataset.gdhTrackTs = String(Date.now());
          const symbol = document.createElement('span'); symbol.dataset.testid = 'follow-tracking-row-symbol'; symbol.textContent = 'NATIVE';
          const maker = document.createElement('span'); maker.dataset.testid = 'follow-tracking-row-maker'; maker.textContent = 'fixture maker';
          native.append(symbol, maker); document.body.appendChild(native);
          window.__test.pollJ7Fomo(); window.__test.pollJ7Pump();
          await new Promise(resolve => setTimeout(resolve, 20));
          window.__test.scanJ7Feed();
          await new Promise(resolve => requestAnimationFrame(resolve));
          const cards = [...document.querySelectorAll('.gdh-fomofeed')];
          const result = { count:cards.length, text:cards.map(card => card.innerText).join('\n'), nativeStillMounted:native.isConnected };
          const staleEvent = { ...window.__fixture.j7Fomo().events[0], stale:true };
          window.__fixture.j7Fomo = () => ({ ok:false, reason:'network', stale:true, events:[staleEvent] });
          window.__test.pollJ7Fomo();
          await new Promise(resolve => setTimeout(resolve, 20));
          window.__test.scanJ7Feed();
          await new Promise(resolve => requestAnimationFrame(resolve));
          result.staleText = [...document.querySelectorAll('.gdh-fomofeed')].map(card => card.innerText).join('\n');
          document.querySelectorAll('.gdh-fomofeed').forEach(card => card.remove()); native.remove();
          return result;
        });
        assert.equal(integrated.count, 5);
        assert.match(integrated.text, /Alice Fixture/);
        assert.match(integrated.text, /Buy/);
        assert.match(integrated.text, /Sell/);
        assert.match(integrated.text, /Narrative/);
        assert.match(integrated.text, /Callout/);
        assert.match(integrated.text, /Reply/);
        assert.match(integrated.staleText, /J7 · FOMO · stale/);
        assert.match(integrated.staleText, /Alice Fixture/);
        assert.equal(integrated.nativeStillMounted, true);
        reports.push({ site, scenario:'J7Tracker polling callback inserts FOMO and Pump event families beside a native tracking row', passed:true, integrated });
      }
      await page.evaluate(() => { window.__fixture.mode = 'network'; return window.__test.load(); });
      assert.match(await page.locator(panel).innerText(), /stale/i);
      assert.match(await list.innerText(), /alice_fixture/);
      const countBefore = await page.evaluate(() => window.__fixture.calls.length);
      await page.evaluate(() => { window.__fixture.mode = 'success'; });
      await page.getByRole('button', { name: 'Retry FOMO refresh', exact:true }).click();
      await page.waitForFunction(() => !document.querySelector('.gdh-fomo-ui__status')?.textContent.includes('Stale'));
      assert.ok(await page.evaluate(() => window.__fixture.calls.length) > countBefore);
      reports.push({ site, scenario: 'network error retains stale same-view data and retry recovers', passed:true });
      await page.evaluate(() => { window.__fixture.mode = 'throw'; return window.__test.load(); });
      assert.match(await page.locator(panel).innerText(), /Extension connection unavailable/);
      assert.doesNotMatch(await page.locator(panel).innerText(), /SECRET_SENTINEL/);
      reports.push({ site, scenario: 'extension messaging rejection has safe recovery guidance', passed:true });
      await page.evaluate(() => { window.__fixture.mode = 'rate'; return window.__test.load(); });
      assert.equal(await page.getByRole('button', { name: 'Retry FOMO refresh', exact:true }).isDisabled(), true);
      const beforeRate = await page.evaluate(() => window.__fixture.calls.length);
      await page.evaluate(() => window.__test.load());
      assert.equal(await page.evaluate(() => window.__fixture.calls.length), beforeRate);
      reports.push({ site, scenario: '429 retry window blocks forced reload', passed:true });
      // A route switch must discard the old view and reset its retry window.
      await page.evaluate(({ site, secondAddress }) => {
        window.__fixture.mode = 'pending';
        history.pushState({}, '', site === 'gmgn' ? `/eth/token/${secondAddress}` : `/token/eth/${secondAddress}`);
        window.__test.sync();
      }, { site, secondAddress });
      await page.waitForFunction(() => window.__fixture.pending.length > 0);
      assert.doesNotMatch(await list.innerText(), /alice_fixture/);
      await page.evaluate(() => {
        const f = window.__fixture;
        const old = f.response();
        old.items = old.items.map(item => ({ ...item, user:{ id:'old', userHandle:'OLD_ACCOUNT', displayName:'OLD_ACCOUNT' } }));
        f.mode = 'success';
        f.storageChange({ fomoToken:{ oldValue:{token:'old-fixture-account'}, newValue:{token:'new-fixture-account'} } });
        f.pending.splice(0).forEach(resolve => resolve(old));
      });
      await page.waitForFunction(() => document.body.innerText.includes('alice_fixture'));
      assert.doesNotMatch(await page.locator(panel).innerText(), /OLD_ACCOUNT/);
      reports.push({ site, scenario: 'account change discards slow old response and previous route data', passed:true });
      // An old Trades response must not paint after switching to Holders.
      await page.evaluate(() => { window.__fixture.mode = 'pending'; void window.__test.load(); });
      await page.waitForFunction(() => window.__fixture.pending.length > 0);
      await page.evaluate(async () => {
        const f = window.__fixture;
        const old = f.response(); old.items = [{...old.items[0],user:{ userHandle:'OLD_TRADES',displayName:'OLD_TRADES' }}];
        f.mode='success'; f.source='holders';
        await window.__test.tab('holders');
        f.pending.splice(0).forEach(resolve => resolve(old));
      });
      assert.doesNotMatch(await page.locator(panel).innerText(), /OLD_TRADES/);
      assert.match(await page.locator(panel).innerText(), /Current holdings/);
      reports.push({ site, scenario: 'slow trade response cannot paint holders tab', passed:true });
      await page.evaluate(() => { window.__fixture.mode='pending'; void window.__test.load(); });
      await page.waitForFunction(() => window.__fixture.pending.length > 0);
      await page.evaluate(() => {
        const f=window.__fixture; const old=f.response(); old.items=[{...old.items[0],user:{userHandle:'OLD_PANEL',displayName:'OLD_PANEL'}}];
        window.__test.close(); f.mode='success'; window.__test.open();
        f.pending.splice(0).forEach(resolve=>resolve(old));
      });
      await page.waitForFunction(() => document.body.innerText.includes('alice_fixture'));
      assert.doesNotMatch(await page.locator(panel).innerText(), /OLD_PANEL/);
      reports.push({ site, scenario: 'panel close and reopen invalidates old request', passed:true });
      await page.evaluate(() => window.__test.gap({ coverageGap:true }));
      assert.equal(await page.locator('.gdh-fomo-feed-gap').count(), 1);
      await page.evaluate(() => window.__test.gap({ coverageGap:false, stale:false }));
      assert.equal(await page.locator('.gdh-fomo-feed-gap').count(), 0);
      reports.push({ site, scenario:'single coverage notice clears after proven catch-up', passed:true });
      if (site === 'gmgn') {
        const ageScale = await page.evaluate(() => {
          const now = Date.now();
          return [1200, 59000, 60000, 120000, 3600000, 86400000]
            .map(age => window.__test.relativeTime(now-age));
        });
        assert.deepEqual(ageScale, ['1s','59s','1m','2m','1h','1d']);
        const liveTableTime = await page.evaluate(async () => {
          const header = document.createElement('div');
          header.dataset.testid = 'follow-tracking-table-header';
          document.body.appendChild(header);
          const event = { key:'time-fixture', source:'fomo', type:'buy', ts:Date.now()-1200, name:'Timer', handle:'timer' };
          const built = window.__test.feedCard(event);
          const card = built.cloneNode(true);
          card.dataset.gdhFomoKey = 'time-fixture';
          built.remove();
          document.body.appendChild(card);
          const selector = '.gdh-fomofeed__ttime';
          const first = card.querySelector(selector)?.textContent;
          await new Promise(resolve => setTimeout(resolve, 1100));
          const second = card.querySelector(selector)?.textContent;
          return { first, second };
        });
        assert.equal(liveTableTime.first, '1s');
        assert.equal(liveTableTime.second, '2s');
        await page.locator('[data-gdh-fomo-key="time-fixture"]').screenshot({ path:path.join(output,'gmgn-live-table-time.png') });
        await page.evaluate(() => {
          document.querySelector('[data-gdh-fomo-key="time-fixture"]')?.remove();
          document.querySelector('[data-testid="follow-tracking-table-header"]')?.remove();
        });
        reports.push({site,scenario:'FOMO table-row age advances every second through the full age scale',passed:true,liveTableTime,ageScale});
        const geometry = await page.evaluate(() => {
          const wrap = document.createElement('div');
          wrap.style.cssText='position:absolute;top:200px;left:40px;height:400px;width:300px';
          const row = document.createElement('div');
          row.style.cssText='position:absolute;top:0;transform:translateY(130px);height:64px;width:300px';
          row.textContent='Synthetic virtual row'; wrap.appendChild(row); document.body.appendChild(wrap);
          const original=row.getBoundingClientRect().top;
          const shift=window.__test.insertionShift(130,[{afterTop:100,height:66}]);
          window.__test.shift(row,shift);
          const shifted=row.getBoundingClientRect().top;
          const transform=row.style.transform;
          window.__test.gap({coverageGap:true});
          const withNotice=row.getBoundingClientRect().top;
          window.__test.shift(row,0);
          const restored=row.getBoundingClientRect().top;
          wrap.remove(); window.__test.gap({coverageGap:false});
          return {original,shifted,withNotice,restored,transform};
        });
        assert.equal(geometry.shifted-geometry.original,66);
        assert.equal(geometry.withNotice,geometry.shifted);
        assert.equal(geometry.restored,geometry.original);
        assert.equal(geometry.transform,'translateY(130px)');
        reports.push({site,scenario:'rendered virtual-row offsets preserve native transform and ignore coverage notice',passed:true,geometry});
        const hover = await page.evaluate(() => {
          const card=document.createElement('div');
          card.dataset.testid='trench-token-card'; card.dataset.gdhWatched='1';
          card.style.cssText='position:absolute;left:40px;top:200px;width:300px;height:80px';
          const body=document.createElement('span'); body.textContent='Synthetic watched token';
          const badge=document.createElement('span'); badge.className='gdh-dev-performance'; badge.textContent='M 2 / L 4 / 50% / ATH';
          card.append(body,badge);document.body.appendChild(card);
          const over=target=>target.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,clientX:100,clientY:220}));
          over(body); const onBody=!!document.querySelector('.gdh-tooltip--visible');
          over(badge); const onBadge=!!document.querySelector('.gdh-tooltip--visible');
          badge.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
          const afterClick=!!document.querySelector('.gdh-tooltip--visible');
          card.remove();return{onBody,onBadge,afterClick};
        });
        assert.deepEqual(hover,{onBody:false,onBadge:true,afterClick:false});
        reports.push({site,scenario:'real DOM badge-only developer hover and click dismissal',passed:true});
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  for (const site of ['gmgn', 'debot']) {
    for (const width of [390, 768]) {
      const { context, page, panel, errors } = await boot(site, width);
      try {
        await page.getByRole('button', { name: 'Trades', exact:true }).click();
        await page.waitForFunction(() => document.body.innerText.includes('exit_fixture'));
        const geometry = await page.locator(panel).evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const rect = r => ({ x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom });
          return { width:innerWidth, scrollWidth:document.documentElement.scrollWidth, panel:rect(bounds), controls:[...element.querySelectorAll('.gdh-fomo-ui__controls button')].map(e=>rect(e.getBoundingClientRect())), buttons:[...element.querySelectorAll('button')].filter(e=>e.offsetWidth && e.offsetHeight).map(e=>rect(e.getBoundingClientRect())) };
        });
        assert.equal(geometry.width, width);
        assert.ok(geometry.scrollWidth <= width, `${site}: document overflow at ${width}`);
        assert.ok(geometry.panel.x >= 0 && geometry.panel.right <= width, `${site}: panel outside viewport`);
        for (const control of geometry.buttons) assert.ok(control.x >= geometry.panel.x && control.right <= geometry.panel.right + 1, `${site}: control overflow at ${width}`);
        for (const control of geometry.controls) assert.ok(control.height >= 28, `${site}: tiny recovery control`);
        await page.screenshot({ path:path.join(output, `${site}-trust-${width}.png`) });
        reports.push({ site, scenario:`responsive controls ${width}px`, passed:true, geometry });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(output, 'fomo-browser-results.json'), JSON.stringify(reports, null, 2));
}
console.log(`Browser scenarios passed: ${reports.length}`);
