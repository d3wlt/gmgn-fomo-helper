// Offline production content/CSS; synthetic worker snapshots, no provider traffic.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const browser = await chromium.launch({headless:true});
try {
  const context = await browser.newContext({viewport:{width:570,height:600}});
  const requests = [], errors = [];
  await context.route('**/*', route => {
    requests.push(route.request().url());
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#101114;color:#ddd;font:13px Arial}button{background:#232730;color:inherit;border:1px solid #444;padding:6px}#native{height:470px;display:flex;flex-direction:column}header{padding:8px}#body{flex:1}</style><p>Synthetic offline FOMO Trending</p><div id="native" data-sentry-component="Main"><header><div><button data-testid="filter-tag-trending">Trending</button></div></header><div id="body">Native fixture</div></div>'});
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
  await page.addScriptTag({content:read('content.js').replace(/\}\)\(\);\s*$/, 'window.countTest={reset:resetDiscoveryAccount,render:renderDiscoveryTrending,set:data=>{discoveryTrendingData=data;renderDiscoveryTrending();}};})();')});
  const activate = async () => {
    await page.locator('.gdh-discovery-trending-tab').click();
    await page.mouse.move(210,580);
    await page.evaluate(() => document.activeElement?.blur());
  };
  await activate();
  const networks = {robinhood:4663,sol:1399811149,bsc:56,arc:5042,eth:1,base:8453,monad:143};
  const row = (chain, i=1) => ({chain,address:chain==='sol'?'1'.repeat(31)+String(i+1):'0x'+i.toString(16).padStart(40,'0'),networkId:networks[chain],source:'fomo-trending',symbol:chain.toUpperCase()+i,rank:i,price:1,marketCap:100000,change24Percent:12});
  const snapshot = (items, extra={}) => ({ok:true,status:'live',source:'fomo-trending',provenance:'owned-stream',streamEpoch:1,membershipRevision:1,fetchedAt:Date.now(),items,...extra});
  const send = data => page.evaluate(data => ports.at(-1).listener({type:'fomo-trending-live-update',data}), data);
  const count = page.locator('.gdh-discovery-chain-counts');
  const rows = page.locator('.gdh-discovery-trending-row');
  const verify = async (text, total) => {
    await page.waitForFunction(({text,total}) => (document.querySelector('.gdh-discovery-chain-counts')?.textContent || '')===text && document.querySelectorAll('.gdh-discovery-trending-row').length===total, {text,total});
    assert.equal(await count.count(), text ? 1 : 0);
  };
  // Same EVM address across six chains is six rendered identities, not one.
  const valid = Object.keys(networks).flatMap(chain => Array.from({length:chain==='robinhood'?3:chain==='sol'||chain==='bsc'?2:1}, (_,i)=>row(chain,i+1)));
  const invalid = [null,42,{},row('unknown'),{...row('bsc'),chain:'BSC'}, {...row('bsc'),chain:'bnb'}, {...row('bsc'),address:' '+row('bsc').address}, {...row('bsc'),address:'0x123'}, {...row('sol'),address:'0'.repeat(32)}, {...row('eth'),networkId:56}, {...row('bsc'),networkId:'56'}, {...row('arc'),source:'other'}];
  const expected = 'RH: 3 | BSC: 2 | SOL: 2 | ARC: 1 | BASE: 1 | ETH: 1 | MONAD: 1';
  await send(snapshot([...invalid,...valid]));
  await verify(expected,11);
  assert.equal(await rows.locator('[href]').count(),0);
  assert.equal(new Set(await rows.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))).size,11);
  assert.equal(await page.locator('.gdh-discovery-bar [role=status]').textContent(),'Live · updating automatically');
  for (const width of [220,570]) {
    await page.setViewportSize({width,height:600});
    const geometry = await count.evaluate(node => {
      const status=node.previousElementSibling, style=getComputedStyle(node), rect=node.getBoundingClientRect();
      return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,panelWidth:node.closest('.gdh-discovery-trending').getBoundingClientRect().width,left:rect.left,right:rect.right,top:rect.top,statusBottom:status.getBoundingClientRect().bottom,height:rect.height,lineHeight:parseFloat(style.lineHeight),scroll:node.scrollWidth,client:node.clientWidth,whiteSpace:style.whiteSpace,overflow:style.overflow,textOverflow:style.textOverflow,text:node.innerText};
    });
    assert.equal(geometry.viewport,width); assert.equal(geometry.panelWidth,width);
    assert.ok(geometry.documentWidth<=width); assert.ok(geometry.left>=0 && geometry.right<=width);
    assert.ok(geometry.top>=geometry.statusBottom-1,'counts directly below status');
    assert.ok(geometry.scroll<=geometry.client,'no clipped horizontal text');
    assert.equal(geometry.whiteSpace,'normal'); assert.equal(geometry.overflow,'visible'); assert.notEqual(geometry.textOverflow,'ellipsis');
    assert.equal(geometry.text,expected);
    assert.ok(width===220 ? geometry.height>geometry.lineHeight : geometry.height===geometry.lineHeight);
    fs.mkdirSync(new URL('test-results/',root),{recursive:true});
    await page.screenshot({path:new URL(`test-results/trending-chain-counts-${width}.png`,root).pathname});
  }
  // Hover/focus/scroll pending snapshots must not leak into displayed counts.
  for (const hold of ['hover','focus','scroll']) {
    await send(snapshot(valid)); await verify(expected,11);
    if (hold==='hover') await rows.first().hover();
    if (hold==='focus') await rows.first().focus();
    if (hold==='scroll') await page.evaluate(()=>document.querySelector('.gdh-discovery-trending').dispatchEvent(new Event('scroll')));
    await page.evaluate(()=>window.heldRows=[...document.querySelectorAll('.gdh-discovery-trending-row')]);
    await send(snapshot([row('arc')]));
    assert.equal(await count.textContent(),expected);
    assert.equal(await page.evaluate(()=>heldRows.every((node,i)=>node===document.querySelectorAll('.gdh-discovery-trending-row')[i])),true);
    await page.mouse.move(560,580); await page.evaluate(()=>document.activeElement?.blur());
    await verify('ARC: 1',1);
  }
  await send(snapshot(valid,{ok:false,status:'reconnecting',stale:true})); await verify(expected,11);
  await send(snapshot(valid,{ok:false,status:'reconnecting',stale:true,fetchedAt:Date.now()-300001})); await verify('',0);
  await send(snapshot(valid,{ok:false,status:'not-connected',reason:'not-connected'})); await verify('',0);
  await send(snapshot(valid)); await verify(expected,11);
  await send(snapshot([])); await verify('',0);
  await send(snapshot(invalid)); await verify('',0);
  await send(snapshot([],{ok:false,status:'unavailable'})); await verify('',0);
  // Passive renderer also counts its actual display cap, not all input rows.
  await page.evaluate(data=>countTest.set(data), snapshot(Array.from({length:205},(_,i)=>row('eth',i+1)),{provenance:'native-stream'}));
  await verify('ETH: 200',200);
  await send(snapshot(valid)); await verify(expected,11);
  const trafficBefore = await page.evaluate(()=>messages.length);
  await page.evaluate(()=>countTest.render());
  assert.equal(await page.evaluate(()=>messages.length),trafficBefore,'render does not request more data');
  await page.evaluate(()=>countTest.reset()); await verify('',0);
  assert.equal(requests.length,1,'no provider traffic'); assert.deepEqual(errors,[]);
  console.log('PASS Trending chain counts: exact validation, all 7 labels, descending/alphabetical ties, cross-chain same address, malformed exclusion, hover/focus/scroll held snapshots, stale retention/expiry, empty/unavailable/account clear, passive 200-row cap, no added requests, full production CSS at 220/570px (screenshots in test-results).');
} finally { await browser.close(); }
