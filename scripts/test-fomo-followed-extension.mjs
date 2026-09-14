import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fomo-passive-mv3-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true,
    args:[`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  await context.route('https://**/*', route => route.request().isNavigationRequest() && route.request().url()==='https://fomo.family/'
    ? route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Native passive fixture</title>'}) : route.abort());
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const workerUrl = worker.url();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(workerUrl).host}/popup.html`);
  const token = `fixture.${Buffer.from(JSON.stringify({sub:'mv3-fomo-account',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
  await context.addInitScript(value=>{if(location.origin==='https://fomo.family')localStorage.setItem('privy:token',value);},token);
  await page.evaluate(token => chrome.storage.local.set({fomoToken:{token,exp:Date.now()+3600000}}), token);
  await worker.evaluate(async()=>{
    await gdhDebug.ready; await gdhDebug.setEnabled(true);
    globalThis.__fomoRequests=[]; globalThis.__fomoPushes=[]; globalThis.__mv3FomoSentinel=true;
    globalThis.fetch=async url=>{__fomoRequests.push(String(url));throw Error('Passive worker must never fetch');};
    chrome.tabs.sendMessage=async(id,message)=>{__fomoPushes.push(message);};
    const query=chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query=async options=>Array.isArray(options?.url)&&options.url.some(u=>u.includes('gmgn.ai'))?[{id:123}]:query(options);
  });
  const poll=()=>page.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-followed-feed'}));
  assert.equal((await poll()).events.length,0);
  const spoof=await page.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-passive-event',data:{source:'gdh-fomo-passive-v1',kind:'account',accountId:'spoof',epoch:1,seq:1,bridgeId:'spoof-bridge'}}));
  assert.equal(spoof.ok,false,'extension popup is not a native FOMO sender');
  const fomo=await context.newPage(); await fomo.goto('https://fomo.family/');
  let seq=100,epoch=1,accountId='mv3-fomo-account';
  const emit=async(kind,extra={})=>{
    await fomo.evaluate(data=>window.postMessage(data,location.origin),{source:'gdh-fomo-passive-v1',kind,accountId,epoch,seq:++seq,observedAt:Date.now(),...extra});
    await fomo.waitForTimeout(50);
  };
  await emit('account');
  await emit('activity',{items:[{id:'native-1',swapId:'swap-1',type:'swap_buy',userId:'fixture-user',userHandle:'native-user',networkId:1,tokenAddress:'0x1111111111111111111111111111111111111111',ticker:'NATIVE',usdAmount:556,fdv:41400,createdAt:new Date().toISOString(),authorization:'do-not-forward'},
    {id:'unfollowed',type:'swap_buy',userId:'stranger',ts:Date.now()}]});
  assert.equal((await poll()).events.length,0,'native activity buffers before roster');
  await emit('following',{followingIds:['fixture-user']});
  assert.equal((await poll()).passiveStatus,'waiting-for-activity');
  await emit('connection',{connected:true});
  let result=await poll();
  assert.equal(result.events.length,1,'actual document-start isolated script forwards native page observations');
  assert.equal(result.events[0].usd,556); assert.equal(result.events[0].mc,41400); assert.equal(result.events[0].symbol,'NATIVE');
  assert.equal(result.mode,'passive'); assert.equal(result.passiveStatus,'connected');
  assert.ok(!JSON.stringify(result).includes('do-not-forward'));
  const pushes=await worker.evaluate(()=>__fomoPushes);
  const push=pushes.find(p=>p.type==='fomo-followed-feed-update'&&p.data.events.length===1);
  assert.ok(push); assert.equal(push.epoch,createHash('sha256').update(token).digest('hex'));
  assert.equal((await worker.evaluate(()=>__fomoRequests)).length,0,'ZERO worker fetches through actual runtime feed');
  await worker.evaluate(()=>{fomoPassive.at=Date.now()-61000;});
  assert.equal((await poll()).passiveStatus,'disconnected','expired observation never looks fresh');
  await emit('connection',{connected:true});
  epoch++; await emit('logout',{accountId:''});
  assert.equal((await poll()).events.length,0);
  await emit('account',{epoch:1});
  assert.equal((await poll()).events.length,0,'stale pre-logout epoch cannot restore data');
  epoch++;accountId='other-account';await emit('account');await emit('following',{followingIds:[]});
  assert.equal((await poll()).events.length,0,'new account receives no prior events');
  const debug=await page.evaluate(()=>chrome.runtime.sendMessage({type:'debug-export'}));
  assert.ok(debug.data.entries.some(e=>e.kind==='passive'));
  assert.ok(!JSON.stringify(debug.data).includes('fixture-user'));
  await fomo.close(); await page.waitForTimeout(50);
  assert.equal((await poll()).passiveStatus,'disconnected','closed native tab is not automatically recreated');
  assert.equal((await worker.evaluate(()=>__fomoRequests)).length,0);
  assert.equal((await worker.evaluate(()=>chrome.tabs.query({url:'https://fomo.family/*'}))).length,0);
  // A real MV3 eviction must not resurrect legacy persisted/cache events.
  const cdp=await context.newCDPSession(page);
  const version=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('worker discovery timeout')),10000);
    cdp.on('ServiceWorker.workerVersionUpdated',({versions})=>{const v=versions.find(v=>v.scriptURL===workerUrl&&v.runningStatus==='running');if(v){clearTimeout(timer);resolve(v.versionId);}});
  });
  await cdp.send('ServiceWorker.enable'); const versionId=await version;
  const stopped=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('worker stop timeout')),10000);
    cdp.on('ServiceWorker.workerVersionUpdated',({versions})=>{if(versions.some(v=>v.versionId===versionId&&v.runningStatus==='stopped')){clearTimeout(timer);resolve();}});
  });
  await cdp.send('ServiceWorker.stopWorker',{versionId});await stopped;
  result=await poll();
  worker=context.serviceWorkers().find(w=>w.url()===workerUrl);
  assert.equal(await worker.evaluate(()=>typeof __mv3FomoSentinel),'undefined');
  assert.equal(result.events.length,0); assert.equal(result.passiveStatus,'waiting-for-fomo-tab');
  console.log('Real MV3 passive: isolated native observations, ZERO worker fetches, digest push, spoof/logout/stale/closed-tab rejection and actual worker restart isolation passed.');
} finally { await context?.close();fs.rmSync(profile,{recursive:true,force:true}); }
