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
 const all=['BSC_FIXTURE','ARC_FIXTURE','ROBINHOOD_FIXTURE','BASE_FIXTURE'];
 const unchanged=async()=>{assert.deepEqual(await rows(),all);assert.deepEqual(await page.locator('.gdh-discovery-rank').allTextContents(),['1','2','3','4']);};
 await unchanged();
 await page.evaluate(({A})=>chainTest.seed(['bsc','arc','base',''].flatMap(chain=>['buy','sell','thesis'].map(type=>({key:chain+type,chain,type,source:'fomo-followed',followed:true,ts:Date.now(),addr:A})))),{A});
 assert.equal(await page.evaluate(()=>chainTest.events().length),6);
 await page.locator('#walletTracking [data-chain=arc]').click();
 await page.waitForFunction(()=>chainTest.events().length===3);await unchanged();
 await page.locator('#walletTracking [data-chain=arc]').click();
 await page.waitForFunction(()=>chainTest.events().length===6);await unchanged();
 await page.evaluate(()=>linked=false);
 await page.locator('#trending [data-chain=arc]').click();
 await page.waitForFunction(()=>!chainTest.filter('trending').selected.has('arc'));await unchanged();
 await page.locator('#trending [data-action=all]').click();
 await page.waitForFunction(()=>chainTest.filter('trending').selected.has('base'));await unchanged();
 // Still verify the actual committed picker projection, but only Tracking uses it.
 await page.evaluate(()=>{const p=pickers.walletTracking;p.oldCore=p.core;const fresh={memoizedProps:{...p.core.memoizedProps,value:['arc']},child:p.host,return:p.module};p.module.child=fresh;p.core.pendingProps={...p.core.memoizedProps,value:['bsc']};p.node.textContent='Committed Arc with stale host ancestry';});
 await page.waitForFunction(()=>chainTest.filter('walletTracking').selected?.size===1&&chainTest.filter('walletTracking').selected.has('arc'));await unchanged();
 assert.equal(await page.evaluate(()=>chainTest.events().length),3);
 for(const value of [null,[],['arbitrum']]){
  await page.evaluate(value=>{for(const p of Object.values(pickers)){p.module.child.memoizedProps.value=value;p.node.textContent=JSON.stringify(value);}},value);
  await page.waitForFunction(()=>chainTest.events().length===0);await unchanged();
 }
 await page.evaluate(()=>{window.getterReads=0;for(const p of Object.values(pickers)){Object.defineProperty(p.module.child.memoizedProps,'value',{get(){getterReads++;return ['base']},configurable:true});p.node.textContent='Getter rejected';}});
 await page.waitForFunction(()=>!chainTest.filter('walletTracking').available);assert.equal(await page.evaluate(()=>getterReads),0);await unchanged();
 await page.evaluate(()=>{for(const p of Object.values(pickers)){Object.defineProperty(p.module.child.memoizedProps,'value',{value:['arc','bsc'],writable:true,configurable:true});p.module.child.memoizedProps.mode='single';p.node.textContent='Single Arc';}});
 await page.waitForFunction(()=>chainTest.filter('walletTracking').selected?.size===1);await unchanged();
 await page.locator('.gdh-discovery-trending-row').first().hover();
 await page.evaluate(()=>{window.held=document.querySelector('.gdh-discovery-trending-row');emit();pickers.trending.core.memoizedProps.value=['bsc'];pickers.trending.node.textContent='BSC while held';});
 await page.waitForFunction(()=>chainTest.filter('trending').selected?.has('bsc'));await unchanged();
 assert.equal(await page.evaluate(()=>held===document.querySelector('.gdh-discovery-trending-row')),true,'picker must not rebuild held Trending');
 for(const width of [1000,390]){await page.setViewportSize({width,height:850});await page.screenshot({path:new URL('test-results/native-chain-filters-'+width+'.png',root).pathname});}
 await page.evaluate(()=>{pickers.trending.box.remove();pickers.walletTracking.box.remove();});
 await page.waitForFunction(()=>!chainTest.filter('walletTracking').available);await unchanged();
 await page.evaluate(()=>{mountPicker('trending');mountPicker('walletTracking');});
 await page.waitForFunction(()=>chainTest.filter('walletTracking').available);await unchanged();
 const rejected=await page.evaluate(()=>['{bad',JSON.stringify({version:2,trending:['arc']}),'x'.repeat(2049)].map(raw=>{document.documentElement.setAttribute('data-gdh-chain-filters',raw);document.dispatchEvent(new Event('gdh-chain-filters'));return document.querySelectorAll('.gdh-discovery-trending-row').length;}));
 assert.deepEqual(rejected,[4,4,4],'invalid native selection cannot hide Trending');
 assert.equal(await page.evaluate(()=>connections),1);assert.equal(await page.evaluate(()=>portMessages.some(m=>m.type==='refresh')),false);
 await page.evaluate(()=>{pickers.trending.set(['arc']);pickers.walletTracking.set(['arc']);});
 await setup();await unchanged();
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
 console.log('PASS native chain filters: actual committed MAIN projection → full content, linked/independent pickers, same-address multi-chain, buy/sell/thesis, native ranks, All, empty/unavailable/getter-safe, stale host ancestry, Trending all-chain/held-row invariance, Tracking refilter, reload, zero provider traffic/no reconnect and legacy checkbox removed from real popup Save.');
}finally{await browser.close();}
