// Offline host contract observed read-only on native GMGN via CDP 9225.
// Production transport -> validated content port -> shared isolated renderer.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url), read=f=>fs.readFileSync(new URL(f,root),'utf8');
const browser=await chromium.launch({headless:true});
const requests=[],errors=[];
try {
 const context=await browser.newContext({viewport:{width:900,height:650}});
 await context.route('**/*',r=>{requests.push(r.request().url());return r.fulfill({contentType:'text/html',body:`<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#111;color:#ddd;font:13px Arial}.info{width:480px;padding:12px}.row{display:flex;align-items:center;gap:4px;height:24px}.controls{position:relative;display:flex;gap:4px}.secondary{display:flex;gap:8px;height:22px}#native{height:180px;display:flex;flex-direction:column}#body{flex:1}.card{position:relative;width:500px;height:100px;padding:12px}.name{display:flex;gap:4px;height:20px}button{background:#222;color:#ddd}</style><p>Illustrative membership — synthetic native header contract</p><section id="header"></section><section data-testid="trenchesCompleted"><div class="card" data-testid="trench-token-card"><div class="name"><span data-sentry-component="TooltipCopy">TEST</span><span data-sentry-component="TokenMarkEditButton">Edit</span></div></div></section><div id="native" data-sentry-component="Main"><header><div><button data-testid="filter-tag-trending">Trending</button></div></header><div id="body">Native Trending</div></div>`});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://gmgn.ai/bsc/token/0x1111111111111111111111111111111111111111');
 const asset='data:image/png;base64,'+fs.readFileSync(new URL('assets/fomo-eyes.png',root)).toString('base64');
 await page.evaluate(asset=>{
  window.ports=[];window.messages=[];window.storageListeners=[];
  const saved={enabled:true,enableFomoPanel:true,enableFomoFeed:false,enableMarkedHolders:false,enableHoldingSurge:false,fomoPanelOpen:false,markedListMigratedV2:true};
  window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),getURL:()=>asset,onMessage:{addListener(){}},sendMessage(m,cb){messages.push(m);const r={ok:false,items:[],events:[]};cb?.(r);return Promise.resolve(r);},connect(){const p={onMessage:{addListener:f=>p.listener=f},onDisconnect:{addListener:f=>p.ended=f},postMessage:m=>messages.push(m),disconnect(){p.closed=true;}};ports.push(p);return p;}},storage:{local:{get(k,cb){const v={...(typeof k==='object'?k:{}),...saved};cb?.(v);return Promise.resolve(v);},set(v,cb){cb?.();return Promise.resolve();}},onChanged:{addListener:f=>storageListeners.push(f)}}};
  window.ca='0x'+'1'.repeat(40);window.other='0x'+'2'.repeat(40);window.sol='AbCdEfGhJKLMNPQRSTUVWXYZ123456789ab';
  window.route=(chain='bsc',address=ca)=>history.pushState({},'',`/${chain}/token/${address}`);
  window.header=(chain='bsc',address=ca)=>{
   const hosts={bsc:'bscscan.com',arc:'testnet.arcscan.app',sol:'solscan.io',base:'basescan.org',monad:'monadscan.com',robinhood:'rh-scan.com'};
   document.querySelector('#header').innerHTML=`<div class="info"><div class="row"><div><span data-sentry-component="TooltipCopy"><span data-testid="token-detail-symbol">TEST</span></span> Token</div><div class="controls"><div><span data-sentry-component="TokenMarkEditButton">Edit</span><button>Copy</button></div><button>Share</button></div></div><div class="secondary"><span>1d</span><div><span id="token-base-address" data-addr="${address}">short CA</span></div><div data-sentry-component="BaseLinkView"><a href="https://${hosts[chain]}/token/${address}">Explorer</a></div></div></div>`;
  };header();document.querySelector('.card').setAttribute('href','/bsc/token/'+ca);
 },asset);
 for(const f of ['styles.css','migrated-trending.css'])await page.addStyleTag({content:read(f)});
 for(const f of ['fomo-trending-live.js','migrated-trending.js'])await page.addScriptTag({content:read(f)});
 await page.addScriptTag({content:read('content.js').replace(/\}\)\(\);\s*$/,`window.badgeTest={scan:scanDiscoveryTrending,reset:resetDiscoveryAccount,enable:()=>{settings.enabled=true;settings.enableFomoPanel=true;scanDiscoveryTrending();}};})();`)});
 await page.evaluate(()=>{
  window.ws=[];window.raw=(address=ca,networkId=56)=>({token:{address,networkId,symbol:'TEST',name:'Token',info:{totalSupply:'1000000'}},priceUSD:1});
  window.emit=data=>{window.lastSnapshot=data;for(const p of ports)if(!p.closed)p.listener?.({type:'fomo-trending-live-update',data});};
  class Socket{constructor(){this.readyState=1;this.handlers={};ws.push(this);}addEventListener(t,f){this.handlers[t]=f;}send(){}close(){this.readyState=3;}frame(v){this.handlers.message({data:JSON.stringify(v)});}payload(payload){this.frame({type:'data',topicType:'trending_tokens',topicId:'56,143,4663,5042,8453,1399811149',payload});}}
  window.transport=gdhCreateTrendingLive({WebSocket:Socket,getSession:async()=>({token:'synthetic',sessionKey:'fixture',expiresAt:Date.now()+180000}),onUpdate:emit});
  window.snapshot=(tokens=[raw()])=>ws.at(-1).payload({kind:'snapshot',tokens});
  window.start=async()=>{transport.start();await Promise.resolve();await Promise.resolve();const s=ws.at(-1);s.handlers.open();await Promise.resolve();await Promise.resolve();s.frame({type:'challengeAccepted'});snapshot();};
 });
 const count=async n=>{await page.waitForTimeout(150);try { await page.waitForFunction(n=>document.querySelectorAll('.gdh-token-trending').length===n,n,{timeout:5000}); } catch(e) {console.log(await page.evaluate(()=>({route:location.pathname,snapshot:lastSnapshot,header:document.querySelector('#header').innerHTML,ports:ports.map(p=>({closed:p.closed})),messages:messages.slice(-3)})));throw e;}assert.equal(await page.locator('.gdh-token-trending').count(),n);};
 const activate=async()=>{await page.locator('.gdh-discovery-trending-tab').click();await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());};
 const geometry=()=>page.locator('#header .info,#header .row,#header button,#header [data-testid],#header .secondary').evaluateAll(ns=>ns.map(n=>n.getBoundingClientRect().toJSON()));
 const before=await geometry();await activate();await page.evaluate(()=>start());await count(1);assert.deepEqual(await geometry(),before);
 assert.equal(await page.locator('.gdh-migrated-trending').count(),1,'Migrated coexists unchanged');
 assert.equal(await page.locator('.gdh-discovery-new').count(),0,'baseline member is badged without newness');
 await page.locator('.gdh-discovery-trending-row').first().hover();
 await page.evaluate(()=>{window.held=[...document.querySelectorAll('.gdh-discovery-trending-row')];snapshot([raw(other)]);});await count(0);
 await page.evaluate(()=>snapshot());await count(1);
 assert.ok(await page.evaluate(()=>held.every((n,i)=>n===document.querySelectorAll('.gdh-discovery-trending-row')[i])),'latest receive enters/exits while displayed list held');
 await page.mouse.move(0,0);
 await page.evaluate(()=>snapshot([raw(ca,5042)]));await count(0);
 // Route-first, address-first, chain-first and fully remounted SPA headers.
 await page.evaluate(()=>route('arc'));await count(0);
 await page.evaluate(()=>document.querySelector('#token-base-address').setAttribute('data-addr',ca));await count(0);
 await page.evaluate(()=>header('arc'));await count(1);
 await page.evaluate(()=>{snapshot([raw(other,5042)]);route('arc',other);});await count(0);
 await page.evaluate(()=>document.querySelector('#token-base-address').setAttribute('data-addr',other));await count(0);
 await page.evaluate(()=>header('arc',other));await count(1);
 await page.evaluate(()=>header('arc',other));await count(1);
 await page.evaluate(()=>{header('sol',sol);route('sol',sol);snapshot([raw(('a'+sol.slice(1)),1399811149)]);});await count(0);
 await page.evaluate(()=>snapshot([raw(sol,1399811149)]));await count(1);
 await page.evaluate(()=>route('sol',('a'+sol.slice(1))));await count(0);
 await page.evaluate(()=>route('sol',sol));await count(1);
 await page.evaluate(()=>document.querySelector('#token-base-address').setAttribute('data-addr',sol.slice(0,8)));await count(0);
 await page.evaluate(()=>header('sol',sol));await count(1);
 await page.evaluate(()=>document.querySelector('[data-sentry-component=BaseLinkView] a').href='https://evil.example/token/'+sol);await count(0);
 await page.evaluate(()=>{route();header();snapshot();});await count(1);
 // Every owned-stream chain uses its native explorer identity, never ticker.
 for(const [chain,networkId] of [['base',8453],['monad',143],['robinhood',4663]]){
  await page.evaluate(([chain,networkId])=>{route(chain);header(chain);snapshot([raw(ca,networkId)]);},[chain,networkId]);await count(1);
 }
 await page.evaluate(()=>{const address='0x'+'ab'.repeat(20);route('bsc',address);header('bsc',address.toUpperCase().replace('0X','0x'));snapshot([raw(address)]);});await count(1);
 await page.evaluate(()=>{route();header();snapshot();});await count(1);
 for(const width of [585,900]){
  await page.setViewportSize({width,height:650});await count(1);assert.deepEqual(await geometry(),before);
  assert.deepEqual(await page.locator('.gdh-token-trending').evaluate(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return [r.width,r.height,s.backgroundColor,s.color,s.borderColor];}),[82,20,'rgb(0, 0, 0)','rgb(255, 255, 255)','rgb(68, 68, 68)']);
 }
 await page.evaluate(()=>document.querySelector('.info').style.width='230px');await count(0);
 await page.evaluate(()=>document.querySelector('.info').style.width='480px');await count(1);
 await page.evaluate(()=>document.querySelector('#header').hidden=true);await count(0);
 await page.evaluate(()=>document.querySelector('#header').hidden=false);await count(1);
 await page.evaluate(()=>document.querySelector('#header').replaceChildren());await count(0);
 await page.evaluate(()=>header());await count(1);
 assert.equal(await page.evaluate(()=>ports.length),1,'SPA and layout work add no owned-port demand');
 await page.evaluate(()=>{document.querySelector('#native').style.display='none';badgeTest.scan();});await count(0);
 await page.evaluate(()=>{document.querySelector('#native').style.display='flex';badgeTest.scan();snapshot();});await count(1);
 await page.evaluate(()=>emit({...lastSnapshot,fetchedAt:Date.now()-59950}));await count(0);
 for(const bad of [{stale:true},{ok:false,status:'reconnecting'},{source:'native'}]){
  await page.evaluate(()=>snapshot());await count(1);
  await page.evaluate(bad=>emit({...lastSnapshot,...bad,items:bad.source?lastSnapshot.items.map(x=>({...x,source:'native'})):lastSnapshot.items}),bad);
  if(bad.source){ // Invalid envelope is ignored; valid owned envelope with invalid item is removed.
   await page.evaluate(()=>emit({...lastSnapshot,source:'fomo-trending'}));
  }
  await count(0);
 }
 await page.evaluate(()=>snapshot());await count(1);await page.evaluate(()=>ports.at(-1).ended());await count(0);
 await page.waitForFunction(()=>ports.length===3);await page.evaluate(()=>snapshot());await count(1);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});await count(0);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});badgeTest.scan();snapshot();});await count(1);
 await page.locator('.gdh-discovery-trending-tab').click();await count(0);
 await activate();await page.evaluate(()=>snapshot());await count(1);
 await page.evaluate(()=>badgeTest.reset());await count(0);
 await activate();await page.evaluate(()=>snapshot());await count(1);
 await page.evaluate(()=>storageListeners.forEach(f=>f({enableFomoPanel:{newValue:false}},'local')));await count(0);
 await page.evaluate(()=>badgeTest.enable());await activate();await page.evaluate(()=>snapshot());await count(1);
 await page.evaluate(()=>storageListeners.forEach(f=>f({enabled:{newValue:false}},'local')));await count(0);
 assert.equal(requests.length,1,'zero extra network requests');assert.equal(await page.evaluate(()=>ws.length),1,'no additional transport sockets');assert.deepEqual(errors,[]);
 console.log('PASS token Trending: production transport/content/renderer baseline, automatic enter/exit, latest received while held, exact chain/full CA/Sol case, delayed SPA header/route and remount, geometry/fit, stale expiry, hidden/disconnect/account/source/disable cleanup, Migrated coexistence, zero extra HTTP requests or browser errors.');
} finally {await browser.close();}
