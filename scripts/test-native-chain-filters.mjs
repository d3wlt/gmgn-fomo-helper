// Offline production MAIN bridge + full content/CSS; synthetic committed native pickers.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url),read=f=>fs.readFileSync(new URL(f,root),'utf8');
const A='0x1111111111111111111111111111111111111111';
const html=`<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{background:#101114;color:#ddd;font:13px Arial;margin:12px}button{background:#232730;color:inherit;border:1px solid #444;padding:6px;cursor:pointer}#native{max-width:570px;height:370px;display:flex;flex-direction:column}header{display:flex;justify-content:space-between;gap:4px;padding:8px}#body{flex:1;overflow:auto}#pickers{display:flex;flex-wrap:wrap;gap:8px}fieldset{max-width:100%;margin:0;padding:8px;border:1px solid #333}fieldset button{margin:2px}#rows{max-width:570px}</style></head><body><p>Offline synthetic native chain selectors</p><div id="pickers"></div><div id="native" data-sentry-component="Main"><header><div><button data-testid="filter-tag-trending">Trending</button></div></header><div id="body">Native ranking fixture</div></div><div id="rows"></div></body></html>`;
const browser=await chromium.launch({headless:true});
fs.mkdirSync(new URL('test-results/',root),{recursive:true});
try{
 const context=await browser.newContext({viewport:{width:1000,height:850}}),requests=[],errors=[];
 await context.route('**/*',r=>{requests.push(r.request().url());return r.fulfill({contentType:'text/html',body:html});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({A})=>{
  window.saved={enabled:true,enableFomoPanel:true,enableFomoFeed:true,enableMarkedHolders:false,enableHoldingSurge:false,fomoPanelOpen:false,markedListMigratedV2:true,fomoFeedChainOnly:true};
  window.connections=0;window.portMessages=[];window.listeners=[];window.runtimeMessages=[];
  const local={get(keys,cb){const v={...(typeof keys==='object'?keys:{}),...saved};if(cb){cb(v);return;}return Promise.resolve(v);},set(v,cb){Object.assign(saved,v);cb?.();return Promise.resolve();}};
  window.chrome={runtime:{id:'synthetic',getManifest:()=>({version:'fixture'}),getURL:p=>p,onMessage:{addListener(){}},connect(){connections++;return{onMessage:{addListener:f=>listeners.push(f)},onDisconnect:{addListener(){}},postMessage:m=>portMessages.push(m),disconnect(){}};},sendMessage(m,cb){runtimeMessages.push(m.type);const r={ok:false,events:[],items:[]};cb?.(r);return Promise.resolve(r);}},storage:{local,onChanged:{addListener(){}}}};
  window.emit=()=>listeners.forEach(f=>f({type:'fomo-trending-live-update',data:{ok:true,source:'fomo-trending',provenance:'owned-stream',status:'live',fetchedAt:Date.now(),items:[['bsc',56],['arc',5042],['robinhood',4663],['base',8453]].map(([chain,networkId],i)=>({chain,networkId,address:A,symbol:chain.toUpperCase()+'_FIXTURE',name:'Synthetic token',price:1,marketCap:100000,change24Percent:2,rank:i+1,source:'fomo-trending'}))}}));
  window.allChains=['sol','bsc','robinhood','arc','base','eth','monad','arbitrum','stable','xlayer','hyperevm','megaeth'];
  window.pickers={};window.linked=true;
  window.mountPicker=(id)=>{
    const box=document.createElement('fieldset');box.id=id;box.innerHTML='<legend>'+id+'</legend><button data-testid="chain-multi-select-trigger">Chains</button><button data-action="all">All</button>'+allChains.map(c=>'<button data-chain="'+c+'">'+c+'</button>').join('');document.querySelector('#pickers').append(box);
    const node=box.querySelector('[data-testid]'),root={},top={stateNode:root},module={memoizedProps:{moduleId:id},return:top};top.child=module;
    const core={memoizedProps:{mode:'multi',value:JSON.parse(localStorage.getItem('fixture-'+id)||'["bsc","robinhood","arc"]'),options:allChains.map(value=>({value,disabled:false,checkboxDisabled:false}))},return:module};module.child=core;
    const host={stateNode:node,return:core};core.child=host;root.current=top;node.__reactFiber$fixture=host;
    const entry={box,node,root,top,module,core,host};pickers[id]=entry;
    entry.set=values=>{core.memoizedProps.value=values;localStorage.setItem('fixture-'+id,JSON.stringify(values));node.textContent='Chains: '+values.join(',');box.querySelectorAll('[data-chain]').forEach(n=>n.dataset.selected=String(values.includes(n.dataset.chain)));};
    const select=values=>{entry.set(values);if(linked)Object.entries(pickers).filter(([k])=>k!==id).forEach(([,p])=>p.set(values));};
    box.querySelector('[data-action]').onclick=()=>select([...allChains]);
    box.querySelectorAll('[data-chain]').forEach(n=>n.onclick=()=>{const a=core.memoizedProps.value;select(a.includes(n.dataset.chain)?a.filter(c=>c!==n.dataset.chain):[...a,n.dataset.chain]);});
    entry.set(core.memoizedProps.value);return entry;
  };
 },{A});
 async function setup(){
  await page.goto('https://gmgn.ai/base/token/'+A);
  await page.evaluate(()=>{mountPicker('walletTracking');mountPicker('trending');});
  await page.addStyleTag({content:read('styles.css')});
  await page.addScriptTag({content:read('page-bridge.js')});
  const source=read('content.js').replace(/\}\)\(\);\s*$/,`window.chainTest={filter:nativeFomoChainFilter,events:()=>visibleTrackingFeedEvents(),seed:events=>{fomoFollowedEvents=events},build:buildFomoFeedCard};})();`);
  await page.addScriptTag({content:source});
  await page.waitForFunction(()=>JSON.parse(document.documentElement.getAttribute('data-gdh-chain-filters')||'null')?.trending?.length>0);
  await page.waitForSelector('.gdh-discovery-trending-tab');await page.locator('.gdh-discovery-trending-tab').click();await page.mouse.move(950,820);await page.evaluate(()=>emit());
 }
 await setup();
 const rows=()=>page.locator('.gdh-discovery-token strong').allTextContents();
 assert.deepEqual(await rows(),['BSC_FIXTURE','ARC_FIXTURE','ROBINHOOD_FIXTURE'],'actual picker overrides BASE page route and legacy current-chain checkbox');
 await page.evaluate(({A})=>chainTest.seed(['bsc','arc','base',''].flatMap(chain=>['buy','sell','thesis'].map(type=>({key:chain+type,chain,type,source:'fomo-followed',followed:true,ts:Date.now(),addr:A})))),{A});
 assert.equal(await page.evaluate(()=>chainTest.events().length),6,'buy/sell/thesis filtered, unknown chain excluded');
 await page.locator('#walletTracking [data-chain=arc]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===2);
 assert.deepEqual(await rows(),['BSC_FIXTURE','ROBINHOOD_FIXTURE']);assert.deepEqual(await page.locator('.gdh-discovery-rank').allTextContents(),['1','3']);
 assert.equal(await page.evaluate(()=>chainTest.events().length),3);
 assert.equal(await page.evaluate(()=>connections),1,'filter change does not reconnect or change demand');
 assert.equal(await page.evaluate(()=>portMessages.some(m=>m.type==='refresh')),false,'no refresh request');
 await page.locator('#walletTracking [data-chain=arc]').click();await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===3);
 // Independent native modules remain independent; no cross-panel guessing.
 await page.evaluate(()=>linked=false);await page.locator('#trending [data-chain=arc]').click();await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===2);
 assert.equal(await page.evaluate(()=>chainTest.events().length),6);
 await page.locator('#trending [data-action=all]').click();await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===4);
 assert.equal(await page.evaluate(()=>chainTest.events().length),6);
 // Committed-tree proof: stale .return props and pending props cannot leak chains.
 await page.evaluate(()=>{const p=pickers.trending;p.oldCore=p.core;const fresh={memoizedProps:{...p.core.memoizedProps,value:['arc']},child:p.host,return:p.module};p.module.child=fresh;p.core.pendingProps={...p.core.memoizedProps,value:['bsc']};p.node.textContent='Committed Arc with stale host ancestry';});
 await page.waitForFunction(()=>document.querySelector('.gdh-discovery-token strong')?.textContent==='ARC_FIXTURE'&&document.querySelectorAll('.gdh-discovery-trending-row').length===1);
 // Invalid/missing committed values fail closed, not all-chain fallback.
 await page.evaluate(()=>{pickers.trending.module.child.memoizedProps.value=null;pickers.trending.node.textContent='Unavailable';});
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===0);
 assert.match(await page.locator('.gdh-discovery-trending-list').innerText(),/Waiting for GMGN/);
 await page.evaluate(()=>{pickers.trending.module.child.memoizedProps.value=['arbitrum'];pickers.trending.node.textContent='Arbitrum only';});
 await page.waitForFunction(()=>document.querySelector('.gdh-discovery-trending-list')?.textContent.includes('selected chains'));
 assert.equal(await page.locator('.gdh-discovery-trending-row').count(),0);
 // Host getters are not executed by the public-prop projection.
 await page.evaluate(()=>{window.getterReads=0;Object.defineProperty(pickers.trending.module.child.memoizedProps,'value',{get(){getterReads++;return ['base']},configurable:true});pickers.trending.node.textContent='Getter rejected';});
 await page.waitForFunction(()=>document.querySelector('.gdh-discovery-trending-list')?.textContent.includes('Waiting for GMGN'));
 assert.equal(await page.evaluate(()=>getterReads),0);
 await page.evaluate(()=>{const p=pickers.trending;Object.defineProperty(p.module.child.memoizedProps,'value',{value:['arc'],writable:true,configurable:true});p.node.textContent='Recovered';});
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===1);
 await page.locator('.gdh-discovery-trending-row').hover();await page.evaluate(()=>emit());
 await page.evaluate(()=>{pickers.trending.module.child.memoizedProps.value=['bsc'];pickers.trending.node.textContent='Filter changes even while hovered';});
 await page.waitForFunction(()=>document.querySelector('.gdh-discovery-token strong')?.textContent==='BSC_FIXTURE');
 assert.equal(await page.locator('.gdh-discovery-trending-tab').getAttribute('aria-pressed'),'true');
 for(const width of [1000,390]){await page.setViewportSize({width,height:850});await page.screenshot({path:new URL('test-results/native-chain-filters-'+width+'.png',root).pathname});}
 // Single-chain mode, empty selection and native picker remount are not All.
 await page.evaluate(()=>{const p=pickers.trending;p.module.child.memoizedProps.mode='single';p.module.child.memoizedProps.value=['arc','bsc'];p.node.textContent='Single Arc';});
 await page.waitForFunction(()=>document.querySelector('.gdh-discovery-token strong')?.textContent==='ARC_FIXTURE'&&document.querySelectorAll('.gdh-discovery-trending-row').length===1);
 await page.evaluate(()=>{pickers.trending.module.child.memoizedProps.value=[];pickers.trending.node.textContent='Empty selection';});
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===0);
 assert.match(await page.locator('.gdh-discovery-trending-list').innerText(),/selected chains/);
 await page.evaluate(()=>pickers.trending.box.remove());
 await page.waitForFunction(()=>document.querySelector('.gdh-discovery-trending-list')?.textContent.includes('Waiting for GMGN'));
 await page.evaluate(()=>mountPicker('trending'));await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===4);
 const rejected=await page.evaluate(()=>['{bad',JSON.stringify({version:2,trending:['arc']}),'x'.repeat(2049)].map(raw=>{document.documentElement.setAttribute('data-gdh-chain-filters',raw);document.dispatchEvent(new Event('gdh-chain-filters'));return document.querySelectorAll('.gdh-discovery-trending-row').length;}));
 assert.deepEqual(rejected,[0,0,0],'malformed and unsupported bridge payloads fail closed');
 // Reload gets the currently persisted synthetic native selection, not helper state.
 await page.evaluate(()=>{pickers.trending.set(['arc']);pickers.walletTracking.set(['arc']);});
 await setup();await page.waitForFunction(()=>document.querySelector('.gdh-discovery-token strong')?.textContent==='ARC_FIXTURE');
 assert.equal(await page.locator('.gdh-discovery-trending-row').count(),1);
 assert.equal(requests.length,2,'only routed fixture pages; zero provider I/O');assert.deepEqual(errors,[]);
 // Actual popup can load/save old ON settings without resurrecting the removed control.
 const popup=await context.newPage();popup.on('pageerror',e=>errors.push(e.message));await popup.setViewportSize({width:400,height:850});await popup.route('**/*',r=>{const path=new URL(r.request().url()).pathname;if(path.startsWith('/icons/'))return r.fulfill({contentType:'image/png',body:fs.readFileSync(new URL(path.slice(1),root))});return r.fulfill({contentType:'text/html',body:read('popup.html').replace(/<script[^>]*src="popup.js"[^>]*><\/script>/,'').replace(/<link[^>]*>/g,'')});});
 await popup.goto('https://gmgn.ai/popup-fixture');await popup.evaluate(()=>{window.popupSaved=null;window.chrome={runtime:{getManifest:()=>({version:'fixture'}),getURL:p=>p,sendMessage:async()=>({ok:true,entries:[]})},storage:{local:{get(defaults,cb){cb({...defaults,fomoFeedChainOnly:true});},set(v,cb){popupSaved=v;cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}};});
 await popup.addStyleTag({content:read('popup.css')});await popup.addScriptTag({content:read('popup.js')});
 assert.equal(await popup.locator('#fomo-feed-chain-only').count(),0);
 await popup.locator('#save').click();await popup.waitForFunction(()=>popupSaved!==null);
 assert.equal(await popup.evaluate(()=>Object.hasOwn(popupSaved,'fomoFeedChainOnly')),false);
 await popup.screenshot({path:new URL('test-results/native-chain-filter-popup.png',root).pathname,fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS native chain filters: actual committed MAIN projection → full content, linked/independent pickers, same-address multi-chain, buy/sell/thesis, native ranks, All, empty/unavailable/getter-safe, stale host ancestry, hovered refilter, reload, zero provider traffic/no reconnect and legacy checkbox removed from real popup Save.');
}finally{await browser.close();}
