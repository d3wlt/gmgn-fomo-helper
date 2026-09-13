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
export function harness(route){
 let now=Date.now(); const store={fomoToken:fixtureToken('a')},listeners=[],messages=[],calls=[];
 class Clock extends Date{static now(){return now;}}
 const ignore={addListener(){}};
 const ctx=vm.createContext({console,Date:Clock,URL,URLSearchParams,atob,btoa,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,queueMicrotask,
  setTimeout,clearTimeout,setInterval,clearInterval,importScripts(){},fetch:async(url,options)=>{calls.push({url,options});return route(url,options);},
  chrome:{runtime:{onInstalled:ignore,onStartup:ignore,onMessage:{addListener:fn=>messages.push(fn)}},alarms:{get:async()=>({}),create(){},onAlarm:ignore},tabs:{get:async()=>({id:1,url:'https://fomo.family/'}),query:async()=>[],sendMessage:async()=>{},onRemoved:ignore,onUpdated:ignore},storage:{local:{get:async()=>({...store}),set:async data=>Object.assign(store,data),remove:async keys=>{for(const k of [keys].flat())delete store[k];}},onChanged:{addListener:fn=>listeners.push(fn)}}}});
 vm.runInContext(source,ctx);
 return {ctx,calls,run:code=>vm.runInContext(code,ctx),tick:ms=>now+=ms,
  passive:(kind,seq,epoch=1,accountId='a',extra={})=>new Promise(resolve=>messages.forEach(fn=>fn({type:'fomo-passive-event',data:{source:'gdh-fomo-passive-v1',bridgeId:'discovery-fixture',kind,seq,epoch,accountId,...extra}},{tab:{id:1,url:'https://fomo.family/'},url:'https://fomo.family/',frameId:0,documentId:'fixture-doc'},resolve))),
  account(sub){const oldValue=store.fomoToken;store.fomoToken=sub===null?null:fixtureToken(sub);listeners.forEach(fn=>fn({fomoToken:{oldValue,newValue:store.fomoToken}},'local'));},
  load:(origin='https://gmgn.ai/sol/token/'+SOL)=>new Promise(resolve=>messages.forEach(fn=>fn({type:'fomo-trending'},{url:origin},resolve)))};
}
let h=harness(()=>{throw Error('Trending must never fetch');});
const dto={chain:'bsc',networkId:56,address:A,symbol:'F',name:'Fomo',price:2,marketCap:20,change24Percent:-10,rank:1};
const seed=async(h,seq=2,extra={})=>h.passive('trending',seq,1,'a',{available:true,nativeSnapshot:true,items:[dto],observedAt:h.run('Date.now()'),...extra});
assert.equal(h.calls.length,0);
assert.equal((await h.load('https://fomo.family/')).reason,'not-allowed');
assert.equal((await h.load()).reason,'waiting-native-trending');
await h.passive('account',1); await seed(h);
let data=await h.load(); assert.equal(data.ok,true); assert.equal(data.provenance,'native-stream');
assert.deepEqual(plain(data.items),[{...dto,source:'fomo-trending'}]);
assert.equal(h.run('fomoPassive.ids'),null,'Trending requires no Following roster');
const at=data.fetchedAt; h.tick(20000); assert.equal((await h.load()).fetchedAt,at,'reads do not refresh age');
assert.ok((await Promise.all([h.load(),h.load()])).every(r=>r.ok));
h.tick(280000); assert.equal((await h.load()).reason,'waiting-native-trending');
await seed(h,3); h.tick(-1); assert.equal((await h.load()).ok,false,'clock regression expires');
h.tick(1); await seed(h,4); await h.passive('logout',5,2); assert.equal((await h.load()).ok,false);
await h.passive('account',6,3,'b'); assert.equal((await seed(h,7)).ok,false,'old epoch rejected');
assert.equal((await h.load()).ok,false);
h=harness(()=>{throw Error('no fetch');});await h.passive('account',1);await seed(h);
await seed(h,4,{nativeSnapshot:false});assert.equal((await h.load()).ok,false,'gap requires native snapshot');
await seed(h,5,{nativeSnapshot:false});assert.equal((await h.load()).ok,false);
await seed(h,6);assert.equal((await h.load()).ok,true);
await seed(h,7,{items:[{...dto,address:'bad'}]});assert.equal((await h.load()).ok,false);
await seed(h,8);h.account(null);assert.equal((await h.load()).ok,false,'mirror logout clears');
assert.equal(h.calls.length,0);
h=harness(()=>{throw Error('no fetch');});await h.passive('account',1);await seed(h);
h.ctx.chrome.webNavigation={getFrame:async()=>({documentId:'new-doc',url:'https://fomo.family/'})};
assert.equal((await h.load()).ok,false,'document navigation checked on read');assert.equal((await seed(h,3)).reason,'stale-document');
h.ctx.chrome.webNavigation=undefined;
let release;h.ctx.chrome.tabs.get=()=>new Promise(r=>{release=r;});const pending=h.load();
h.account(null);release({url:'https://fomo.family/'});assert.equal((await pending).ok,false,'auth race during tab read');
assert.equal(h.calls.length,0);
h=harness(()=>response([]));h.run('fomoApiActive=4');const admitted=Array.from({length:32},()=>h.run('acquireFomoApiSlot()'));await assert.rejects(h.run('acquireFomoApiSlot()'));assert.equal(h.run('fomoApiWaiters.length'),32);h.run('fomoApiWaiters.splice(0).forEach(resolve=>resolve())');await Promise.all(admitted);assert.equal(h.calls.length,0);
h=harness(()=>{throw Error('aborted queued work must not fetch');});h.run('globalThis.fixtureAbort=new AbortController();fixtureAbort.abort();');
await assert.rejects(h.run('fomoAuthedFetch("/proxy/trendingTokens",{signal:fixtureAbort.signal})'),error=>error.reason==='network');assert.equal(h.run('fomoAuthGeneration'),0,'optional timeout is not account loss');assert.equal(h.calls.length,0);
const delays=[];h.ctx.setTimeout=(fn,ms)=>{delays.push(ms);queueMicrotask(fn);return 1;};h.run('fomoApiNextStart=Date.now()+3600000');const releaseSlot=await h.run('acquireFomoApiSlot()');releaseSlot();assert.ok(delays.length&&delays.every(ms=>ms<=400),'backwards clock cannot strand admission');
console.log('PASS passive Trending worker: native-only cache, DTO, no roster, TTL/clock, epoch/logout, gap recovery, document/auth races, zero fetch; shared admission/cancellation/clock regressions.');
