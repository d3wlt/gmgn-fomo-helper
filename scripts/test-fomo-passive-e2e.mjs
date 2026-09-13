import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {WebSocketServer} from 'ws';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gdh-passive-e2e-'));
let context,server,wss;
try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(profile,'key.pem'),'-out',path.join(profile,'cert.pem'),'-days','1','-subj','/CN=prod-api.fomo.family'],{stdio:'ignore'});
  server=https.createServer({key:fs.readFileSync(path.join(profile,'key.pem')),cert:fs.readFileSync(path.join(profile,'cert.pem'))});
  wss=new WebSocketServer({server});
  let nativeSocket,clientSends=0;wss.on('connection',socket=>{nativeSocket=socket;socket.on('message',()=>clientSends++);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const socketPort=server.address().port;
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,`--host-resolver-rules=MAP prod-api.fomo.family 127.0.0.1:${socketPort},MAP * ~NOTFOUND`,'--ignore-certificate-errors','--no-proxy-server','--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets']});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  await worker.evaluate(()=>{globalThis.__passiveOutbound=[];globalThis.fetch=async(...args)=>{__passiveOutbound.push(String(args[0]));throw new Error('Independent worker request forbidden in passive test');};});
  const popup=await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await popup.evaluate(()=>chrome.storage.local.set({fomoToken:{token:'synthetic.passive.session',exp:Date.now()+3600000},debugLogging:true}));
  let unauthorized=false;
  const nativeRequests=[];
  // Real local TLS transport gives trusted browser MessageEvents; Playwright
  // routeWebSocket dispatches synthetic events intentionally rejected by MAIN.
  const base={userId:'user-a',userHandle:'native_alice',profilePictureLink:'https://fixture.invalid/avatar.png',networkId:1,tokenAddress:'0x1111111111111111111111111111111111111111',ticker:'NATIVE',createdAt:new Date().toISOString()};
  const first={...base,id:'observed-buy',type:'swap_buy',usdAmount:556,fdv:41400};
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://fomo.family')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic native FOMO fixture</title><body>Offline native activity fixture</body>'});
    if(url.origin==='https://prod-api.fomo.family'){
      nativeRequests.push(url.pathname);
      if(unauthorized&&url.pathname==='/v2/users/current')return route.fulfill({status:401,headers:{'Access-Control-Allow-Origin':'https://fomo.family'},json:{success:false}});
      const responseObject=url.pathname==='/v2/users/current'?{id:'account-a'}:url.pathname.endsWith('/followingIds')?{followingIds:['user-a']}:url.pathname==='/feed/tradingActivity'?{items:[first],hasNextPage:false}:null;
      assert.ok(responseObject,`unexpected native request ${url.pathname}`);
      return route.fulfill({headers:{'Access-Control-Allow-Origin':'https://fomo.family'},json:{success:true,statusCode:200,responseObject}});
    }
    throw new Error(`Unexpected network host ${url.origin}`);
  });
  const native=await context.newPage();native.on('console',m=>{if(m.type()==='error')console.log('fixture browser:',m.text());});await native.goto('https://fomo.family/');
  // These are the fixture WEBSITE's calls, not extension calls. Observe actual
  // MAIN -> isolated -> runtime -> worker wiring with native browser events.
  await native.evaluate(async()=>{
    await Promise.all(['/v2/users/current','/v2/users/current/followingIds','/feed/tradingActivity'].map(p=>fetch('https://prod-api.fomo.family'+p).then(r=>r.json())));
    window.fixtureSocket=new WebSocket('wss://prod-api.fomo.family/ws');
  });
  await native.waitForFunction(()=>window.fixtureSocket?.readyState===1);
  nativeSocket.send(JSON.stringify({type:'subscribed',topicType:'trading_activity',topicId:'account-a'}));
  nativeSocket.send(JSON.stringify({type:'data',topicType:'trading_activity',topicId:'account-a',payload:{...base,id:'observed-thesis',type:'thesis',comment:{id:'comment-a',comment:'Native passive thesis'},authorTrade:{usdValue:25,closedAt:null,percentageUnrealizedPnl:12}}}));
  async function waitSnapshot(predicate) {
    const deadline=Date.now()+10000;let s;
    do {s=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-followed-feed'}));if(predicate(s))return s;await popup.waitForTimeout(25);}while(Date.now()<deadline);
    throw new Error('Passive snapshot timeout: '+JSON.stringify(s));
  }
  let snapshot=await waitSnapshot(s=>s.events?.length===2&&s.passiveStatus==='connected');
  assert.equal(snapshot.mode,'passive');assert.equal(snapshot.passiveStatus,'connected');
  assert.equal(snapshot.events.find(e=>e.type==='buy').usd,556);
  assert.equal(snapshot.events.find(e=>e.type==='buy').mc,41400);
  assert.equal(snapshot.events.find(e=>e.type==='thesis').comment,'Native passive thesis');
  await worker.evaluate(async()=>{
    const changed=new Promise(resolve=>{const done=changes=>{if(changes.fomoToken){chrome.storage.onChanged.removeListener(done);resolve();}};chrome.storage.onChanged.addListener(done);});
    await chrome.storage.local.set({fomoToken:{token:'fixture.'+btoa(JSON.stringify({sub:'account-a'}))+'.signature',exp:Date.now()+3600000}});
    await changed;
  });
  snapshot=await waitSnapshot(s=>s.events?.length===2&&s.passiveStatus==='connected');
  assert.equal(snapshot.events.length,2,'late same-account session mirroring must not retire the native document');
  assert.ok(snapshot.events.every(e=>e.avatar===base.profilePictureLink&&e.symbol==='NATIVE'));
  assert.deepEqual(nativeRequests.sort(),['/feed/tradingActivity','/v2/users/current','/v2/users/current/followingIds'].sort());
  assert.deepEqual(await worker.evaluate(()=>__passiveOutbound),[]);
  // Native Trending crosses the real trusted socket/MAIN/isolated/MV3 chain.
  const ca='0x1111111111111111111111111111111111111111',sol='So11111111111111111111111111111111111111112';
  const trend=(address,networkId,symbol)=>({token:{address,networkId,symbol,info:{totalSupply:'1000000'}},priceUSD:'0.25',marketCap:999,change24:'0.12'});
  const trendRows=[trend(ca,56,'BSC'),trend(ca,4663,'RH'),trend(sol,1399811149,'SOL')];
  const frame=payload=>nativeSocket.send(JSON.stringify({type:'data',topicType:'trending_tokens',topicId:'56,4663,1399811149',payload}));
  async function waitTrending(predicate) {
    const deadline=Date.now()+10000;let result;
    do {result=await worker.evaluate(()=>fetchFomoTrending());if(predicate(result))return result;await popup.waitForTimeout(25);}while(Date.now()<deadline);
    throw new Error('Native Trending MV3 snapshot timeout');
  }
  frame({kind:'snapshot',tokens:trendRows});
  let rankings=await waitTrending(s=>s.ok&&s.items.length===3);
  assert.equal(rankings.provenance,'native-stream');assert.deepEqual(rankings.items.map(r=>r.chain),['bsc','robinhood','sol']);assert.equal(rankings.items[0].marketCap,250000,'MC is supply times price, not raw marketCap');assert.equal(rankings.items[0].change24Percent,12);
  frame({kind:'update',tokenKey:sol+':1399811149',index:0,update:trendRows[2]});
  rankings=await waitTrending(s=>s.ok&&s.items[0]?.chain==='sol');assert.deepEqual(rankings.items.map(r=>r.rank),[1,2,3]);
  frame({kind:'remove',tokenKey:ca+':56'});
  rankings=await waitTrending(s=>s.ok&&s.items.length===2);assert.deepEqual(rankings.items.map(r=>r.chain),['sol','robinhood']);
  assert.deepEqual(await worker.evaluate(()=>__passiveOutbound),[],'Trending never requests REST/account data');
  unauthorized=true;
  await native.evaluate(()=>fetch('https://prod-api.fomo.family/v2/users/current'));
  await waitSnapshot(s=>s.events?.length===0);
  nativeSocket.send(JSON.stringify({type:'data',topicType:'trading_activity',topicId:'account-a',payload:first}));
  snapshot=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-followed-feed'}));
  assert.equal(snapshot.events.length,0,'old native socket cannot resurrect logout data');
  frame({kind:'snapshot',tokens:trendRows});
  assert.equal((await worker.evaluate(()=>fetchFomoTrending())).ok,false,'native logout rejects old Trending socket');
  await native.close();
  snapshot=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'fomo-followed-feed'}));
  assert.notEqual(snapshot.passiveStatus,'connected');
  assert.deepEqual(await worker.evaluate(()=>__passiveOutbound),[]);
  assert.equal(clientSends,0,'observer never sends native socket messages');
  console.log('Synthetic full MV3 passive bridge: native REST + trusted WebSocket -> MAIN -> isolated -> worker, metadata/thesis, logout/tab close, zero helper requests/sends passed.');
} finally {await context?.close();for(const socket of wss?.clients||[])socket.terminate();await new Promise(resolve=>server?server.close(resolve):resolve());fs.rmSync(profile,{recursive:true,force:true});}
