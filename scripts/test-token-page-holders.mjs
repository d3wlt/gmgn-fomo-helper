// Production content/CSS, isolated synthetic Chromium. No external traffic.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body style="margin:0"><nav aria-label="Main navigation" style="display:flex;align-items:center;flex-wrap:wrap;min-height:36px"><a href="/">Trenches</a><a href="/perpetual">Perpetual</a></nav><div data-sentry-component="BaseInfoBar" style="display:flex;align-items:center;min-height:70px;max-width:100%"><div style="flex:1;min-width:0;overflow:auto">Token information</div></div><main>Offline fixture</main></body></html>'}));
 await page.goto('https://gmgn.ai/');
 await page.evaluate(()=>{
  let offset=0;const now=Date.now;Date.now=()=>now()+offset;window.advance=ms=>offset+=ms;
  window.visible=true;Object.defineProperty(document,'visibilityState',{get:()=>window.visible?'visible':'hidden'});
  const state={enableMarkedHolders:true,enableFomoPanel:true,fomoPanelOpen:false,enableHoldingSurge:false,enableFomoFeed:false,enablePumpFeed:false,markedListMigratedV2:true};
  const listeners=[];window.holderCalls=[];window.pending=[];window.delayed=false;
  window.setSetting=(key,value)=>{const oldValue=state[key];state[key]=value;listeners.forEach(fn=>fn({[key]:{oldValue,newValue:value}},'local'));};
  const local={get(k,cb){const v=Array.isArray(k)?Object.fromEntries(k.filter(x=>x in state).map(x=>[x,state[x]])):{...k,...state};if(cb){queueMicrotask(()=>cb(v));return;}return Promise.resolve(v);},set(v,cb){Object.assign(state,v);cb?.();return Promise.resolve();}};
  window.chrome={runtime:{id:'synthetic',getManifest:()=>({version:'fixture'}),getURL:p=>p,onMessage:{addListener(){}},sendMessage(m,cb){let promise;if(m.type==='fomo-followed-holders'){holderCalls.push(m.payload);const token=m.payload.tokens[0];const result={ok:true,holdings:[{...token,count:token.address.endsWith('1111')?2:0,users:[{handle:'alice_fixture'},{handle:'bob_fixture'}]}]};promise=window.delayed?new Promise(resolve=>pending.push(()=>resolve(result))):Promise.resolve(result);}else promise=Promise.resolve({ok:false,items:[],events:[]});if(cb){promise.then(cb);return;}return promise;}},storage:{local,onChanged:{addListener:fn=>listeners.push(fn)}}};
 });
 await page.addStyleTag({content:read('styles.css')});await page.addScriptTag({content:read('content.js')});
 const route=async path=>{await page.evaluate(path=>{history.pushState({},'',path);window.dispatchEvent(new PopStateEvent('popstate'));document.body.append(document.createElement('i'));},path);};
 const pause=()=>page.waitForTimeout(1200);
 await pause();assert.equal(await page.evaluate(()=>holderCalls.length),0,'Fusion page sends zero holder requests');
 await route('/?chain=bsc');await pause();assert.equal(await page.evaluate(()=>holderCalls.length),0,'single-chain list also sends zero');
 await route('/robinhood/token/'+A);await page.waitForFunction(()=>document.querySelector('.gdh-fomo-launcher .gdh-marked')?.textContent==='👥2');
 assert.deepEqual(await page.evaluate(()=>holderCalls),[{tokens:[{address:A,networkId:4663}]}]);
 assert.equal(await page.locator('[data-sentry-component="BaseInfoBar"] > .gdh-fomo-launcher:last-child').count(),1);
 assert.equal(await page.locator('nav[aria-label="Main navigation"] > .gdh-notification-launcher:last-child').count(),1);
 for(const width of [1280,768,390]) {
  await page.setViewportSize({width,height:900});
  for(const selector of ['.gdh-fomo-launcher','.gdh-notification-launcher']) {
   assert.ok(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return getComputedStyle(el).position!=='fixed'&&r.left>=0&&r.right<=innerWidth&&r.top<160;}));
  }
 }
 await page.locator('.gdh-fomo-launcher').click();await page.waitForSelector('.gdh-fomo-panel');
 await page.locator('.gdh-notification-launcher').click();await page.waitForSelector('.gdh-notification-panel');
 await page.locator('.gdh-notification-launcher').click();await page.waitForFunction(()=>!document.querySelector('.gdh-notification-panel'));
 await page.evaluate(()=>{for(const selector of ['nav[aria-label="Main navigation"]','[data-sentry-component="BaseInfoBar"]']) {const el=document.querySelector(selector),replacement=el.cloneNode(true);replacement.querySelectorAll('.gdh-fomo-launcher,.gdh-notification-launcher').forEach(x=>x.remove());el.replaceWith(replacement);}});
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-fomo-launcher').length===1&&document.querySelectorAll('.gdh-notification-launcher').length===1);
 await page.evaluate(()=>{window.savedHeader=document.querySelector('[data-sentry-component="BaseInfoBar"]');savedHeader.remove();});await pause();
 assert.equal(await page.locator('.gdh-fomo-launcher').count(),0,'unknown header has no floating fallback');
 await page.evaluate(()=>document.body.prepend(savedHeader));await page.waitForFunction(()=>document.querySelector('.gdh-fomo-launcher .gdh-marked')?.textContent==='👥2');
 assert.equal(await page.locator('.gdh-marked').count(),1);assert.match(await page.locator('.gdh-marked').getAttribute('title'),/alice_fixture/);
 await page.evaluate(()=>{for(let i=0;i<20;i++){const a=document.createElement('a');a.href='/bsc/token/0x3333333333333333333333333333333333333333';document.body.append(a);}});await pause();
 assert.equal(await page.evaluate(()=>holderCalls.length),1,'other cards never expand request');
 await page.evaluate(()=>{visible=false;advance(61000)});await pause();assert.equal(await page.evaluate(()=>holderCalls.length),1,'hidden page does not refresh');
 await page.evaluate(()=>{visible=true;document.dispatchEvent(new Event('visibilitychange'))});await page.waitForFunction(()=>holderCalls.length===2);
 await route('/bsc/token/'+A);await page.waitForFunction(()=>holderCalls.length===3);assert.equal(await page.evaluate(()=>holderCalls.at(-1).tokens[0].networkId),56,'same CA uses route chain');
 await page.evaluate(()=>delayed=true);await route('/bsc/token/'+B);await page.waitForFunction(()=>holderCalls.length===4);
 await route('/');await page.evaluate(()=>{pending.splice(0).forEach(resolve=>resolve())});await pause();assert.equal(await page.locator('.gdh-marked').count(),0,'late token response cannot paint list');assert.equal(await page.evaluate(()=>holderCalls.length),4);
 await page.evaluate(()=>delayed=false);await route('/bsc/token/'+B);await page.waitForFunction(()=>document.querySelector('.gdh-marked')?.textContent==='👥0');
 await page.evaluate(()=>setSetting('enableMarkedHolders',false));await pause();assert.equal(await page.locator('.gdh-marked').count(),0);
 await page.evaluate(()=>advance(61000));await pause();assert.equal(await page.evaluate(()=>holderCalls.length),4,'disabled setting stops calls');
 await page.evaluate(()=>{setSetting('enableMarkedHolders',true);setSetting('enableFomoPanel',false)});await pause();assert.equal(await page.locator('.gdh-fomo-launcher').count(),0);assert.equal(await page.evaluate(()=>holderCalls.length),4,'FOMO disabled stops calls');
 assert.deepEqual(errors,[]);
 console.log('PASS token-only followed holders: zero Fusion/list requests, exact token+chain, one/minute, hidden/disabled suppression, hover names, confirmed zero, late-route rejection; real production content/CSS.');
}finally{await browser.close();}
