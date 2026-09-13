// Production MV3 worker, offline synthetic Responses. Never contacts a provider.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
const A='0x1111111111111111111111111111111111111111';
const B='0x2222222222222222222222222222222222222222';
const SOL='So11111111111111111111111111111111111111112';
const fixtureToken=sub=>({token:`fixture.${Buffer.from(JSON.stringify({sub,exp:9999999999})).toString('base64url')}.test`});
const response=(rows=[],status=200,headers={})=>new Response(JSON.stringify({statusCode:status,responseObject:rows}),{status,headers});
const item=(address=A,networkId=56,extra={})=>({token:{address,networkId,symbol:'FRONTIER',name:'Frontier Token'},priceUSD:0.001,marketCap:1000,change24:-2,...extra});
const plain=x=>JSON.parse(JSON.stringify(x));
function harness(route){
 let now=Date.now(); const store={fomoToken:fixtureToken('a')},listeners=[],messages=[],calls=[];
 class Clock extends Date{static now(){return now;}}
 const ignore={addListener(){}};
 const ctx=vm.createContext({console,Date:Clock,URL,URLSearchParams,atob,btoa,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,queueMicrotask,
  setTimeout,clearTimeout,setInterval,clearInterval,importScripts(){},fetch:async(url,options)=>{calls.push({url,options});return route(url,options);},
  chrome:{runtime:{onInstalled:ignore,onStartup:ignore,onMessage:{addListener:fn=>messages.push(fn)}},alarms:{get:async()=>({}),create(){},onAlarm:ignore},tabs:{get:async()=>({id:1,url:'https://fomo.family/'}),query:async()=>[],sendMessage:async()=>{},onRemoved:ignore,onUpdated:ignore},storage:{local:{get:async()=>({...store}),set:async data=>Object.assign(store,data),remove:async keys=>{for(const k of [keys].flat())delete store[k];}},onChanged:{addListener:fn=>listeners.push(fn)}}}});
 vm.runInContext(source,ctx);
 return {ctx,calls,run:code=>vm.runInContext(code,ctx),tick:ms=>now+=ms,
  passive:(kind,seq,epoch=1,accountId='a')=>new Promise(resolve=>messages.forEach(fn=>fn({type:'fomo-passive-event',data:{source:'gdh-fomo-passive-v1',bridgeId:'discovery-fixture',kind,seq,epoch,accountId}},{tab:{id:1,url:'https://fomo.family/'},url:'https://fomo.family/',frameId:0,documentId:'fixture-doc'},resolve))),
  account(sub){const oldValue=store.fomoToken;store.fomoToken=sub===null?null:fixtureToken(sub);listeners.forEach(fn=>fn({fomoToken:{oldValue,newValue:store.fomoToken}},'local'));},
  load:(origin='https://gmgn.ai/sol/token/'+SOL)=>new Promise(resolve=>messages.forEach(fn=>fn({type:'fomo-trending'},{url:origin},resolve)))};
}
let h=harness(()=>response([item()]));
assert.equal(h.calls.length,0,'startup has no Trending request');
assert.equal((await h.load('https://fomo.family/')).reason,'not-allowed');
h.account(null);assert.equal((await h.load()).reason,'not-connected');assert.equal(h.calls.length,0,'no anonymous request/cache');
h.account('a');
const pair=await Promise.all([h.load(),h.load(),h.load()]);assert.ok(pair.every(x=>x.ok));assert.equal(h.calls.length,1,'same account coalesces');
assert.equal(h.calls[0].url,'https://prod-api.fomo.family/proxy/trendingTokens');assert.equal(h.calls[0].options.method,'POST');assert.match(h.calls[0].options.headers.Authorization,/^Bearer fixture\./);
await h.load();assert.equal(h.calls.length,1,'60s cache');h.tick(60001);await h.load();assert.equal(h.calls.length,2);
h.account('b');await h.load();assert.equal(h.calls.length,3,'account never inherits cache');h.account(null);assert.deepEqual(plain((await h.load()).items),[]);
h=harness(()=>response([item(A,56),item(A,4663),item(SOL,1399811149),item(B,999),item(A,56),item(B,1,{priceUSD:-7,marketCap:-4,change24:-3}),item(A,1399811149)]));
let data=await h.load();assert.equal(data.ok,true);assert.deepEqual(plain(data.items.map(x=>[x.chain,x.rank])),[['bsc',1],['robinhood',2],['sol',3],['eth',6]]);assert.equal(data.items[3].price,null);assert.equal(data.items[3].marketCap,null);assert.equal(data.items[3].change24Percent,-300);assert.ok(data.items.every(x=>x.source==='fomo-trending'));assert.equal(data.items[2].address,SOL);
for(const body of [null,{}, {responseObject:{}},{responseObject:[item(B,999)]}]) { h=harness(()=>new Response(JSON.stringify(body)));assert.equal((await h.load()).ok,false,'malformed is not empty'); }
h=harness(()=>response([]));assert.deepEqual(plain((await h.load()).items),[]);assert.equal((await h.load()).ok,true);
let status=200;h=harness(()=>status===200?response([item()]):response([],status,{'Retry-After':'120'}));await h.load();h.tick(60001);status=429;data=await h.load();assert.equal(data.stale,true);assert.equal(data.items.length,1);assert.ok(data.retryAt>Date.now()+100000);const count=h.calls.length;await h.load();assert.equal(h.calls.length,count,'global Retry-After cooldown');h.tick(300001);data=await h.load();assert.equal(data.items.length,0,'stale cache expires');
for(const mode of ['status','body']) {let bad=false;h=harness(()=>bad?(mode==='status'?response([],401):new Response(JSON.stringify({statusCode:401}))):response([item()]));await h.load();h.tick(60001);bad=true;data=await h.load();assert.equal(data.reason,'not-connected');assert.equal(data.items.length,0);assert.equal(h.run('fomoTrendingCache'),null);}
// Logout while the response body is being decoded must not populate the next account.
let release;h=harness(()=>new Response(new ReadableStream({start(controller){release=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({responseObject:[item()]})));controller.close();};}})));
const pending=h.load();while(!release)await new Promise(r=>setTimeout(r,1));h.account(null);release();data=await pending;assert.equal(data.reason,'not-connected');assert.equal(h.run('fomoTrendingCache'),null);
// Admission queue is bounded and shared with existing authenticated feature requests.
h=harness(url=>url.endsWith('/v2/users/current')?response({id:'a'}):response([item()]));assert.equal((await h.passive('account',1)).ok,true);await h.load();assert.equal(h.calls.length,1);
await h.passive('logout',2,2);assert.equal((await h.load()).reason,'not-connected');assert.equal(h.calls.length,1,'passive logout blocks still-mirrored session');
await h.passive('account',3,3,'b');assert.equal((await h.load()).reason,'not-connected','new native account rejects old mirror');h.account('b');assert.equal((await h.load()).ok,true);assert.equal(h.calls.length,3);
h=harness(url=>url.endsWith('/v2/users/current')?response({id:'fomo-user'}):response([item()]));h.account('did:privy:fixture');await h.passive('account',1,1,'fomo-user');
assert.ok((await Promise.all([h.load(),h.load()])).every(result=>result.ok),'Privy namespace resolves through authenticated current-user reader');assert.equal(h.calls.length,2,'account verification and Trending each coalesce');await h.load();assert.equal(h.calls.length,2,'verified account mapping shares cache lifetime');
assert.ok(h.calls.every(call=>call.options.headers.Authorization),'account mapping never anonymous');
let decode;h=harness(()=>new Response(new ReadableStream({start(controller){decode=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({responseObject:[item()]})));controller.close();};}})));
await h.passive('account',1);const oldNative=h.load();while(!decode)await new Promise(r=>setTimeout(r,1));await h.passive('logout',2,2);decode();assert.equal((await oldNative).reason,'not-connected');assert.equal(h.run('fomoTrendingCache'),null,'native logout invalidates body decode before mirror');
for(const value of [true,' ',{},'NaN',1e100]) {h=harness(()=>response([item(A,56,{priceUSD:value,marketCap:value,change24:value})]));data=await h.load();assert.equal(data.items[0].price,null);assert.equal(data.items[0].marketCap,null);assert.equal(data.items[0].change24Percent,null);}
h=harness(()=>response([item(A,true)]));assert.equal((await h.load()).ok,false,'boolean network is not Ethereum');
h=harness(()=>response([]));h.run('fomoApiActive=4');const admitted=Array.from({length:32},()=>h.run('acquireFomoApiSlot()'));await assert.rejects(h.run('acquireFomoApiSlot()'));assert.equal(h.run('fomoApiWaiters.length'),32);h.run('fomoApiWaiters.splice(0).forEach(resolve=>resolve())');await Promise.all(admitted);assert.equal(h.calls.length,0);
h=harness(()=>{throw Error('aborted queued work must not fetch');});h.run('globalThis.fixtureAbort=new AbortController();fixtureAbort.abort();');
await assert.rejects(h.run('fomoAuthedFetch("/proxy/trendingTokens",{signal:fixtureAbort.signal})'),error=>error.reason==='network');assert.equal(h.run('fomoAuthGeneration'),0,'optional timeout is not account loss');assert.equal(h.calls.length,0);
const delays=[];h.ctx.setTimeout=(fn,ms)=>{delays.push(ms);queueMicrotask(fn);return 1;};h.run('fomoApiNextStart=Date.now()+3600000');const releaseSlot=await h.run('acquireFomoApiSlot()');releaseSlot();assert.ok(delays.length&&delays.every(ms=>ms<=400),'backwards clock cannot strand admission');
console.log('PASS production Trending worker: authorized endpoint, no startup/anonymous calls, account-bound 60s cache/coalescing, chain-safe normalization, native rank provenance, malformed/empty/auth, negative metrics, 429 cooldown, stale retention, body-decode logout race, optional cancellation distinct from auth loss and bounded shared admission.');
