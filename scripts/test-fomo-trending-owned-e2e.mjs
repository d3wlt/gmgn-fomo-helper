// Synthetic native-client fixture, not provider/live-account verification.
// Runs the unchanged production MV3 manifest in an owned, DNS-isolated Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import https from 'node:https';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {WebSocketServer} from 'ws';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const workerURL=`chrome-extension://bdhjiabmohplopjledcagfaejbgdeonf/${manifest.background.service_worker}`;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gdh-owned-trending-e2e-'));
const API='https://prod-api.fomo.family', TOPIC='56,143,4663,5042,8453,1399811149';
const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222';
const jwt=[{alg:'HS256',typ:'JWT'},{sub:'account-a',exp:Math.floor(Date.now()/1000)+3600},'synthetic-only'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
const counts={requests:0,nativeAuth:0,workerAuth:0,connections:0,challengeResponses:0,subscriptions:0,followingSubscriptions:0,closed:0,unexpected:0};
const origins={};const faults=[];const sockets=new Set();let peakSockets=0,snapshotGeneration=1;
let browser,proc,procExited,server,wss;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=12000){const end=Date.now()+timeout;do{if(faults.length)throw Error(faults.join('; '));if(await fn())return;await delay(100);}while(Date.now()<end);throw Error(`Timed out: ${label}; counts=${JSON.stringify(counts)}`);}
const row=(address,networkId,symbol)=>({token:{address,networkId,symbol,info:{totalSupply:'1000000'}},priceUSD:'0.25',change24:'0.12'});
const frame=(socket,payload)=>socket.send(JSON.stringify({type:'data',topicType:'trending_tokens',topicId:TOPIC,payload}));
const broadcast=payload=>{for(const socket of sockets)if(socket.subscribed)frame(socket,payload);};
try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(profile,'key.pem'),'-out',path.join(profile,'cert.pem'),'-days','1','-subj','/CN=prod-api.fomo.family'],{stdio:'ignore'});
  server=https.createServer({key:fs.readFileSync(path.join(profile,'key.pem')),cert:fs.readFileSync(path.join(profile,'cert.pem'))},(req,res)=>{
    counts.requests++;const origin=req.headers.origin||'no-origin';origins[origin]=(origins[origin]||0)+1;
    const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'https://fomo.family','Access-Control-Allow-Headers':'authorization','Access-Control-Allow-Methods':'GET, OPTIONS'};
    if(req.headers.host!=='prod-api.fomo.family'||req.url!=='/v2/users/current'||!['GET','OPTIONS'].includes(req.method)){counts.unexpected++;faults.push('Unexpected TLS request target');res.writeHead(403,headers).end('{}');return;}
    if(req.method==='OPTIONS'){res.writeHead(204,headers).end();return;}
    if(req.headers.authorization!==`Bearer ${jwt}`){faults.push('TLS request lacked exact synthetic authorization');res.writeHead(401,headers).end('{}');return;}
    if(origin==='https://fomo.family')counts.nativeAuth++;else counts.workerAuth++;
    res.writeHead(200,headers).end(JSON.stringify({success:true,statusCode:200,responseObject:{id:'account-a',isRestricted:false}}));
  });
  wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    if(req.headers.host!=='prod-api.fomo.family'||req.url!=='/ws'||req.headers.origin!==new URL(workerURL).origin.replace('null',`chrome-extension://${new URL(workerURL).host}`)){
      counts.unexpected++;faults.push('Unexpected socket origin or target');socket.destroy();return;
    }
    origins[req.headers.origin]=(origins[req.headers.origin]||0)+1;
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  wss.on('connection',socket=>{
    counts.connections++;sockets.add(socket);peakSockets=Math.max(peakSockets,sockets.size);
    socket.on('close',()=>{sockets.delete(socket);counts.closed++;});
    socket.on('message',raw=>{
      let m;try{m=JSON.parse(raw.toString());}catch{faults.push('Invalid client frame');return;}
      if(m.type==='challengeResponse'){
        counts.challengeResponses++;
        if(m.jwt!==jwt){faults.push('Socket rejected nonfixture credential');socket.close(4401);return;}
        socket.authenticated=true;socket.send(JSON.stringify({type:'challengeAccepted'}));return;
      }
      if(m.type==='subscribe'){
        if(m.topicType!=='trending_tokens'){counts.followingSubscriptions++;faults.push('Forbidden non-Trending subscription');return;}
        if(!socket.authenticated||m.topicId!==TOPIC||socket.subscribed){faults.push('Invalid or duplicate subscription');return;}
        counts.subscriptions++;socket.subscribed=true;
        socket.send(JSON.stringify({type:'subscribed',topicType:'trending_tokens',topicId:TOPIC}));
        frame(socket,{kind:'snapshot',tokens:[row(A,56,`SNAP${snapshotGeneration}`),row(B,4663,'SECOND')]});return;
      }
      faults.push('Unexpected socket client message');
    });
    socket.send(JSON.stringify({type:'challenge'}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  proc=spawn(chromium.executablePath(),['--headless=new',...(process.platform==='linux'?['--no-sandbox']:[]),'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,`--disable-extensions-except=${root}`,`--load-extension=${root}`,`--host-resolver-rules=MAP prod-api.fomo.family 127.0.0.1:${server.address().port},MAP * ~NOTFOUND`,'--ignore-certificate-errors','--no-proxy-server','--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
  procExited=new Promise(r=>proc.once('exit',r));
  let port='';await until(()=>{if(proc.exitCode!==null||proc.signalCode!==null)throw Error('Owned Chromium exited before readiness');const f=path.join(profile,'DevToolsActivePort');const t=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';if(/^[0-9]+\n\/devtools\/browser\//.test(t))port=t.split('\n')[0];return !!port;},'owned Chromium readiness');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});const context=browser.contexts()[0];
  let worker=context.serviceWorkers().find(w=>w.url()===workerURL)||await context.waitForEvent('serviceworker',{predicate:w=>w.url()===workerURL,timeout:10000});
  await worker.evaluate(()=>chrome.storage.local.set({enableFomoPanel:true,enableFomoFeed:false,enableHoldingSurge:false,enableMarkedHolders:false,markedListMigratedV2:true}));
  const source=fs.readFileSync(path.join(root,'scripts/test-token-discovery-browser.mjs'),'utf8');const a=source.indexOf('const html='),z=source.indexOf('const browser=',a);
  assert.ok(a>=0&&z>a,'native DOM fixture extraction boundaries');const html=vm.runInNewContext(source.slice(a,z).replace('const html=',''),{A,B});
  await context.addInitScript(token=>{if(location.origin==='https://fomo.family')localStorage.setItem('privy:token',token);},jwt);
  await context.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.origin===API)return route.continue(); // Real TLS for website AND worker; never a route-fulfilled account response.
    if(u.origin==='https://fomo.family'&&route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic native FOMO client</title><body>Offline native client fixture</body>'});
    if(u.origin==='https://gmgn.ai'&&route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:html});
    counts.unexpected++;faults.push('Unexpected fixture network request');return route.abort();
  });
  const native=await context.newPage();await native.goto('https://fomo.family/');
  await native.evaluate(async api=>{const response=await fetch(api+'/v2/users/current',{headers:{Authorization:`Bearer ${localStorage.getItem('privy:token')}`}});if(!response.ok)throw Error('Native fixture account fetch failed');await response.json();},API);
  await until(()=>worker.evaluate(async()=>{const l=await chrome.storage.local.get('fomoToken'),s=await chrome.storage.session.get('gdhTrendingAuthV1');return !!l.fomoToken?.token&&s.gdhTrendingAuthV1?.accountId==='account-a'&&!!s.gdhTrendingAuthV1?.owner;}),'validated native account and natural runtime auth mirror');
  const gmgn=await context.newPage();await gmgn.goto(`https://gmgn.ai/bsc/token/${A}`);
  await worker.evaluate(async()=>{const[t]=await chrome.tabs.query({url:'https://gmgn.ai/*'});await chrome.tabs.update(t.id,{active:true});});
  async function select(page){await page.locator('.gdh-discovery-trending-tab').waitFor({timeout:10000});await page.locator('.gdh-discovery-trending-tab').evaluate(button=>button.click());}
  async function symbols(page,expected){try{await until(async()=>JSON.stringify(await page.locator('.gdh-discovery-token strong').allTextContents())===JSON.stringify(expected),'automatic ordered GMGN DOM '+expected.join(','));}catch(error){console.error(JSON.stringify({diagnostic:await page.evaluate(()=>({visible:document.visibilityState,selected:document.querySelector('.gdh-discovery-trending-tab')?.getAttribute('aria-pressed'),status:document.querySelector('.gdh-discovery-trending [role=status]')?.textContent,rows:document.querySelectorAll('.gdh-discovery-trending-row').length})),auth:await worker.evaluate(async()=>{const s=(await chrome.storage.session.get('gdhTrendingAuthV1')).gdhTrendingAuthV1;return {revoked:s?.revoked,requireMirror:s?.requireMirror,owner:!!s?.owner,tokenPresent:!!(await chrome.storage.local.get('fomoToken')).fomoToken};})}));throw error;}}
  const secondPromise=context.waitForEvent('page');await worker.evaluate(url=>chrome.windows.create({url,focused:true,type:'normal'}),`https://gmgn.ai/robinhood/token/${B}`);const second=await secondPromise;await second.waitForLoadState();
  await select(gmgn);await symbols(gmgn,['SNAP1','SECOND']);assert.equal(counts.connections,1);assert.ok(counts.workerAuth>=1);
  await native.waitForFunction(()=>document.visibilityState==='hidden');await delay(3300);assert.equal(await native.evaluate(()=>document.hidden),true);
  broadcast({kind:'update',tokenKey:B+':4663',index:0,update:row(B,4663,'HIDDEN_DELTA')});await symbols(gmgn,['HIDDEN_DELTA','SNAP1']);
  broadcast({kind:'remove',tokenKey:A+':56'});await symbols(gmgn,['HIDDEN_DELTA']);assert.equal(await native.evaluate(()=>document.hidden),true);
  // Two genuinely visible active tabs in separate windows, not visibility overrides.
  await select(second);
  assert.equal(await gmgn.evaluate(()=>document.visibilityState),'visible');assert.equal(await second.evaluate(()=>document.visibilityState),'visible');await symbols(second,['HIDDEN_DELTA']);assert.equal(counts.connections,1,'two production content ports share one socket');
  broadcast({kind:'update',tokenKey:B+':4663',index:0,update:row(B,4663,'SHARED')});await symbols(gmgn,['SHARED']);await symbols(second,['SHARED']);
  await second.locator('[data-testid="filter-tag-trending"]').evaluate(button=>button.click());await delay(500);assert.equal(sockets.size,1,'deselecting one consumer retains other demand');
  await gmgn.locator('[data-testid="filter-tag-trending"]').evaluate(button=>button.click());await until(()=>sockets.size===0,'last consumer deselection closes owned socket');
  snapshotGeneration=2;await select(gmgn);await symbols(gmgn,['SNAP2','SECOND']);
  snapshotGeneration=3;for(const socket of sockets)socket.terminate();await symbols(gmgn,['SNAP3','SECOND']);
  assert.equal(counts.connections,3,'transport loss reconnects without manual Refresh');
  const cdp=await context.newCDPSession(gmgn);const versions=new Map();cdp.on('ServiceWorker.workerVersionUpdated',({versions:vs})=>vs.forEach(v=>versions.set(v.versionId,v)));await cdp.send('ServiceWorker.enable');
  async function restart(){
    await worker.evaluate(()=>globalThis.__ownedE2eSentinel=true);
    await until(()=>[...versions.values()].some(v=>v.scriptURL===workerURL&&v.runningStatus==='running'),'exact running extension version');
    const version=[...versions.values()].find(v=>v.scriptURL===workerURL&&v.runningStatus==='running');
    await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
    // CDP may reuse the target/Playwright Worker wrapper with a fresh execution
    // context. A new serviceworker event is not itself the restart criterion.
    await until(async()=>{for(const candidate of context.serviceWorkers().filter(w=>w.url()===workerURL)){try{if(await candidate.evaluate(()=>globalThis.__ownedE2eSentinel===undefined)){worker=candidate;return true;}}catch{}}return false;},'fresh worker global after exact CDP stop',15000);
    assert.equal(await worker.evaluate(()=>globalThis.__ownedE2eSentinel===undefined),true,'fresh worker global proves actual restart');
  }
  snapshotGeneration=4;await restart();await symbols(gmgn,['SNAP4','SECOND']);assert.equal(await native.evaluate(()=>document.hidden),true);
  // The fixture server deliberately continues accepting the old token after logout.
  await native.evaluate(()=>{localStorage.removeItem('privy:token');window.dispatchEvent(new Event('focus'));});
  await until(async()=>sockets.size===0&&(await gmgn.locator('.gdh-discovery-trending-row').count())===0,'natural mirror logout closes socket and clears DOM',6500);
  await until(()=>worker.evaluate(async()=>{const s=await chrome.storage.session.get('gdhTrendingAuthV1');return s.gdhTrendingAuthV1?.revoked===true&&!(await chrome.storage.local.get('fomoToken')).fomoToken;}),'durable revocation');
  const beforeLogoutRestart=counts.connections,authBefore=counts.workerAuth;
  // Selection is the only wake/demand input; no runtime auth/session injection.
  await select(gmgn);
  await restart();await delay(5500);
  assert.equal(counts.connections,beforeLogoutRestart,'restart cannot resurrect server-valid old JWT');assert.equal(counts.workerAuth,authBefore,'revoked auth does not call current-user');assert.equal(await gmgn.locator('.gdh-discovery-trending-row').count(),0);
  assert.equal(counts.nativeAuth,1);assert.equal(counts.followingSubscriptions,0);assert.equal(counts.unexpected,0);assert.deepEqual(faults,[]);assert.equal(peakSockets,1);
  console.log(JSON.stringify({realMV3:true,syntheticNativeClient:true,liveProviderVerified:false,fullProductionContent:true,nativeAccountAndMirror:true,hiddenFomoUpdates:true,twoVisibleWindowsShareSocket:true,lastDemandStops:true,transportLossRecovers:true,workerRestartFreshDOM:true,logoutDurableAcrossRestart:true,manualRefreshes:0,peakSockets,counts,origins}));
}finally{
  await browser?.close().catch(()=>{});
  if(proc){if(proc.exitCode===null&&proc.signalCode===null)proc.kill();const force=setTimeout(()=>proc.kill('SIGKILL'),5000);force.unref();try{await procExited;}finally{clearTimeout(force);}}
  for(const socket of wss?.clients||[])socket.terminate();
  server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());
  await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});assert.equal(fs.existsSync(profile),false);
}
