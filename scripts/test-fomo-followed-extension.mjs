import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fomo-followed-mv3-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true, offline:true,
    args:[`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const workerUrl = worker.url();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(workerUrl).host}/popup.html`);
  const token = `fixture.${Buffer.from(JSON.stringify({sub:'mv3-fomo-account'})).toString('base64url')}.signature`;
  await page.evaluate(token => chrome.storage.local.set({fomoToken:{token,exp:Date.now()+3600000}}), token);
  await worker.evaluate(() => {
    globalThis.__fomoRequests = [];
    globalThis.__fomoPushes = [];
    chrome.tabs.query = async () => [{id:123}];
    chrome.tabs.sendMessage = async (id,message) => { __fomoPushes.push(message); };
    globalThis.__mv3FomoSentinel = true;
    globalThis.fetch = async url => {
      const u = new URL(url); __fomoRequests.push(u.pathname);
      let data;
      if (u.pathname.endsWith('/followingIds')) data={followingIds:['fixture-user']};
      else if (u.pathname.endsWith('/swaps')) data={swaps:[0,1].map(i=>({
        id:`mv3-swap-${i}`,createdAt:new Date(Date.now()-i*1000).toISOString(),
        inNetworkId:1,outNetworkId:1,inTokenAddress:'0x0000000000000000000000000000000000000000',
        outTokenAddress:'0x1111111111111111111111111111111111111111',
        humanUsdAmountIn:100+i,humanUsdAmountOut:100+i,inHumanAmount:1,outHumanAmount:2,
        outTradeId:'11111111-1111-4111-8111-111111111111',inTradeId:null,
      })),hasNextPage:false};
      else if (u.pathname==='/proxy/filterTokens') data=[{token:{networkId:1,address:'0x1111111111111111111111111111111111111111',symbol:'RECOVERED',name:'Recovered token'}}];
      else if (u.pathname==='/trades/11111111-1111-4111-8111-111111111111') data={trade:{id:'11111111-1111-4111-8111-111111111111',userId:'fixture-user'},user:{id:'fixture-user',userHandle:'recovered-user'}};
      else if (u.pathname.endsWith('/balances')) data={balances:[]};
      else if (u.pathname==='/feed') data={feed:[]};
      else if (u.pathname.includes('/feed/')) data={items:[],hasNextPage:false,count:0};
      else if (u.pathname.includes('/users/')) data={id:'fixture-user',userHandle:'fixture',displayName:'Fixture'};
      else data=[];
      return new Response(JSON.stringify({success:true,responseObject:data}),{status:200,headers:{'Content-Type':'application/json'}});
    };
  });
  let response;
  await assert.doesNotReject(async () => {
    const deadline=Date.now()+10000;
    do {
      response=await page.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-followed-feed'}));
      if(response?.events?.filter(e=>e.swapId?.startsWith('mv3-swap-') || e.key?.includes('mv3-swap-')).length===2) return;
      await new Promise(r=>setTimeout(r,100));
    } while(Date.now()<deadline);
    throw new Error(`FOMO swap collection absent: ${JSON.stringify(response)}`);
  });
  assert.equal(new Set(response.events.map(e=>e.key)).size,2,'same-position swaps remain distinct');
  assert.ok(response.events.every(e=>e.tx!=='11111111-1111-4111-8111-111111111111'));
  assert.ok(response.events.every(e=>e.symbol==='RECOVERED' && e.handle==='recovered-user'),'actual worker enriches missing ticker and exited-holder profile');
  const pushes=await worker.evaluate(()=>__fomoPushes);
  const feedPush=pushes.find(p=>p.type==='fomo-followed-feed-update'&&p.data?.events?.length===2);
  assert.ok(feedPush,'fresh events published independently of poll completion');
  assert.equal(feedPush.epoch,createHash('sha256').update(token).digest('hex'),'worker push carries credential digest required by actual content handler');
  const requests=await worker.evaluate(()=>__fomoRequests);
  assert.ok(requests.some(p=>p.endsWith('/fixture-user/swaps')),'actual collector fetched per-user swaps');
  const cdp=await context.newCDPSession(page);
  const version=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('worker discovery timeout')),10000);
    cdp.on('ServiceWorker.workerVersionUpdated',({versions})=>{
      const v=versions.find(v=>v.scriptURL===workerUrl&&v.runningStatus==='running');
      if(v){clearTimeout(timer);resolve(v.versionId);}
    });
  });
  await cdp.send('ServiceWorker.enable');
  const versionId=await version;
  const stopped=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('worker stop timeout')),10000);
    cdp.on('ServiceWorker.workerVersionUpdated',({versions})=>{
      if(versions.some(v=>v.versionId===versionId&&v.runningStatus==='stopped')){clearTimeout(timer);resolve();}
    });
  });
  // Drain session persistence before a real worker shutdown.
  await page.waitForTimeout(300);
  await cdp.send('ServiceWorker.stopWorker',{versionId}); await stopped;
  const restored=await page.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-followed-feed'}));
  worker=context.serviceWorkers().find(w=>w.url()===workerUrl);
  assert.equal(await worker.evaluate(()=>typeof __mv3FomoSentinel),'undefined');
  assert.equal(restored.events.filter(e=>e.key?.includes('mv3-swap-')).length,2,'same-account persisted events restored offline after actual worker stop');
  assert.ok(restored.events.every(e=>e.symbol==='RECOVERED' && e.handle==='recovered-user'),'enrichment survives actual worker restart');
  const other=`fixture.${Buffer.from(JSON.stringify({sub:'other-account'})).toString('base64url')}.signature`;
  await page.evaluate(token=>chrome.storage.local.set({fomoToken:{token,exp:Date.now()+3600000}}),other);
  const changed=await page.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-followed-feed'}));
  assert.ok(!changed.events?.some(e=>e.key?.includes('mv3-swap-')),'another account never receives persisted events');
  console.log('Synthetic real MV3 FOMO: per-user collection, distinct same-position swaps, worker restart persistence, account isolation passed.');
} finally {
  await context?.close();
  fs.rmSync(profile,{recursive:true,force:true});
}
