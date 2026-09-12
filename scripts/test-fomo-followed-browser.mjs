import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installNativeBridge } from './native-tracker-fixture.mjs';

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
    const f = window.__fixture = { state, pending:[], listeners:[], runtimeListeners:[], blockedHistory:[], debug:[] };
    const local = {
      get(keys, cb) {
        const out = typeof keys === 'object' && !Array.isArray(keys) ? {...keys} : {};
        for (const key of typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(out)) if (key in state) out[key] = state[key];
        if (cb) queueMicrotask(() => cb(out)); else return Promise.resolve(out);
      },
      set(values, cb) { Object.assign(state, values); if (cb) queueMicrotask(cb); return Promise.resolve(); },
    };
    window.chrome = { storage:{local,onChanged:{addListener(fn){f.listeners.push(fn);}}}, runtime:{ id:'synthetic', lastError:null, getManifest:()=>({version}), getURL:p=>p, onMessage:{addListener(fn){f.runtimeListeners.push(fn);}}, sendMessage(msg, cb) {
      if (msg.type === 'debug-render') { f.debug.push(msg.fields);if(cb)cb({ok:true});return; }
      if (msg.type === 'fomo-followed-feed') { f.pending.push(cb); return; }
      if (['fomo-feed','pump-feed','fomo-token-feed'].includes(msg.type)) { f.blockedHistory.push(cb); return; }
      if (cb) queueMicrotask(()=>cb({ok:false,events:[],items:[]})); else return Promise.resolve({ok:false});
    } } };
  }, JSON.parse(fs.readFileSync(`${root}/manifest.json`)).version);
  await installNativeBridge(page);
  const hooks = `window.__direct = {
    poll: pollFomoFollowedFeed,
    build: buildFomoFeedCard,
    table: buildFomoFeedTableRow,
    epoch: () => fomoFollowedEpoch,
    identity: trackingFeedEventIdentity,
    eligible: () => visibleTrackingFeedEvents(nativeTrackingFeedRows(trackerCards())).map(e => e.key),
    prepare: () => { lastFullScanAt = Date.now(); scanCostEma = 60; },
    settings: values => { Object.assign(settings, values); rebuildBlockedTokenIndex(); },
  };`;
  await page.addStyleTag({ path:`${root}/styles.css` });
  await page.addScriptTag({ content:fs.readFileSync(`${root}/content.js`,'utf8').replace(/\}\)\(\);\s*$/, `${hooks}\n})();`) });
  await page.waitForFunction(() => window.__direct?.epoch());
  // Wait for asynchronous storage initialization without relying on live APIs.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));

  async function layout(mode, boundary) {
    await page.evaluate(({mode,boundary}) => {
      const {now}=window.__mountNativeFixture({mode,untimed:boundary==='untimed'});
      window.__fixture.now=now;window.__fixture.pending=[];
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
  for (const mode of ['fixed']) for (const boundary of ['head','inline','oldest']) {
    await layout(mode,boundary);
    const events=await eventsFor(`${mode}-${boundary}`,boundary);
    const result=await deliver(events,10);
    assert.equal(new Set(result.keys).size,10);
    reports.push({scenario:`heavy scanner ${mode}/${boundary} burst`,...result});
  }
  // Flow/untimed layouts used to accept ungrounded placement. They now fail
  // closed: eligible events remain known, but no merged DOM may survive.
  for (const [mode,boundary] of [['flow','head'],['fixed','untimed']]) {
    await layout('fixed','head');
    await deliver(await eventsFor('supported-before-reject','head'),10);
    await layout(mode,boundary);
    await page.evaluate(() => {
      window.__fixture.pending=[];window.__direct.poll();
      window.__fixture.pending.shift()({ok:true,events:[{key:'unsupported',eventId:'unsupported',source:'fomo-followed',type:'buy',userId:'alice',ts:Date.now()}]});
    });
    await page.waitForFunction(()=>!document.querySelector('.gdh-merged-tracker,.gdh-fomofeed'));
    assert.equal(await page.locator('[data-sentry-component="TrackerListItem"]').count(),2);
    assert.equal(await page.locator('.gdh-fomofeed-lane').count(),0);
    reports.push({scenario:`unsupported ${mode}/${boundary} clears merged DOM and preserves native rows`,passed:true});
  }
  await page.evaluate(()=>{const {now}=window.__mountNativeFixture({count:12,height:64.5});window.__fixture.now=now;});
  await deliver(await eventsFor('fractional','inline'),10);
  assert.equal(await page.locator('.gdh-merged-tracker').count(),1);
  assert.equal(await page.locator('[data-sentry-component="TrackerListItem"]').first().evaluate(el=>el.parentElement.getBoundingClientRect().height),64.5);
  reports.push({scenario:'fractional 64.5px native rows pass complete-index geometry validation',passed:true});
  await layout('fixed','head');
  for(const [passiveStatus,label] of Object.entries({
    'waiting-for-fomo-tab':'waiting for FOMO tab',
    'waiting-for-account':'sign in on FOMO',
    'waiting-for-following':'waiting for native following list',
    'waiting-for-activity':'open FOMO Alerts',
    'connected':'receiving from FOMO tab',
    'disconnected':'FOMO tab disconnected',
  })) {
    await deliver([],0,{mode:'passive',passiveStatus,coverageGap:false});
    assert.ok((await page.locator('.gdh-fomo-feed-gap').textContent()).includes(label));
    assert.match(await page.locator('.gdh-fomo-feed-gap').getAttribute('title'),/does not poll FOMO/);
    if(passiveStatus==='waiting-for-activity'){
      for(const width of [1280,390]){
        await page.setViewportSize({width,height:850});
        const box=await page.locator('.gdh-fomo-feed-gap').boundingBox();
        assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=850);
        await page.locator('.gdh-fomo-feed-gap').screenshot({path:`test-results/fomo-passive-status-${width}.png`});
      }
      await page.setViewportSize({width:1280,height:850});
    }
  }
  reports.push({scenario:'passive native-tab status states through actual tracker callback',passed:true});
  // Invented values, verified public Alerts field contract (not captured account
  // traffic): ClanWindowSelector-v2-CmH09vyz.js Xf/Jf and chains-v2-jVPHqSWp.js Je.
  // This explicit adapter tests the renderer's normalized-event boundary, NOT
  // background ingestion. Keep mcSource/dataSource aligned with that collector.
  const avatar = 'https://fixture.invalid/avatar.svg';
  await context.route('https://fixture.invalid/*.svg', route => route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#8c6"/></svg>'}));
  for (const mode of ['flow','table']) {
    await layout('fixed','head');
    if (mode==='table') await page.evaluate(()=>{const header=document.createElement('div');header.dataset.testid='follow-tracking-table-header';document.querySelector('#native-fixture').prepend(header);});
    const now=await page.evaluate(()=>window.__fixture.now);
    const rawBase={userId:'synthetic-native-user',userHandle:'native_alice',displayName:'Synthetic Alice',profilePictureLink:avatar,networkId:1,tokenAddress:'0x3333333333333333333333333333333333333333',ticker:'SYNTH',tokenImageUrl:'https://fixture.invalid/token.svg',createdAt:new Date(now+5000).toISOString()};
    const items=[
      {...rawBase,id:`native-buy-${mode}`,type:'swap_buy',usdAmount:9.5,fdv:48000,marketCap:12000},
      {...rawBase,id:`native-sell-${mode}`,type:'swap_sell',usdAmount:-999.5,marketCap:12500},
      {...rawBase,id:`native-thesis-${mode}`,type:'thesis',userHandle:'',displayName:'Synthetic Author',comment:{id:'synthetic-comment',comment:'Synthetic thesis: <b>not HTML</b> & patient conviction.',commentSegments:[]},authorTrade:{usdValue:25.49,percentageUnrealizedPnl:12.5,closedAt:null}},
    ];
    const normalized=items.map(item=>({key:`fomo-followed:event:${item.id}`,eventId:item.id,source:'fomo-followed',dataSource:'trading-activity',type:item.type==='thesis'?'thesis':item.type==='swap_sell'?'sell':'buy',userId:item.userId,handle:item.userHandle,name:item.userHandle||item.displayName,avatar:item.profilePictureLink,symbol:item.ticker,img:item.tokenImageUrl,chain:'eth',addr:item.tokenAddress,ts:Date.parse(item.createdAt),usd:Math.abs(item.usdAmount??item.authorTrade?.usdValue??0),mc:item.fdv??item.marketCap??0,mcSource:item.fdv!=null?'alerts-fdv':item.marketCap!=null?'alerts-market-cap':'alerts-unavailable',comment:item.comment?.comment||''}));
    await deliver(normalized,3);
    const snapshot=await page.evaluate(()=>[...document.querySelectorAll('.gdh-fomofeed.is-followed')].map(card=>({name:card.querySelector('.gdh-fomofeed__name').textContent,avatar:card.querySelector('.gdh-fomofeed__av img')?.getAttribute('src'),symbol:card.querySelector('.gdh-fomofeed__symtext,.gdh-fomofeed__sym').textContent,usd:card.querySelector('.gdh-fomofeed__usd,.gdh-fomofeed__tamt').textContent,mc:card.querySelector('.gdh-fomofeed__mc,.gdh-fomofeed__tmc')?.textContent,title:card.querySelector('.gdh-fomofeed__mc,.gdh-fomofeed__tmc')?.title,thesis:card.querySelector('.gdh-fomofeed__thesis')?.textContent,html:card.querySelector('.gdh-fomofeed__thesis b')!==null})));
    assert.deepEqual(snapshot.map(row=>row.usd),['$10','$1K','$25']);
    assert.deepEqual(snapshot.map(row=>row.name),['native_alice','native_alice','Synthetic Author']);
    for(const row of snapshot) { assert.equal(row.avatar,avatar);assert.equal(row.symbol,'SYNTH'); }
    assert.match(snapshot[0].mc,/\$48\.0K$/);assert.match(snapshot[0].title,/provider fdv/);
    assert.match(snapshot[1].mc,/\$12\.5K$/);assert.match(snapshot[1].title,/provider marketCap/);
    assert.equal(snapshot[2].thesis,items[2].comment.comment);assert.equal(snapshot[2].html,false);
    // Verify actual images load through the offline route, not just src strings.
    await page.waitForFunction(()=>[...document.querySelectorAll('.gdh-fomofeed__av img')].every(img=>img.complete&&img.naturalWidth===24));
    const enriched=normalized.map(e=>({...e,avatar:'https://fixture.invalid/recovered.svg',mcSource:e.mc?'current-token':e.mcSource,comment:e.type==='thesis'?`${e.comment} Updated.`:e.comment}));
    await deliver(enriched,3);
    await page.waitForFunction(()=>document.querySelector('.gdh-fomofeed__av img')?.getAttribute('src')==='https://fixture.invalid/recovered.svg');
    assert.match(await page.locator('.gdh-fomofeed__mc,.gdh-fomofeed__tmc').first().getAttribute('title'),/not the historical/);
    assert.equal(await page.locator('.gdh-fomofeed.is-new').count(),0,'native metadata must not reanimate');
    await page.evaluate(()=>window.__fixture.nativeCards=[...document.querySelectorAll('.gdh-fomofeed.is-followed')]);
    await deliver(enriched,3);
    assert.equal(await page.evaluate(()=>window.__fixture.nativeCards.every((card,i)=>card===[...document.querySelectorAll('.gdh-fomofeed.is-followed')][i])),true);
    // Independently exercise signed input and compact rounding boundaries in both layouts.
    const amounts=[[-9.5,'$10'],[0,'$0'],[0.49,'$0'],[0.5,'$1'],[9.49,'$9'],[999.49,'$999'],[999.5,'$1K'],[1000,'$1K'],[999950,'$1M'],[1000000000,'$1B']];
    for(const [usd,expected] of amounts) {
      const text=await page.evaluate(event=>window.__direct.build(event).querySelector('.gdh-fomofeed__usd,.gdh-fomofeed__tamt')?.textContent,{...normalized[0],usd});
      assert.equal(text,expected,`${mode} native USD ${usd}`);
    }
    await layout('fixed','head');
    const fallback={...normalized[0],dataSource:'user-swaps',canonicalIdentity:'fomo-followed:swap:synthetic-stable',swapId:'synthetic-stable',eventId:'old-provider-id',usd:554};
    await deliver([fallback],1);
    const oldIdentity=await page.evaluate(e=>window.__direct.identity(e),fallback);
    const native={...fallback,dataSource:'trading-activity',eventId:'new-provider-id',providerEventId:'new-provider-id',swapId:'native-other-id',usd:556};
    await deliver([native],1);
    assert.equal(await page.evaluate(e=>window.__direct.identity(e),native),oldIdentity);
    assert.equal(await page.locator('.gdh-fomofeed').count(),1);
    assert.equal(await page.locator('.gdh-fomofeed.is-new').count(),0,'verified cross-source alias must not replay animation');
    assert.equal(await page.locator('.gdh-fomofeed__usd').textContent(),'$556');
    reports.push({scenario:`synthetic native Alerts contract ${mode}: USD/MC provenance/identity/avatar/thesis/stable metadata`,passed:true});
  }
  assert.equal(await page.evaluate(()=>window.__fixture.debug.length),0,'render diagnostics off by default');
  await page.evaluate(()=>window.__direct.settings({debugLogging:true}));
  await deliver(await eventsFor('debug-render','head'),10);
  await page.waitForFunction(()=>window.__fixture.debug.some(e=>e.placed===10));
  const renderLog=await page.evaluate(()=>window.__fixture.debug.find(e=>e.placed===10));
  assert.equal(renderLog.received,10);assert.equal(renderLog.eligible,10);assert.equal(renderLog.source,'gmgn');
  assert.ok(!JSON.stringify(renderLog).includes('alice'));
  await page.evaluate(()=>window.__direct.settings({debugLogging:false}));
  reports.push({scenario:'opt-in diagnostics report actual connected DOM counts without identities',passed:true});
  await layout('fixed','head');
  const sparse = {...(await eventsFor('metadata','head'))[0], name:'Followed user',handle:'',symbol:'',userId:'synthetic-user-123456789'};
  await deliver([sparse],1);
  await page.waitForFunction(()=>document.querySelector('.gdh-fomofeed__sym')?.textContent === '0x3333…3333');
  assert.match(await page.locator('.gdh-fomofeed__name').innerText(), /FOMO user/);
  await page.evaluate(()=>window.__fixture.originalCard=document.querySelector('.gdh-fomofeed.is-followed'));
  await deliver([{...sparse,name:'Recovered Alice',handle:'alice',symbol:'RECOVERED',mc:48000}],1);
  await page.waitForFunction(()=>document.querySelector('.gdh-fomofeed__sym')?.textContent === 'RECOVERED');
  assert.equal(await page.locator('.gdh-fomofeed__name').innerText(),'Recovered Alice');
  assert.match(await page.locator('.gdh-fomofeed__mc').innerText(), /48/);
  assert.equal(await page.locator('.gdh-fomofeed.is-new').count(),0,'metadata recovery must not replay new-event animation');
  await page.evaluate(()=>window.__fixture.enrichedCard=document.querySelector('.gdh-fomofeed.is-followed'));
  await deliver([{...sparse,name:'Recovered Alice',handle:'alice',symbol:'RECOVERED',mc:48000}],1);
  assert.equal(await page.evaluate(()=>window.__fixture.enrichedCard===document.querySelector('.gdh-fomofeed.is-followed')),true,'unchanged snapshots reuse DOM');
  reports.push({scenario:'sparse identities visible; same-event enrichment updates card without duplicate or replay',passed:true});
  for(const mode of ['fixed','table']) {
    await layout('fixed','head');
    if(mode==='table') await page.evaluate(()=>{const header=document.createElement('div');header.dataset.testid='follow-tracking-table-header';document.querySelector('#native-fixture').prepend(header);});
    const initial={...sparse,swapId:`metadata-${mode}`,eventId:`metadata-${mode}`};
    await deliver([initial],1);
    const selector=mode==='table'?'.gdh-fomofeed__symtext':'.gdh-fomofeed__sym';
    await page.waitForFunction(selector=>document.querySelector(selector)?.textContent==='0x3333…3333',selector);
    await deliver([{...initial,name:'Recovered Alice',handle:'alice',symbol:'RECOVERED'}],1);
    await page.waitForFunction(selector=>document.querySelector(selector)?.textContent==='RECOVERED',selector);
    assert.equal(await page.locator('.gdh-fomofeed__name').innerText(),'Recovered Alice');
    assert.equal(await page.locator('.gdh-fomofeed.is-new').count(),0);
    if(mode==='fixed') {
      const overlaps=await page.evaluate(()=>{const a=document.querySelector('.gdh-fomofeed').getBoundingClientRect();const b=document.querySelector('[data-sentry-component="TrackerListItem"]').getBoundingClientRect();return a.bottom>b.top+1;});
      assert.equal(overlaps,false,'metadata replacement preserves native row offsets');
    }
    reports.push({scenario:`managed ${mode} metadata enrichment preserves identity and placement`,passed:true});
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
  await page.evaluate(()=>{
    const card=document.querySelector('[data-sentry-component="TrackerListItem"]');
    Object.assign(card.__reactFiber$fixture.memoizedProps.record,{transaction_hash:'real-native-hash',token_address:'0x3333333333333333333333333333333333333333',chain:'eth',side:'buy'});
    window.__scanNativeFixture();
  });
  reports.push({scenario:'exact native transaction dedup preserves thesis and other swaps',...await deliver(nativeEvents,2)});
  const legs = [
    {...same[0],swapId:'leg-token',tx:'real-native-hash',addr:'0x4444444444444444444444444444444444444444'},
    {...same[0],swapId:'leg-side',tx:'real-native-hash',type:'sell'},
    {...same[0],swapId:'leg-chain',tx:'real-native-hash',chain:'base'},
  ];
  reports.push({scenario:'same transaction distinct token side and chain legs survive',...await deliver(legs,3)});
  await page.evaluate(()=>{
    delete document.querySelector('[data-sentry-component="TrackerListItem"]').__reactFiber$fixture.memoizedProps.record.chain;
    window.__scanNativeFixture();
  });
  reports.push({scenario:'missing native metadata cannot prove a duplicate',...await deliver(nativeEvents,3)});
  // A complete native index contains trades outside the mounted pool. Scroll
  // recycling must not toggle duplicate suppression or remove the other cards.
  await page.evaluate(()=>{
    const {records}=window.__mountNativeFixture({count:80,height:64.5});
    Object.assign(records[60],{transaction_hash:'offscreen-native-hash',token_address:'0x3333333333333333333333333333333333333333'});
    const cards=[...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')];
    cards.slice(12).forEach(c=>c.parentElement.remove());
    window.__scanNativeFixture();
    window.dedupRecords=records;
  });
  const offscreen=[{...nativeEvents[0],tx:'offscreen-native-hash'},nativeEvents[1]];
  await deliver(offscreen,1);
  await page.evaluate(()=>{window.dedupSurface=document.querySelector('.gdh-merged-tracker');window.dedupCard=document.querySelector('.gdh-fomofeed');});
  for (const start of [56,0,56,0]) {
    await page.evaluate(start=>{
      [...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')].forEach((c,i)=>{
        c.__reactFiber$fixture.memoizedProps.record=window.dedupRecords[start+i];
        c.parentElement.style.top=`${(start+i)*64.5}px`;
      });
      window.__scanNativeFixture();
    },start);
    await page.waitForTimeout(160);
    assert.equal(await page.locator('.gdh-fomofeed').count(),1,'dedup is independent of mounted pool');
    assert.equal(await page.evaluate(()=>document.querySelector('.gdh-fomofeed')===window.dedupCard),true);
    assert.equal(await page.evaluate(()=>document.querySelector('.gdh-merged-tracker')===window.dedupSurface),true);
  }
  reports.push({scenario:'complete native identities suppress off-screen duplicates through pool recycling without card churn',passed:true});
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
  // Render real card/table output in a separate screenshot fixture, outside the managed feed.
  fs.mkdirSync(`${root}/test-results`,{recursive:true});
  for (const width of [1280,570,390]) {
    await page.setViewportSize({width,height:650});
    const geometry=await page.evaluate(({sparse,width})=>{
      document.querySelector('#metadata-preview')?.remove();
      document.querySelector('#native-fixture')?.remove();
      document.body.style.cssText='margin:0;background:#111416;color:#eee;font:14px Arial';
      const host=document.createElement('div');host.id='metadata-preview';host.style.cssText='max-width:570px;width:100%;margin:auto';
      const heading=document.createElement('h3');heading.textContent='Synthetic metadata recovery — actual tracker renderer';heading.style.padding='12px';host.append(heading);
      const events=[sparse,{...sparse,key:'enriched-preview',name:'Recovered Alice',handle:'alice',symbol:'RECOVERED',mc:48000}];
      for(const event of events) host.append(window.__direct.build(event).cloneNode(true));
      const table=document.createElement('div');table.className='gdh-fomofeed is-table';window.__direct.table(sparse,table,{label:'Buy'});host.append(table);
      document.body.append(host);
      const token=table.querySelector('.gdh-fomofeed__symtext').textContent;
      return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,token,bounds:[...host.querySelectorAll('.gdh-fomofeed__name,.gdh-fomofeed__sym')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right};})};
    },{sparse,width});
    assert.equal(geometry.width,width);assert.ok(geometry.scrollWidth<=width,JSON.stringify(geometry));
    assert.equal(geometry.token,'0x3333…3333');
    for(const bounds of geometry.bounds) assert.ok(bounds.left>=0 && bounds.right<=width,JSON.stringify(bounds));
    await page.locator('#metadata-preview').screenshot({path:`${root}/test-results/fomo-metadata-${width}.png`});
  }
  reports.push({scenario:'real sparse/enriched card and table rendering at 1280/570/390px',passed:true});
  assert.deepEqual(errors,[]);
  const latencies=reports.flatMap(r=>r.latencies||[]).sort((a,b)=>a-b);
  const result={synthetic:true,externalNetwork:'blocked',scenarios:reports.length,domInsertionMs:{n:latencies.length,p50:latencies[Math.floor(latencies.length*.5)],p95:latencies[Math.floor(latencies.length*.95)],max:latencies.at(-1)},reports};
  fs.mkdirSync(`${root}/test-results`,{recursive:true});
  fs.writeFileSync(`${root}/test-results/fomo-followed-browser-results.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,reports:reports.map(({keys,eligibleKeys,latencies,...rest})=>rest)},null,2));
} finally { await context.close(); await browser.close(); }
