import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Synthetic direct-provider callback tests. Never attach to a live browser/account.
const root = fileURLToPath(new URL('../', import.meta.url));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
const reports = [];
try {
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', route => route.fulfill({ contentType: route.request().isNavigationRequest() ? 'text/html' : 'application/json', body: route.request().isNavigationRequest() ? '<!doctype html><html><body></body></html>' : '{}' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://gmgn.ai/eth/token/0x1111111111111111111111111111111111111111');
  await page.evaluate(version => {
    const state = { fomoToken:{token:'synthetic-direct-token'}, enabled:true, enableFomoFeed:true, enablePumpFeed:false, enableFomoPanel:false, enableHoldingSurge:false, enableManifestoTab:false, enableManifestoToast:false, enableMarkedHolders:false, enableFlapTax:false, markedListMigratedV2:true };
    const f = window.__fixture = { state, pending:[], listeners:[], runtimeListeners:[], blockedHistory:[] };
    const local = {
      get(keys, cb) {
        const out = typeof keys === 'object' && !Array.isArray(keys) ? {...keys} : {};
        for (const key of typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(out)) if (key in state) out[key] = state[key];
        if (cb) queueMicrotask(() => cb(out)); else return Promise.resolve(out);
      },
      set(values, cb) { Object.assign(state, values); if (cb) queueMicrotask(cb); return Promise.resolve(); },
    };
    window.chrome = { storage:{local,onChanged:{addListener(fn){f.listeners.push(fn);}}}, runtime:{ id:'synthetic', lastError:null, getManifest:()=>({version}), getURL:p=>p, onMessage:{addListener(fn){f.runtimeListeners.push(fn);}}, sendMessage(msg, cb) {
      if (msg.type === 'fomo-followed-feed') { f.pending.push(cb); return; }
      if (['fomo-feed','pump-feed','fomo-token-feed'].includes(msg.type)) { f.blockedHistory.push(cb); return; }
      if (cb) queueMicrotask(()=>cb({ok:false,events:[],items:[]})); else return Promise.resolve({ok:false});
    } } };
  }, JSON.parse(fs.readFileSync(`${root}/manifest.json`)).version);
  const hooks = `window.__direct = {
    poll: pollFomoFollowedFeed,
    epoch: () => fomoFollowedEpoch,
    identity: trackingFeedEventIdentity,
    eligible: () => visibleTrackingFeedEvents(nativeTrackingFeedRows(trackerCards())).map(e => e.key),
    prepare: () => { lastFullScanAt = Date.now(); scanCostEma = 60; fomoFeedLastPollAt = Date.now(); pumpFeedLastPollAt = Date.now(); },
    settings: values => { Object.assign(settings, values); rebuildBlockedTokenIndex(); },
  };`;
  await page.addStyleTag({ path:`${root}/styles.css` });
  await page.addScriptTag({ content:fs.readFileSync(`${root}/content.js`,'utf8').replace(/\}\)\(\);\s*$/, `${hooks}\n})();`) });
  await page.waitForFunction(() => window.__direct?.epoch());
  // Wait for asynchronous storage initialization without relying on live APIs.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));

  async function layout(mode, boundary) {
    await page.evaluate(({mode,boundary}) => {
      document.querySelector('#native-fixture')?.remove();
      const host = document.createElement('div'); host.id='native-fixture'; host.style.cssText='position:relative;width:1000px;height:600px';
      const now = Date.now(); window.__fixture.now = now;
      for (let i=0;i<2;i++) {
        const wrap=document.createElement('div');
        if (mode==='fixed') wrap.style.cssText=`position:absolute;top:${i*70}px;height:70px;width:1000px`;
        const card=document.createElement('div'); card.dataset.sentryComponent='TrackerListItem';
        card.dataset.gdhTrackTs=String(boundary==='untimed' ? 0 : now-i*10000);
        card.dataset.gdhTrackAddr='0x8888888888888888888888888888888888888888';
        card.style.height='70px';
        const symbol=document.createElement('span'); symbol.dataset.testid='follow-tracking-row-symbol'; symbol.textContent='NATIVE';
        const maker=document.createElement('span'); maker.dataset.testid='follow-tracking-row-maker'; maker.textContent='synthetic maker';
        card.append(symbol,maker); wrap.append(card); host.append(wrap);
      }
      document.body.append(host); window.__fixture.pending=[];
    },{mode,boundary});
  }
  async function deliver(events, expected, response = {}, push = false) {
    const result = await page.evaluate(async ({events,expected,response,push}) => {
      const f=window.__fixture; window.__direct.prepare();
      f.pending=[]; window.__direct.poll();
      const callback=f.pending.shift(); if (!callback) throw new Error('actual followed callback not requested');
      const started=performance.now();
      const observed = new Map();
      return await new Promise((resolve,reject)=>{
        const check=()=>{
          for (const card of document.querySelectorAll('.gdh-fomofeed.is-followed')) if (!observed.has(card.dataset.gdhFomoKey)) observed.set(card.dataset.gdhFomoKey,performance.now()-started);
          const eligible=window.__direct.eligible();
          const placed=[...document.querySelectorAll('.gdh-fomofeed.is-followed')].map(c=>c.dataset.gdhFomoKey);
          if (placed.length===expected && eligible.length===expected) {
            observer.disconnect(); clearTimeout(timer);
            resolve({received:events.length,eligible:eligible.length,placed:placed.length,eligibleKeys:eligible,keys:placed,latencies:[...observed.values()],elapsed:performance.now()-started});
          }
        };
        const observer=new MutationObserver(check); observer.observe(document.body,{childList:true,subtree:true});
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error(`callback timeout received=${events.length} eligible=${window.__direct.eligible().length} placed=${document.querySelectorAll('.gdh-fomofeed.is-followed').length}`));},900);
        if (push) {
          f.stalledCallback=callback;
          for (const fn of f.runtimeListeners) fn({type:'fomo-followed-feed-update',epoch:window.__direct.epoch(),data:{ok:true,events,updatedAt:Date.now(),...response}});
        } else callback({ok:true,events, ...response});
        requestAnimationFrame(check);
      });
    },{events,expected,response,push});
    assert.equal(result.eligible,expected); assert.equal(result.placed,expected);
    assert.deepEqual([...result.keys].sort(), [...result.eligibleKeys].sort(), 'every eligible identity must have its own connected DOM card');
    assert.ok(result.elapsed<750,`heavy scan callback took ${result.elapsed}ms`);
    return result;
  }
  async function eventsFor(label,boundary) {
    const now=await page.evaluate(()=>window.__fixture.now);
    return Array.from({length:10},(_,i)=>({key:`${label}-${i}`,eventId:`${label}-${i}`,swapId:`${label}-${i}`,tradeId:'one-position',tx:'legacy-position-not-unique',source:'fomo-followed',type:'buy',userId:'alice',handle:'alice',name:'Synthetic Alice',symbol:`S${i}`,chain:'eth',addr:'0x3333333333333333333333333333333333333333',usd:24,ts:now+(boundary==='head'?5000:boundary==='oldest'?-20000:-5000)-i}));
  }
  for (const mode of ['flow','fixed']) for (const boundary of ['head','inline','oldest','untimed']) {
    await layout(mode,boundary);
    const events=await eventsFor(`${mode}-${boundary}`,boundary);
    const result=await deliver(events,10);
    assert.equal(new Set(result.keys).size,10);
    reports.push({scenario:`heavy scanner ${mode}/${boundary} burst`,...result});
  }
  await layout('fixed','inline');
  const same=await eventsFor('position','inline');
  same.forEach((event,i)=>{
    event.key='legacy-position-key'; event.tx='same-transaction';
    event.type=i<4?'buy':i<7?'sell':'thesis';
    if (event.type==='thesis') {event.commentId=`comment-${i}`;delete event.swapId;}
  });
  reports.push({scenario:'same-position buys sells theses preserved',...await deliver(same,10)});
  fs.mkdirSync(`${root}/test-results`, { recursive:true });
  await page.screenshot({path:`${root}/test-results/fomo-followed-burst.png`,fullPage:true});
  // Duplicate provider records with alternate wrapper keys must stay one event.
  reports.push({scenario:'provider identity dedup across repeated response and wrapper keys',...await deliver([...same,...same.map(e=>({...e,key:`other-${e.eventId}`}))],10)});
  const shared=[{...same[0],key:'a',swapId:'shared-id',userId:'alice'},{...same[0],key:'b',swapId:'shared-id',userId:'bob'},{...same[0],key:'c',swapId:'shared-id',userId:'alice',type:'sell'}];
  reports.push({scenario:'provider identity includes user and event kind',...await deliver(shared,3)});
  await page.evaluate(()=>window.__direct.settings({fomoFeedTypes:{buy:false,sell:true,thesis:true}}));
  reports.push({scenario:'type filter remains effective',...await deliver(same,6)});
  await page.evaluate(()=>window.__direct.settings({fomoFeedTypes:{buy:true,sell:true,thesis:true},fomoFeedChainOnly:true}));
  reports.push({scenario:'chain filter remains effective',...await deliver(same.map(e=>({...e,chain:'sol'})),0)});
  await page.evaluate(()=>window.__direct.settings({fomoFeedChainOnly:false}));
  await page.evaluate(()=>window.__direct.settings({blockedTokens:[{address:'0x3333333333333333333333333333333333333333'}]}));
  reports.push({scenario:'blocked-token filter remains effective',...await deliver(same,0)});
  await page.evaluate(()=>window.__direct.settings({blockedTokens:[]}));
  const nativeEvents=same.slice(0,3).map((e,i)=>({...e,tx:i<2?'real-native-hash':'distinct-hash',type:i===1?'thesis':'buy',commentId:i===1?'native-thesis':undefined}));
  await page.evaluate(()=>Object.assign(document.querySelector('[data-sentry-component="TrackerListItem"]').dataset, {gdhTrackTx:'real-native-hash',gdhTrackAddr:'0x3333333333333333333333333333333333333333',gdhTrackChain:'eth',gdhTrackSide:'buy'}));
  reports.push({scenario:'exact native transaction dedup preserves thesis and other swaps',...await deliver(nativeEvents,2)});
  const legs = [
    {...same[0],swapId:'leg-token',tx:'real-native-hash',addr:'0x4444444444444444444444444444444444444444'},
    {...same[0],swapId:'leg-side',tx:'real-native-hash',type:'sell'},
    {...same[0],swapId:'leg-chain',tx:'real-native-hash',chain:'base'},
  ];
  reports.push({scenario:'same transaction distinct token side and chain legs survive',...await deliver(legs,3)});
  await page.evaluate(()=>delete document.querySelector('[data-sentry-component="TrackerListItem"]').dataset.gdhTrackChain);
  reports.push({scenario:'missing native metadata cannot prove a duplicate',...await deliver(nativeEvents,3)});
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));window.__fixture.pending=[];window.__direct.poll();window.__fixture.pending.shift()({ok:true,events:[{key:'hidden',eventId:'hidden',type:'buy',userId:'alice',ts:Date.now(),symbol:'HIDDEN'}]});});
  await page.waitForTimeout(50);
  assert.equal(await page.getByText('HIDDEN',{exact:true}).count(),0);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>[...document.querySelectorAll('.gdh-fomofeed.is-followed')].some(c=>c.textContent.includes('HIDDEN')));
  reports.push({scenario:'hidden-to-visible recovery (simulated visibility, real rAF)',passed:true});
  await page.evaluate(()=>{
    window.__fixture.pending=[];window.__direct.poll(); const old=window.__fixture.pending.shift();
    for (const fn of window.__fixture.listeners) fn({fomoToken:{oldValue:{token:'synthetic-old'},newValue:null}},'local');
    old({ok:true,events:[{key:'old-account',eventId:'old-account',type:'buy',ts:Date.now(),symbol:'OLD_ACCOUNT'}]});
  });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.gdh-fomofeed.is-followed').count(),0);
  reports.push({scenario:'logout immediately removes cards and rejects delayed callback',passed:true});
  // A new credential epoch enables direct pushes while cold history stays blocked.
  await page.evaluate(()=>{for (const fn of window.__fixture.listeners) fn({fomoToken:{oldValue:null,newValue:{token:'synthetic-new-token'}}},'local');});
  await page.waitForFunction(()=>window.__direct.epoch());
  const pushed=await eventsFor('pushed','head');
  reports.push({scenario:'incremental worker push places all 10 during stalled cold callback',...await deliver(pushed,10,{},true)});
  await page.evaluate(()=>window.__fixture.stalledCallback({ok:true,events:[],updatedAt:1}));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.gdh-fomofeed.is-followed').count(),10);
  reports.push({scenario:'late older poll cannot erase incremental arrivals',passed:true});
  const oldEpoch=await page.evaluate(()=>window.__direct.epoch());
  await page.evaluate(()=>{for (const fn of window.__fixture.listeners) fn({fomoToken:{oldValue:{token:'synthetic-new-token'},newValue:{token:'synthetic-third-token'}}},'local');});
  await page.waitForFunction(epoch=>window.__direct.epoch() && window.__direct.epoch()!==epoch,oldEpoch);
  await page.evaluate(({epoch,events})=>{for (const fn of window.__fixture.runtimeListeners) fn({type:'fomo-followed-feed-update',epoch,data:{ok:true,events,updatedAt:Date.now()}});},{epoch:oldEpoch,events:pushed});
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.gdh-fomofeed.is-followed').count(),0);
  reports.push({scenario:'delayed old-credential worker push rejected after account switch',passed:true});
  assert.deepEqual(errors,[]);
  const latencies=reports.flatMap(r=>r.latencies||[]).sort((a,b)=>a-b);
  const result={synthetic:true,externalNetwork:'blocked',scenarios:reports.length,domInsertionMs:{n:latencies.length,p50:latencies[Math.floor(latencies.length*.5)],p95:latencies[Math.floor(latencies.length*.95)],max:latencies.at(-1)},reports};
  fs.mkdirSync(`${root}/test-results`,{recursive:true});
  fs.writeFileSync(`${root}/test-results/fomo-followed-browser-results.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,reports:reports.map(({keys,eligibleKeys,latencies,...rest})=>rest)},null,2));
} finally { await context.close(); await browser.close(); }
