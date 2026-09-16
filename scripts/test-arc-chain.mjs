// Production worker normalization -> production content/CSS and MAIN navigation.
// Synthetic tokens/accounts only; no live provider requests or trading gestures.
// Mapping evidence: https://fomo.family/assets/chains-v2-Bt9eFTem.js
// defines Arc id 5042 and USDC 0x3600000000000000000000000000000000000000;
// its native V() getter includes 5042 and C[5042] is 'arc'.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {harness} from './test-token-discovery-worker.mjs';
const root=new URL('../',import.meta.url),read=f=>fs.readFileSync(new URL(f,root),'utf8');
const ca='0x1111111111111111111111111111111111111111';
const h=harness(()=>{throw Error('Unexpected worker network');});
await h.passive('account',1);
await h.passive('following',2,1,'a',{followingIds:['synthetic-user']});
const raw={userId:'synthetic-user',userHandle:'fixture_trader',type:'swap_buy',tokenAddress:ca,ticker:'ARC_FIXTURE',createdAt:new Date().toISOString(),usdAmount:501,fdv:17100};
await h.passive('activity',3,1,'a',{transport:'websocket',topicId:'a',items:[
 {...raw,id:'arc-buy',networkId:5042}, {...raw,id:'bsc-buy',networkId:56}, {...raw,id:'unknown-buy',networkId:999999}
]});
const events=JSON.parse(JSON.stringify((await h.run('fetchFomoFollowedFeed()')).events));
const arc=events.find(e=>e.chain==='arc'),bsc=events.find(e=>e.chain==='bsc'),unknown=events.find(e=>!e.chain);
assert.ok(arc&&bsc&&unknown);assert.equal(arc.addr,ca);assert.equal(arc.usd,501);assert.equal(arc.mc,17100);
assert.equal(h.run('FOMO_NETWORK_SLUG[5042]'),'arc');
assert.equal(h.run('FOMO_QUOTE_TOKENS[5042]'),'0x3600000000000000000000000000000000000000');
assert.ok(h.run('FOMO_CHAINS.split(",").includes("5042")'));
assert.equal(h.calls.length,0);
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({viewport:{width:1000,height:600}});
 const requests=[],errors=[];
 await context.route('**/*',route=>{requests.push(route.request().url());return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><title>Arc offline regression fixture</title><style>body{background:#101114;color:#ddd;font:14px Arial;margin:16px}#rows{width:100%;display:grid;gap:12px}.fixture-label{font:12px Arial;color:#aaa}</style></head><body><p>Offline synthetic fixture · Arc chain routing</p><div id="rows"></div></body></html>'});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://gmgn.ai/bsc/token/'+ca);
 await page.evaluate(version=>{
  const settings={enabled:false,enableFomoPanel:false,enableFomoFeed:false,enableHoldingSurge:false,enableMarkedHolders:false,markedListMigratedV2:true};
  window.chrome={runtime:{id:'synthetic',getManifest:()=>({version}),getURL:p=>p,onMessage:{addListener(){}},sendMessage(m,cb){const r={ok:false,events:[]};if(cb){queueMicrotask(()=>cb(r));return;}return Promise.resolve(r);}},storage:{local:{get(keys,cb){const r={...(typeof keys==='object'?keys:{}),...settings};if(cb){queueMicrotask(()=>cb(r));return;}return Promise.resolve(r);},set(){return Promise.resolve();}},onChanged:{addListener(){}}}};
  window.navigation=[];window.next={router:{push:url=>{navigation.push(url);history.pushState({},'',url);return Promise.resolve(true);}}};
 },JSON.parse(read('manifest.json')).version);
 await page.addStyleTag({content:read('styles.css')});
 await page.addScriptTag({content:read('page-bridge.js')});
 await page.addScriptTag({content:read('native-quickbuy.js')});
 const hooks='window.__arcTest={build:buildFomoFeedCard,route:currentTokenRoute,ref:discoveryRef,slug:chain=>FOMO_CHAIN_SLUG[chain]};';
 await page.addScriptTag({content:read('content.js').replace(/\}\)\(\);\s*$/,hooks+'\n})();')});
 for(const width of [1000,390]){
  await page.setViewportSize({width,height:600});
  for(const table of [true,false]){
   await page.evaluate(({arc,bsc,unknown,table})=>{
    const host=document.querySelector('#rows');host.replaceChildren();
    for(const [id,event] of [['arc',arc],['bsc',bsc],['unknown',unknown]]){
     const label=document.createElement('div');label.className='fixture-label';label.textContent=id+' · '+(table?'table':'card');host.append(label);
     const card=__arcTest.build(event,table);card.id='fixture-'+id;host.append(card);
    }
    history.replaceState({},'','/bsc/token/'+bsc.addr);
   },{arc,bsc,unknown,table});
   const stripe=page.locator('#fixture-arc .gdh-fomofeed__stripe');
   assert.equal(await stripe.evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(92, 141, 229)');
   assert.ok((await stripe.boundingBox()).height>0);
   assert.equal(await page.locator('#fixture-unknown .gdh-fomofeed__stripe').count(),0,'unknown ID never invents a chain');
   // Exercise actual card click -> content event -> real MAIN router adapter.
   await page.locator('#fixture-arc').click({position:{x:4,y:10}});
   await page.waitForURL('https://gmgn.ai/arc/token/'+ca);
   // Let the production 450ms navigation fallback retire before navigating back.
   await page.waitForTimeout(500);
   const route=await page.evaluate(()=>({route:__arcTest.route(),slug:__arcTest.slug('arc'),different:__arcTest.ref('arc','0x1111111111111111111111111111111111111111').key!==__arcTest.ref('bsc','0x1111111111111111111111111111111111111111').key}));
   assert.equal(route.route.networkId,5042);assert.equal(route.slug,'arc');assert.equal(route.different,true);
   await page.locator('#fixture-bsc').click({position:{x:4,y:10}});await page.waitForURL('https://gmgn.ai/bsc/token/'+ca);
   await page.waitForTimeout(500);
   await page.mouse.move(5,5);
   await page.screenshot({path:new URL('test-results/arc-feed-'+width+'-'+(table?'table':'card')+'.png',root).pathname});
  }
 }
 await page.evaluate(arc=>{
  localStorage.setItem('follow_toast_chain_color_v1',JSON.stringify({arc:{color:'#112233'}}));
  const card=__arcTest.build(arc,true);document.querySelector('#rows').replaceChildren(card);
 },arc);
 assert.equal(await page.locator('.gdh-fomofeed__stripe').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(17, 34, 51)','native custom chain color is retained');
 await page.locator('.gdh-fomofeed').hover();
 await page.locator('.gdh-native-buy-host').hover();
 assert.equal(await page.locator('.gdh-native-buy-host').getAttribute('data-state'),'unavailable','Arc fails closed without native tracker account context');
 assert.match(await page.locator('.gdh-native-buy-host').getAttribute('title'),/Native tracker account context unavailable/);
 assert.equal(requests.length,1,'only routed initial page: no API or trading requests');assert.deepEqual(errors,[]);
 console.log('PASS Arc 5042: production passive worker normalization, quote/network mapping, distinct same-CA chain identity, blue/default and custom stripes, full content-to-MAIN /arc/token navigation in table/card at 1000/390; unknown-chain fallback and zero provider/trading I/O');
}finally{await browser.close();}
