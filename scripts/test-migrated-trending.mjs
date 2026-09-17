// Synthetic offline native DOM + production transport -> content port -> badge module.
// No installed extension changes, live requests or financial gestures.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url), read=f=>fs.readFileSync(new URL(f,root),'utf8');
const browser=await chromium.launch({headless:true});
const errors=[], requests=[], evidence=[];
try {
 const context=await browser.newContext({viewport:{width:585,height:820}});
 await context.route('**/*',r=>{requests.push(r.request().url());return r.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#111;color:#ddd;font:13px Arial}button{background:#242424;color:inherit;border:1px solid #444}#native{height:180px;display:flex;flex-direction:column}#body{flex:1}.card{position:relative;height:124px;padding:14px;display:flex;gap:8px;overflow:hidden;border-bottom:1px solid #333}.icon{width:72px;height:72px;flex:none;border:1px solid #555;border-radius:8px;display:grid;place-items:center}.info{flex:1;min-width:0}.name{display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;height:20px}.name>span{flex:none}.name>span:first-child{font-size:16px}.secondary{color:#888}.metrics{margin-top:8px;color:#5b9}.controls{position:absolute;right:14px;bottom:12px}p{margin:8px}</style><p>Synthetic offline native Migrated fixture</p><section data-testid="trenchesCompleted"></section><section data-testid="trenchesNew"></section><div id="native" data-sentry-component="Main"><header><div><button data-testid="filter-tag-trending">Trending</button></div></header><div id="body">Native Trending</div></div>`});});
 const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message)); await page.goto('https://gmgn.ai/');
 const asset='data:image/png;base64,'+fs.readFileSync(new URL('assets/fomo-eyes.png',root)).toString('base64');
 await page.evaluate(asset=>{
  window.ports=[];window.messages=[];window.storageListeners=[];
  const saved={enabled:true,enableFomoPanel:true,enableFomoFeed:false,enableMarkedHolders:false,enableHoldingSurge:false,fomoPanelOpen:false,markedListMigratedV2:true};
  window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),getURL:()=>asset,onMessage:{addListener(){}},sendMessage(m,cb){messages.push(m);const r={ok:false,items:[],events:[]};cb?.(r);return Promise.resolve(r);},connect(){const p={onMessage:{addListener:f=>p.listener=f},onDisconnect:{addListener:f=>p.ended=f},postMessage:m=>messages.push(m),disconnect(){p.closed=true;}};ports.push(p);return p;}},storage:{local:{get(k,cb){const v={...(typeof k==='object'?k:{}),...saved};cb?.(v);return Promise.resolve(v);},set(v,cb){cb?.();return Promise.resolve();}},onChanged:{addListener:f=>storageListeners.push(f)}}};
  window.ca='0x'+('1'.repeat(40));window.sol='AbCdEfGhJKLMNPQRSTUVWXYZ123456789ab';
  window.card=(id,chain,address,host='trenchesCompleted')=>{
   const c=document.createElement('div'); c.className='card';c.id=id;c.dataset.testid='trench-token-card';c.setAttribute('href',`/${chain}/token/${address}`);
   c.innerHTML='<div class="icon">TOKEN</div><div class="info"><div class="name"><span data-sentry-component="TooltipCopy">TEST</span><span class="secondary">Token</span><span data-sentry-component="TokenMarkEditButton">✎</span></div><div class="metrics">23s · 93 holders</div></div><div class="controls"><button>Buy</button></div>';
   document.querySelector(`[data-testid=${host}]`).append(c);return c;
  };
  card('bsc','bsc',ca);card('arc','arc',ca);card('sol','sol',sol);card('wrongCase','sol',sol.toLowerCase());card('other','bsc',ca,'trenchesNew');
 },asset);
 for(const f of ['styles.css','migrated-trending.css'])await page.addStyleTag({content:read(f)});
 for(const f of ['fomo-trending-live.js','migrated-trending.js'])await page.addScriptTag({content:read(f)});
 await page.addScriptTag({content:read('content.js').replace(/\}\)\(\);\s*$/,`window.badgeTest={scan:scanDiscoveryTrending,reset:resetDiscoveryAccount,disable:()=>{settings.enableFomoPanel=false;scanDiscoveryTrending();},enable:()=>{settings.enableFomoPanel=true;scanDiscoveryTrending();},globalDisable:()=>{settings.enabled=false;scanDiscoveryTrending();}};})();`)});
 await page.evaluate(()=>{
  window.ws=[];
  window.raw=(address=ca,networkId=56)=>({token:{address,networkId,symbol:'TEST',name:'Token',info:{totalSupply:'1000000'}},priceUSD:1});
  window.emit=data=>{window.lastSnapshot=data;for(const p of ports)if(!p.closed)p.listener?.({type:'fomo-trending-live-update',data});};
  class Socket{constructor(){this.readyState=1;this.handlers={};ws.push(this);}addEventListener(t,f){this.handlers[t]=f;}send(){}close(){this.readyState=3;}frame(v){this.handlers.message({data:JSON.stringify(v)});}payload(payload){this.frame({type:'data',topicType:'trending_tokens',topicId:'56,143,4663,5042,8453,1399811149',payload});}}
  window.transport=gdhCreateTrendingLive({WebSocket:Socket,getSession:async()=>({token:'synthetic',sessionKey:'fixture',expiresAt:Date.now()+3600000}),onUpdate:emit});
  window.snapshot=(tokens=[raw(),raw(sol,1399811149)])=>ws.at(-1).payload({kind:'snapshot',tokens});
  window.start=async()=>{transport.start();await Promise.resolve();await Promise.resolve();const s=ws.at(-1);s.handlers.open();await Promise.resolve();await Promise.resolve();s.frame({type:'challengeAccepted'});snapshot();};
 });
 const activate=async()=>{await page.locator('.gdh-discovery-trending-tab').click();await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());};
 const ids=()=>page.locator('.gdh-migrated-trending').evaluateAll(ns=>ns.map(n=>n.parentElement.id).sort());
 const expectIds=async expected=>{await page.waitForFunction(e=>JSON.stringify([...document.querySelectorAll('.gdh-migrated-trending')].map(n=>n.parentElement.id).sort())===JSON.stringify(e),expected);assert.deepEqual(await ids(),expected);};
 const geometry=()=>page.locator('.card,.card .name,.card button,.card [data-sentry-component=TokenMarkEditButton]').evaluateAll(ns=>ns.map(n=>n.getBoundingClientRect().toJSON()));
 const before=await geometry();await activate();await page.evaluate(()=>start());await expectIds(['bsc','sol']);
 assert.deepEqual(await geometry(),before,'all native names, controls and card geometry unchanged');
 assert.equal(await page.locator('.gdh-discovery-new').count(),0,'initial baseline still badges all current members');
 assert.equal(await page.locator('.gdh-migrated-trending img').first().evaluate(n=>n.complete&&n.naturalWidth>0),true);
 // Actual production transport, not an invented content-only snapshot.
 await page.locator('.gdh-discovery-trending-row').first().hover();
 await page.evaluate(()=>{window.held=[...document.querySelectorAll('.gdh-discovery-trending-row')];snapshot([raw(ca,5042)]);});await expectIds(['arc']);
 assert.equal(await page.evaluate(()=>held.every((n,i)=>n===document.querySelectorAll('.gdh-discovery-trending-row')[i])),true,'membership uses latest RECEIVED while display held');
 await page.evaluate(()=>snapshot([]));await expectIds([]);
 await page.mouse.move(0,0);await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 for(const width of [390,585]){
  await page.setViewportSize({width,height:820});await expectIds(['bsc','sol']);
  const g=await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,badges:[...document.querySelectorAll('.gdh-migrated-trending')].map(n=>({rect:n.getBoundingClientRect().toJSON(),style:{color:getComputedStyle(n).color,background:getComputedStyle(n).backgroundColor,border:getComputedStyle(n).borderColor},card:n.parentElement.getBoundingClientRect().toJSON()}))}));
  assert.equal(g.viewport,width);assert.ok(g.documentWidth<=width);for(const b of g.badges){assert.equal(b.rect.width,82);assert.equal(b.rect.height,20);assert.ok(b.rect.right<=b.card.right);assert.deepEqual(b.style,{color:'rgb(255, 255, 255)',background:'rgb(0, 0, 0)',border:'rgb(68, 68, 68)'});}evidence.push(g);
  fs.mkdirSync(new URL('test-results/',root),{recursive:true});await page.screenshot({path:new URL(`test-results/migrated-trending-${width}.png`,root).pathname});
 }
 // Fail closed if no trailing room; native text and buttons must not move.
 await page.setViewportSize({width:220,height:820});await expectIds([]);
 await page.setViewportSize({width:585,height:820});await expectIds(['bsc','sol']);
 await page.evaluate(()=>document.querySelector('#bsc').setAttribute('href','/arc/token/'+ca));await expectIds(['sol']);
 await page.evaluate(()=>document.querySelector('#bsc').setAttribute('href','/bsc/token/'+ca.toUpperCase().replace('0X','0x')));await expectIds(['bsc','sol']);
 await page.evaluate(()=>{document.querySelector('#bsc').remove();card('remount','bsc',ca);});await expectIds(['remount','sol']);
 await page.evaluate(()=>document.querySelector('#remount .name').innerHTML='<span data-sentry-component="TooltipCopy">TEST</span>');await expectIds(['sol']);
 await page.evaluate(()=>{document.querySelector('#remount').remove();card('bsc','bsc',ca);});await expectIds(['bsc','sol']);
 // DOM-authored CustomEvents are not a membership channel.
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('fomo-trending-live-update',{detail:{items:[]}})));await expectIds(['bsc','sol']);
 await page.evaluate(()=>emit({...lastSnapshot,fetchedAt:Date.now()-59950}));await expectIds([]); // Real deadline expires without another update.
 await page.evaluate(()=>emit({...lastSnapshot,fetchedAt:Date.now(),stale:true}));await expectIds([]);
 await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 await page.evaluate(()=>emit({...lastSnapshot,ok:false,status:'reconnecting'}));await expectIds([]);
 await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 await page.evaluate(()=>ports.at(-1).ended());await expectIds([]);
 await page.waitForFunction(()=>ports.length===2);await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});await expectIds([]);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});badgeTest.scan();});await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 await page.locator('.gdh-discovery-trending-tab').click();await expectIds([]);
 await activate();await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 await page.evaluate(()=>badgeTest.reset());await expectIds([]);
 await activate();await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 await page.evaluate(()=>storageListeners.forEach(f=>f({enableFomoPanel:{newValue:false}},'local')));await expectIds([]);
 await page.evaluate(()=>badgeTest.enable());await activate();await page.evaluate(()=>snapshot());await expectIds(['bsc','sol']);
 await page.evaluate(()=>storageListeners.forEach(f=>f({enabled:{newValue:false}},'local')));await expectIds([]);
 assert.equal(requests.length,1,'no additional HTTP requests (logo is bundled data in fixture)');assert.deepEqual(errors,[]);
 fs.writeFileSync(new URL('test-results/migrated-trending-evidence.json',root),JSON.stringify({synthetic:true,geometry:evidence,requests,errors},null,2));
 console.log('PASS Migrated Trending: production transport -> validated content port -> isolated API; initial all-member baseline, removal, held/latest receive, cross-chain, Sol case, ticker rejection, recycle/remount, missing anchor, narrow omission, unchanged controls/geometry, scoped panels, stale deadline/disconnect/hidden/account/source/disable clears; 390/585px screenshots; zero extra requests/errors. Visibility is a synthetic production-lifecycle probe, not native tab proof.');
}finally{await browser.close();}
