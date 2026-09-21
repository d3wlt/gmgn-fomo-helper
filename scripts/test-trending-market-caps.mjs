// SYNTHETIC OFFLINE fixture: full production content/CSS, no live provider.
// Run: node scripts/test-trending-market-caps.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const browser = await chromium.launch({headless:true});
try {
  const context = await browser.newContext({viewport:{width:570,height:1400}});
  const requests = [], errors = [], screenshots = [];
  await context.route('**/*', route => {
    requests.push(route.request().url());
    if (requests.length !== 1) return route.abort();
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Synthetic offline Trending regression</title><style>*{box-sizing:border-box}body{margin:0;background:#101114;color:#ddd;font:13px Arial}button{background:#232730;color:inherit;border:1px solid #444;padding:6px}#native{height:1270px;display:flex;flex-direction:column}header{padding:8px}#body{flex:1}</style><p>SYNTHETIC · OFFLINE<br>FOMO Trending preview — not live data</p><div id="native" data-sentry-component="Main"><header><div><button data-testid="filter-tag-trending">Trending</button></div></header><div id="body">Native fixture</div></div>'});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://gmgn.ai/');
  await page.evaluate(() => {
    window.ports = []; window.messages = [];
    const saved = {enabled:true,enableFomoPanel:true,enableFomoFeed:false,enableMarkedHolders:false,enableHoldingSurge:false,fomoPanelOpen:false,markedListMigratedV2:true};
    window.chrome = {
      runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),getURL:p=>p,onMessage:{addListener(){}},
        sendMessage(m,cb){messages.push(m);const reply={ok:false,items:[],events:[]};cb?.(reply);return Promise.resolve(reply);},
        connect(){const p={onMessage:{addListener:f=>p.listener=f},onDisconnect:{addListener:f=>p.ended=f},postMessage:m=>messages.push(m),disconnect(){p.closed=true;}};ports.push(p);return p;}},
      storage:{local:{get(k,cb){const value={...(typeof k==='object'?k:{}),...saved};cb?.(value);return Promise.resolve(value);},set(v,cb){cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}
    };
  });
  await page.addStyleTag({content:read('styles.css')});
  const source = read('content.js');
  assert.match(source,/\}\)\(\);\s*$/,'test seam must match production IIFE');
  await page.addScriptTag({content:source.replace(/\}\)\(\);\s*$/, 'window.capTest={reset:resetDiscoveryAccount,render:renderDiscoveryTrending,color:fomoFeedChainColor,stats:discoveryMarketCapStats,set:data=>{discoveryTrendingData=data;renderDiscoveryTrending();}};})();')});
  await page.locator('.gdh-discovery-trending-tab').click();
  const release = async () => {
    await page.mouse.move(1,1390);
    await page.evaluate(() => document.activeElement?.blur());
  };
  await release();
  const networks = {robinhood:4663,sol:1399811149,bsc:56,arc:5042,eth:1,base:8453,monad:143};
  const row = (chain, i=1, marketCap=100000) => ({chain,address:chain==='sol'?'1'.repeat(31)+String(i+1):'0x'+i.toString(16).padStart(40,'0'),networkId:networks[chain],source:'fomo-trending',symbol:chain.toUpperCase()+i,rank:i,price:0.01234,marketCap,change24Percent:12});
  let revision = 0;
  const snapshot = (items, extra={}) => ({ok:true,status:'live',source:'fomo-trending',provenance:'owned-stream',streamEpoch:1,membershipRevision:++revision,fetchedAt:Date.now(),items,...extra});
  const send = data => page.evaluate(data => ports.at(-1).listener({type:'fomo-trending-live-update',data}), data);
  const stats = page.locator('.gdh-discovery-cap-stats');
  const rows = page.locator('.gdh-discovery-trending-row');
  const toggle = page.locator('.gdh-discovery-cap-header button');
  const details = page.locator('.gdh-discovery-cap-details');
  const valid = [row('robinhood',1,0),row('bsc',1,99999),row('sol',1,100000),row('sol',2,999999),row('arc',1,1000000),row('base',1,9999999),row('eth',1,10000000),row('monad',1,99999999),row('robinhood',2,100000000),row('bsc',2,null),row('eth',2,-1),row('monad',2,'100000')];
  const invalid = [null,42,{},row('unknown'),{...row('bsc'),chain:'BSC'},{...row('bsc'),chain:'bnb'},{...row('bsc'),address:' '+row('bsc').address},{...row('bsc'),address:'0x123'},{...row('sol'),address:'0'.repeat(32)},{...row('eth'),networkId:56},{...row('bsc'),networkId:'56'},{...row('arc'),source:'other'}];
  const labels = ['< $100K','$100K–$1M','$1M–$10M','$10M–$100M','$100M+','Unknown'];
  const expectedCounts = [2,2,2,2,1,3];
  const waitCount = async total => {
    await page.waitForFunction(total => document.querySelectorAll('.gdh-discovery-trending-row').length===total,total);
    assert.equal(await stats.count(),total ? 1 : 0);
  };
  const readStats = () => stats.evaluate(node => ({caption:node.querySelector('small').textContent,buckets:[...node.querySelectorAll('.gdh-discovery-cap-row')].map(r=>({label:r.dataset.bucket,count:Number(r.dataset.count),share:r.querySelector('.gdh-discovery-cap-share').textContent,denominator:r.querySelector('.gdh-discovery-cap-share').title,leader:r.querySelector('.gdh-discovery-cap-leader').textContent,segments:[...r.querySelectorAll('.gdh-discovery-cap-track span')].map(s=>({title:s.title,width:parseFloat(s.style.width)}))})),details:[...node.querySelectorAll('.gdh-discovery-cap-breakdown')].map(r=>r.textContent)}));
  await send(snapshot([...invalid,...valid])); await waitCount(12);
  const baseline = await readStats();
  assert.equal(baseline.caption,'12 coins in current list · USD market caps');
  assert.deepEqual(baseline.buckets.map(b=>b.label),labels);
  assert.deepEqual(baseline.buckets.map(b=>b.count),expectedCounts);
  assert.deepEqual(baseline.buckets.map(b=>b.share),['16.7%','16.7%','16.7%','16.7%','8.3%','25%']);
  assert.deepEqual(baseline.buckets.map(b=>b.denominator),expectedCounts.map(n=>`${n} of 12 displayed coins`));
  assert.deepEqual(baseline.buckets.map(b=>b.leader),['Tie: BSC / RH · 1 each','SOL · 2','Tie: ARC / BASE · 1 each','Tie: ETH / MONAD · 1 each','RH · 1','Tie: BSC / ETH / MONAD · 1 each']);
  assert.deepEqual(baseline.buckets.map(b=>b.segments.map(s=>s.title)),[['BSC: 1','RH: 1'],['SOL: 2'],['ARC: 1','BASE: 1'],['ETH: 1','MONAD: 1'],['RH: 1'],['BSC: 1','ETH: 1','MONAD: 1']]);
  for (const b of baseline.buckets) assert.ok(Math.abs(b.segments.reduce((n,s)=>n+s.width,0)-b.count/12*100)<0.001,'bar uses displayed denominator');
  assert.deepEqual(baseline.details,[
    '< $100K · 2 coinsBSC: 1 (50%)RH: 1 (50%)', '$100K–$1M · 2 coinsSOL: 2 (100%)',
    '$1M–$10M · 2 coinsARC: 1 (50%)BASE: 1 (50%)', '$10M–$100M · 2 coinsETH: 1 (50%)MONAD: 1 (50%)',
    '$100M+ · 1 coinRH: 1 (100%)',
    'Unknown · 3 coinsBSC: 1 (33.3%)ETH: 1 (33.3%)MONAD: 1 (33.3%)']);
  assert.deepEqual(await rows.locator('.gdh-discovery-mc').evaluateAll(ns=>ns.map(n=>n.dataset.known)),Array(9).fill('true').concat(Array(3).fill('false')));
  // Non-finite/undefined inputs cannot be represented faithfully by JSON snapshots.
  assert.deepEqual(await page.evaluate(()=>capTest.stats([null,-1,'100000',undefined,NaN,Infinity,-Infinity].map(marketCap=>({chain:'eth',marketCap}))).map(b=>b.count)),[0,0,0,0,0,7]);
  const checkColors = async () => {
    const actual = await rows.evaluateAll(nodes => nodes.map(n=>{
      const chain=n.getAttribute('href').split('/')[1], expected=capTest.color(chain), probe=document.createElement('span');
      probe.style.color=expected; document.body.append(probe); const normalized=getComputedStyle(probe).color; probe.remove();
      const stripe=getComputedStyle(n.querySelector('.gdh-discovery-chain-stripe'));
      return {chain,expected,inline:n.style.getPropertyValue('--gdh-chain-color'),color:stripe.backgroundColor,normalized,width:stripe.width,height:n.getBoundingClientRect().height,position:stripe.position,pointer:stripe.pointerEvents,label:n.querySelector('.gdh-discovery-token small').textContent};
    }));
    for (const r of actual) {
      assert.equal(r.inline,r.expected); assert.equal(r.color,r.normalized); assert.equal(r.width,'3px'); assert.equal(r.height,40);
      assert.equal(r.position,'absolute'); assert.equal(r.pointer,'none'); assert.equal(r.label,r.chain==='robinhood'?'RH':r.chain.toUpperCase());
    }
    assert.equal(new Set(actual.map(r=>r.chain)).size,7);
    assert.equal(await stats.evaluate(node => [...node.querySelectorAll('.gdh-discovery-cap-track span,.gdh-discovery-cap-breakdown span')].every(n=>{
      const label=(n.title||n.textContent).split(':')[0], chain=label==='RH'?'robinhood':label.toLowerCase();
      const probe=document.createElement('span'); probe.style.color=capTest.color(chain); document.body.append(probe);
      const color=getComputedStyle(probe).color; probe.remove();
      return (n.parentElement.classList.contains('gdh-discovery-cap-track')?getComputedStyle(n).backgroundColor:getComputedStyle(n).borderLeftColor)===color;
    })),true,'stats colors match tracker resolver');
    return actual;
  };
  await checkColors();
  // Price/MC updates must retain inspectable containers, rows and metric nodes.
  await page.evaluate(() => { window.stableNodes = [...document.querySelector('.gdh-discovery-trending').querySelectorAll('*')]; });
  await send(snapshot(valid.map(item => ({...item, price:0.02345}))));
  await page.waitForFunction(() => document.querySelector('.gdh-discovery-price').textContent === '$0.02345');
  assert.equal(await page.evaluate(() => stableNodes.every(node => node.isConnected)), true, 'metric update must not replace panel descendants');
  await page.evaluate(() => { window.churn=0; window.churnObserver=new MutationObserver(records => {churn+=records.length;}); churnObserver.observe(document.querySelector('.gdh-discovery-trending'), {subtree:true,childList:true,attributes:true,characterData:true}); });
  await send(snapshot(valid.map(item => ({...item, price:0.02345}))));
  await page.evaluate(() => new Promise(resolve=>setTimeout(resolve,50)));
  assert.equal(await page.evaluate(() => {churnObserver.disconnect(); return churn;}),0,'unchanged display snapshot causes no DOM mutations');
  await send(snapshot(valid));
  await page.waitForFunction(() => document.querySelector('.gdh-discovery-price').textContent === '$0.01234');
  // Reordering must move the same chain/address nodes, not replace them.
  await page.evaluate(() => { window.keyedRows=new Map([...document.querySelectorAll('.gdh-discovery-trending-row')].map(n=>[n.getAttribute('href'),n])); });
  await send(snapshot([...valid].reverse()));
  await page.waitForFunction(() => document.querySelector('.gdh-discovery-token strong').textContent === 'MONAD2');
  assert.equal(await rows.evaluateAll(nodes=>nodes.every(n=>keyedRows.get(n.getAttribute('href'))===n)),true,'rank reordering retains token nodes');
  await send(snapshot(valid));
  await page.waitForFunction(() => document.querySelector('.gdh-discovery-token strong').textContent === 'ROBINHOOD1');
  // A host pseudo-element reset must not hide permanent chain stripes.
  await page.addStyleTag({content:'a::before { content: none !important; display: none !important; }'});
  assert.equal(await rows.evaluateAll(nodes=>nodes.every(n=>{const s=n.querySelector('.gdh-discovery-chain-stripe'),r=s.getBoundingClientRect(),p=n.getBoundingClientRect();return r.width===3&&Math.abs(r.height-p.height)<1&&Math.abs(r.left-p.left)<1&&Math.abs(r.top-p.top)<1;})),true,'actual stripe rectangles fill each row left edge under host reset');
  await page.evaluate(()=>localStorage.setItem('follow_toast_chain_color_v1',JSON.stringify({robinhood:{color:'#123abc'},sol:{color:'rgb(11, 222, 33)'}})));
  await send(snapshot(valid)); await waitCount(12);
  await page.waitForFunction(()=>document.querySelector('.gdh-discovery-trending-row').style.getPropertyValue('--gdh-chain-color')==='#123abc');
  const custom = await checkColors();
  assert.equal(custom.find(r=>r.chain==='robinhood').color,'rgb(18, 58, 188)');
  assert.equal(custom.find(r=>r.chain==='sol').color,'rgb(11, 222, 33)');
  await page.evaluate(()=>localStorage.removeItem('follow_toast_chain_color_v1'));
  await send(snapshot(valid));
  await page.waitForFunction(()=>document.querySelector('.gdh-discovery-trending-row').style.getPropertyValue('--gdh-chain-color')!=='#123abc');
  const expanded = async value => {
    assert.equal(await toggle.getAttribute('aria-expanded'),String(value));
    assert.equal(await details.isVisible(),value);
    assert.equal(await toggle.textContent(),value?'Hide details':'View details');
    assert.equal(await toggle.getAttribute('aria-controls'),await details.getAttribute('id'));
  };
  await expanded(false); await toggle.click(); await expanded(true); await toggle.click(); await expanded(false);
  await toggle.focus(); await page.keyboard.press('Enter'); await expanded(true);
  await page.keyboard.press('Space'); await expanded(false);
  await page.keyboard.press('Enter'); await expanded(true); await release();
  await send(snapshot([...valid,row('arc',2,1000000)])); await waitCount(13); await expanded(true);
  await send(snapshot(valid)); await waitCount(12); await expanded(true);
  await toggle.click(); await expanded(false); await release();
  await send(snapshot([...valid,row('arc',2,1000000)])); await waitCount(13); await expanded(false);
  await send(snapshot(valid)); await waitCount(12);
  // Summary, details, stripes and exact row nodes stay tied to the held snapshot.
  for (const hold of ['hover','focus','scroll']) {
    await release(); await send(snapshot(valid)); await waitCount(12);
    if (hold==='hover') await rows.first().hover();
    if (hold==='focus') await rows.first().focus();
    if (hold==='scroll') await page.evaluate(()=>document.querySelector('.gdh-discovery-trending').dispatchEvent(new Event('scroll')));
    await page.evaluate(()=>window.heldRows=[...document.querySelectorAll('.gdh-discovery-trending-row')]);
    const before=await readStats();
    await send(snapshot([row('arc',2,10000000)]));
    assert.deepEqual(await readStats(),before,`${hold} summary/details retained`);
    assert.equal(await page.evaluate(()=>heldRows.every((n,i)=>n===document.querySelectorAll('.gdh-discovery-trending-row')[i])),true);
    await release(); await waitCount(1);
    assert.equal((await readStats()).caption,'1 coin in current list · USD market caps');
    assert.deepEqual((await readStats()).buckets.map(b=>b.count),[0,0,0,1,0]);
  }
  await send(snapshot(valid,{ok:false,status:'reconnecting',stale:true})); await waitCount(12);
  assert.deepEqual(await readStats(),baseline);
  for (const data of [snapshot(valid,{ok:false,status:'reconnecting',stale:true,fetchedAt:Date.now()-300001}),snapshot(valid,{ok:false,status:'not-connected',reason:'not-connected'}),snapshot([]),snapshot(invalid),snapshot([],{ok:false,status:'unavailable'})]) {
    await send(data); await waitCount(0);
  }
  // Exact denominator is the validated, capped displayed subset, not raw input.
  await page.evaluate(data=>capTest.set(data),snapshot(Array.from({length:205},(_,i)=>row('eth',i+1,i<200?100000:10000000)),{provenance:'native-stream'}));
  await waitCount(200);
  assert.equal((await readStats()).caption,'200 coins in current list · USD market caps');
  assert.deepEqual((await readStats()).buckets.map(b=>b.count),[0,200,0,0,0]);
  await page.evaluate(data=>capTest.set(data),snapshot([...invalid,...Array.from({length:205},(_,i)=>row('eth',i+1))],{provenance:'native-stream'}));
  await waitCount(188);
  assert.equal((await readStats()).caption,'188 coins in current list · USD market caps');
  await send(snapshot(valid)); await waitCount(12);
  const trafficBefore = await page.evaluate(()=>messages.length);
  await page.evaluate(()=>capTest.render());
  await toggle.click(); await toggle.click();
  assert.equal(await page.evaluate(()=>messages.length),trafficBefore,'render/details do not request data');
  await release(); await page.evaluate(()=>capTest.reset()); await waitCount(0);
  // Account reset deactivates the panel and invalidates its old live port.
  await page.locator('.gdh-discovery-trending-tab').click(); await release();
  await send(snapshot(valid)); await waitCount(12);
  // Screenshots retain the fixture disclosure and show full statistics plus rows.
  fs.mkdirSync(new URL('test-results/',root),{recursive:true});
  for (const width of [220,320,390,570,900]) {
    await page.setViewportSize({width,height:1400});
    for (const open of [false,true]) {
      if ((await toggle.getAttribute('aria-expanded'))!==String(open)) await toggle.click();
      await expanded(open);
      await release();
      await page.evaluate(()=>document.querySelector('.gdh-discovery-trending').scrollTop=0);
      const geometry = await page.evaluate(()=>{
        const panel=document.querySelector('.gdh-discovery-trending');
        const elements=[panel,...panel.querySelectorAll('.gdh-discovery-cap-stats,.gdh-discovery-cap-row,.gdh-discovery-cap-details,.gdh-discovery-cap-breakdown,.gdh-discovery-cap-header,.gdh-discovery-cap-leader,.gdh-discovery-chain-counts')].filter(n=>n.getClientRects().length);
        return {documentWidth:document.documentElement.scrollWidth,width:innerWidth,panelWidth:panel.getBoundingClientRect().width,overflows:elements.filter(n=>n.scrollWidth>n.clientWidth+1||n.getBoundingClientRect().left<0||n.getBoundingClientRect().right>innerWidth+1).map(n=>n.className),heights:[...document.querySelectorAll('.gdh-discovery-trending-row')].map(n=>n.getBoundingClientRect().height),detailsBottom:document.querySelector('.gdh-discovery-cap-details').getBoundingClientRect().bottom,viewportHeight:innerHeight};
      });
      assert.equal(geometry.width,width); assert.equal(geometry.panelWidth,width); assert.ok(geometry.documentWidth<=width);
      assert.deepEqual(geometry.overflows,[],`${width}px ${open?'expanded':'collapsed'} horizontal overflow`);
      assert.ok(geometry.heights.every(h=>h===40),'stripe does not alter 40px row geometry');
      if (open) assert.ok(geometry.detailsBottom<geometry.viewportHeight,'expanded details visible in preview');
      await checkColors();
      const path=new URL(`test-results/trending-market-caps-${width}-${open?'expanded':'collapsed'}.png`,root).pathname;
      await page.screenshot({path,fullPage:true}); screenshots.push(path);
    }
  }
  assert.equal(requests.length,1,'only routed fixture navigation; zero provider/network requests');
  assert.deepEqual(errors,[],'no browser errors');
  console.log(JSON.stringify({result:'PASS',fixture:'SYNTHETIC OFFLINE, full production content.js/styles.css',coverage:['boundary buckets and unknowns','displayed denominator, ties and breakdown shares','invalid exclusion and 200-input cap','held hover/focus/scroll consistency','click/Enter/Space and rerender persistence','stale/empty/unavailable/account clear','tracker stripe colors and custom overrides','40px geometry, no horizontal overflow at all five widths','zero provider traffic and browser errors'],screenshots},null,2));
} finally { await browser.close(); }
