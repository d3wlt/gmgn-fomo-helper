// Offline full content/CSS + actual owned transport; synthetic WebSocket frames only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url),read=f=>fs.readFileSync(new URL(f,root),'utf8');
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({viewport:{width:390,height:600}}),requests=[],errors=[];
 await context.route('**/*',r=>{requests.push(r.request().url());return r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:8px;background:#101114;color:#ddd;font:13px Arial}button{background:#232730;color:inherit;border:1px solid #444;padding:6px}#native{height:370px;display:flex;flex-direction:column}header{padding:8px}#body{flex:1}</style><p>Synthetic offline FOMO Trending</p><div id="native" data-sentry-component="Main"><header><div><button data-testid="filter-tag-trending">Trending</button></div></header><div id="body">Native fixture</div></div>'});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://gmgn.ai/');
 await page.evaluate(()=>{
  window.ports=[];window.messages=[];
  const saved={enabled:true,enableFomoPanel:true,enableFomoFeed:false,enableMarkedHolders:false,enableHoldingSurge:false,fomoPanelOpen:false,markedListMigratedV2:true};
  window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),getURL:p=>p,onMessage:{addListener(){}},sendMessage(m,cb){messages.push(m);const r={ok:false,items:[],events:[]};cb?.(r);return Promise.resolve(r);},connect(){const p={listener:null,ended:null,onMessage:{addListener:f=>p.listener=f},onDisconnect:{addListener:f=>p.ended=f},postMessage:m=>{messages.push(m);if(m.type==='refresh')transport.refresh();},disconnect(){p.closed=true;}};ports.push(p);return p;}},storage:{local:{get(k,cb){const v={...(typeof k==='object'?k:{}),...saved};cb?.(v);return Promise.resolve(v);},set(v,cb){cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}};
 });
 await page.addStyleTag({content:read('styles.css')});
 await page.addScriptTag({content:read('fomo-trending-live.js')});
 await page.addScriptTag({content:read('content.js').replace(/\}\)\(\);\s*$/,`window.newTest={scan:scanDiscoveryTrending,reset:resetDiscoveryAccount,disable:()=>{settings.enableFomoPanel=false;scanDiscoveryTrending();},enable:()=>{settings.enableFomoPanel=true;scanDiscoveryTrending();}};})();`)});
 await page.evaluate(()=>{
  window.ws=[];window.row=(i,n=56)=>({token:{address:'0x'+i.toString(16).padStart(40,'0'),networkId:n,symbol:'TOKEN_'+i,name:'Synthetic token with a long name',info:{totalSupply:'1000000'}},priceUSD:1,change24:0.12});
  class Socket{constructor(){this.readyState=1;this.handlers={};ws.push(this);}addEventListener(t,f){this.handlers[t]=f;}send(){}close(){this.readyState=3;}frame(payload){this.handlers.message({data:JSON.stringify(payload)});}payload(payload){this.frame({type:'data',topicType:'trending_tokens',topicId:'56,143,4663,5042,8453,1399811149',payload});}}
  window.transport=gdhCreateTrendingLive({WebSocket:Socket,getSession:async()=>({token:'synthetic',sessionKey:'fixture',expiresAt:Date.now()+3600000}),onUpdate:data=>{window.lastSnapshot=data;for(const p of ports)if(!p.closed)p.listener?.({type:'fomo-trending-live-update',data});}});
  window.openStream=async()=>{transport.start();await Promise.resolve();await Promise.resolve();const s=ws.at(-1);s.handlers.open();await Promise.resolve();await Promise.resolve();s.frame({type:'challengeAccepted'});s.payload({kind:'snapshot',tokens:[row(1),row(2)]});};
  window.add=(i,n=56)=>ws.at(-1).payload({kind:'new',tokenKey:row(i,n).token.address+':'+n,index:0,update:row(i,n)});
 });
 const activate=async()=>{await page.locator('.gdh-discovery-trending-tab').click();await page.mouse.move(380,550);await page.evaluate(()=>document.activeElement?.blur());};
 await activate();await page.evaluate(()=>openStream());
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===2);
 const badges=()=>page.locator('.gdh-discovery-new').count();assert.equal(await badges(),0,'initial baseline');
 const rowSelector='.gdh-discovery-trending .gdh-discovery-trending-row';
 const violet={background:'rgba(167, 139, 250, 0.08)',shadow:'rgba(167, 139, 250, 0.7) 0px 0px 0px 1px inset'};
 const visuals=locator=>locator.evaluateAll(rows=>rows.map(row=>{const s=getComputedStyle(row);return {background:s.backgroundColor,shadow:s.boxShadow,animation:s.animationName,transition:s.transitionDuration,rect:row.getBoundingClientRect().toJSON(),hovered:row.matches(':hover')};}));
 const assertPlain=async(label)=>{for(const v of await visuals(page.locator(rowSelector))){assert.equal(v.shadow,'none',label);assert.equal(v.background,v.hovered?'rgb(31, 31, 31)':'rgba(0, 0, 0, 0)',label);}};
 const assertViolet=async(locator)=>{for(const v of await visuals(locator)){assert.equal(v.background,violet.background);assert.equal(v.shadow,violet.shadow);assert.equal(v.animation,'none');assert.equal(v.transition,'0s');}};
 await assertPlain('initial baseline has neither tint nor outline');
 // Deliberately reuse the badge outside the owned row/panel to catch scope leaks.
 const isolation=await page.evaluate(()=>{
  const host=document.createElement('div');host.id='isolation-probes';host.style.display='none';
  host.innerHTML='<div class="gdh-discovery-trending"><div class="native-row"><span class="gdh-discovery-new">🆕</span></div></div><div class="gdh-fomo-panel"><a class="gdh-discovery-trending-row"><span class="gdh-discovery-new">🆕</span></a></div>';
  document.body.append(host);const result=[...host.querySelectorAll('.native-row, a')].map(n=>({background:getComputedStyle(n).backgroundColor,shadow:getComputedStyle(n).boxShadow}));host.remove();return result;
 });
 assert.deepEqual(isolation,[{background:'rgba(0, 0, 0, 0)',shadow:'none'},{background:'rgba(0, 0, 0, 0)',shadow:'none'}]);
 await page.evaluate(()=>add(1,5042));await page.waitForSelector('.gdh-discovery-new');
 assert.equal(await page.locator('.gdh-discovery-new').evaluate(n=>n.closest('a').getAttribute('href')), '/arc/token/0x0000000000000000000000000000000000000001');
 const until=await page.locator('.gdh-discovery-new').getAttribute('data-until');
 for(const width of [220,320,390,570]){
  await page.setViewportSize({width,height:600});
  const geometry=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,badge:document.querySelector('.gdh-discovery-new').getBoundingClientRect().toJSON(),row:document.querySelector('.gdh-discovery-new').closest('a').getBoundingClientRect().toJSON(),nameWidth:document.querySelector('.gdh-discovery-new').previousElementSibling.getBoundingClientRect().width}));
  await assertViolet(page.locator(rowSelector+':has(.gdh-discovery-new)'));
  const parity=await page.locator('.gdh-discovery-new').evaluate(badge=>{const row=badge.closest('a'),before=row.getBoundingClientRect().toJSON();badge.classList.remove('gdh-discovery-new');const without=row.getBoundingClientRect().toJSON();badge.classList.add('gdh-discovery-new');return {before,without};});
  assert.deepEqual(parity.before,parity.without,'highlight leaves exact row rect unchanged');
  assert.ok(geometry.nameWidth>=40,'badge leaves readable ticker width');
  assert.equal(geometry.viewport,width);assert.ok(geometry.scroll<=width);assert.ok(geometry.badge.right<=geometry.row.right&&geometry.badge.left>=geometry.row.left);
  fs.mkdirSync(new URL('test-results/',root),{recursive:true});await page.screenshot({path:new URL(`test-results/trending-newness-${width}.png`,root).pathname});
 }
 await page.locator('.gdh-discovery-trending-row').first().hover();
 const heldVisuals=await visuals(page.locator(rowSelector));
 assert.equal(heldVisuals[0].hovered,true);
 await assertViolet(page.locator(rowSelector).first());
 await page.screenshot({path:new URL('test-results/trending-newness-design-b-hover.png',root).pathname});
 await page.evaluate(()=>{window.heldRows=[...document.querySelectorAll('.gdh-discovery-trending-row')];window.removalTime=null;new MutationObserver(()=>{if(!document.querySelector('.gdh-discovery-new'))removalTime??=Date.now();}).observe(document.querySelector('.gdh-discovery-trending'),{subtree:true,childList:true});add(1,5042);add(3);});
 assert.equal(await page.locator('.gdh-discovery-new').getAttribute('data-until'),until,'updates never renew');
 await page.waitForFunction(()=>!document.querySelector('.gdh-discovery-new'),{},{timeout:12000});
 assert.equal(await page.evaluate(()=>heldRows.every((r,i)=>r===document.querySelectorAll('.gdh-discovery-trending-row')[i])),true,'expiry preserves hovered rows and order');
 await assertPlain('expired tint and outline clear even while hovered');
 const expiredVisuals=await visuals(page.locator(rowSelector));
 assert.equal(expiredVisuals[0].hovered,true,'pointer remains over expired row');
 assert.deepEqual(expiredVisuals.map(v=>v.rect),heldVisuals.map(v=>v.rect),'expiry preserves all held row rects');
 const timing=await page.evaluate(until=>({expiryDelta:removalTime-Number(until),held:document.querySelectorAll('.gdh-discovery-trending-row').length}),until);
 assert.ok(timing.expiryDelta>=0&&timing.expiryDelta<1000);assert.equal(timing.held,3);
 await page.mouse.move(560,550);await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===4);
 // This was received while held, not newly rendered: it must already have expired.
 await page.waitForFunction(()=>!document.querySelector('.gdh-discovery-new'),{},{timeout:2000});
 // Port reconnect with populated transport cache establishes a fresh consumer baseline.
 await page.evaluate(()=>ports.at(-1).ended());await page.waitForFunction(()=>ports.length===2);
 await page.evaluate(()=>add(4));await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===5);assert.equal(await badges(),0);
 await page.evaluate(()=>add(5));await page.waitForSelector('.gdh-discovery-new');
 await page.locator('.gdh-discovery-bar button').click();assert.equal(await badges(),0,'Refresh clears badges immediately');await assertPlain('Refresh clears highlight');
 await page.mouse.move(560,550);await page.evaluate(async()=>{document.activeElement?.blur();await openStream();});
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===2);assert.equal(await badges(),0);await assertPlain('reset baseline has no highlight');
 // Synthetic visibility here exercises production lifecycle, not native tab visibility.
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});newTest.scan();});
 assert.equal(await page.locator('.gdh-discovery-trending').count(),0);
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});newTest.scan();});
 await page.evaluate(()=>add(6));await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===3);assert.equal(await badges(),0);
 // Focus and recent scrolling retain list membership just like pointer hover.
 await page.locator('.gdh-discovery-trending-row').first().focus();await page.evaluate(()=>add(8));
 await page.waitForFunction(()=>lastSnapshot.items.some(r=>r.symbol==='TOKEN_8'));
 assert.equal(await page.locator('.gdh-discovery-trending-row').count(),3);
 await page.evaluate(()=>document.activeElement.blur());await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===4);
 await page.evaluate(()=>{document.querySelector('.gdh-discovery-trending').dispatchEvent(new Event('scroll'));add(9);});
 await page.waitForFunction(()=>lastSnapshot.items.some(r=>r.symbol==='TOKEN_9'));
 assert.equal(await page.locator('.gdh-discovery-trending-row').count(),4);
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===5);
 for(const action of ['reset','disable']){
  await page.evaluate(()=>add(7));await page.waitForSelector('.gdh-discovery-new');
  await page.evaluate(action=>newTest[action](),action);assert.equal(await badges(),0);await assertPlain(action+' clears highlight');
  await page.evaluate(()=>newTest.enable());await activate();await page.evaluate(()=>{transport.stop();return openStream();});
  await page.waitForFunction(()=>document.querySelectorAll('.gdh-discovery-trending-row').length===2);assert.equal(await badges(),0);await assertPlain('reset baseline has no highlight');
 }
 await page.evaluate(()=>add(10));await page.waitForSelector('.gdh-discovery-new');
 await page.locator('[data-testid=filter-tag-trending]').click();assert.equal(await badges(),0);await assertPlain('close clears highlight');
 assert.equal(requests.length,1,'no provider traffic');assert.deepEqual(errors,[]);
 console.log('PASS full production Trending newness: violet computed background/inset outline, no animation, hover priority, unchanged geometry, scoped isolation, baseline, cross-chain insert, unchanged update, held/coalesced expiry, reconnect, Refresh, hidden resume, account/disable/close resets; narrow 220/320/390/570 screenshots; real-time expiry '+JSON.stringify(timing));
} finally {await browser.close();}
