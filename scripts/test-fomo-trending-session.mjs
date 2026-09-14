import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../fomo-trending-session.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const tick = () => new Promise(r => setImmediate(r));
const NOW = 1700000000000;
const token = (sub='did:privy:a', delta=3600, extra={}) => ['eyJhbGciOiJFUzI1NiJ9', Buffer.from(JSON.stringify({sub, exp:NOW/1000+delta,...extra})).toString('base64url'), 'c2ln'].join('.');
const sender = (tabId=1, documentId='doc1', url='https://fomo.family/') => ({id:'extension', tab:{id:tabId,url}, url, frameId:0, documentId});
const message = (t=token(), seq=1, epoch=1) => ({type:'fomo-auth-mirror-v1', seq,epoch,status:'token',token:t,refresh:'synthetic-refresh'});
function fixture(shared={local:{fomoToken:{token:token(),refresh:'synthetic-refresh'}},session:{}}) {
  const logs=[],calls=[],invalidations=[];
  let clock=NOW;
  const hooks={};
  const frames=new Map([[1,{documentId:'doc1',url:'https://fomo.family/'}]]);
  const storage = area => ({
    async get(key) { const snapshot=structuredClone({[key]:shared[area][key]}); await hooks[`${area}Get`]?.(); return snapshot; },
    async set(data) { await hooks[`${area}Set`]?.(); Object.assign(shared[area],structuredClone(data)); },
    async remove(key) { await hooks[`${area}Remove`]?.(); delete shared[area][key]; }
  });
  const chrome={runtime:{id:'extension'},storage:{local:storage('local'),session:storage('session')},
    tabs:{async get(id) { await hooks.tabs?.(); if(!frames.has(id)) throw Error('closed'); return {url:frames.get(id).url}; }},
    webNavigation:{async getFrame({tabId}) {return frames.get(tabId);} }};
  const fetch=async (url,init) => {calls.push({url,init}); if(hooks.fetch) return hooks.fetch(url,init); return {ok:true,status:200,json:async()=>({responseObject:{id:'fomo-a',isRestricted:false}})};};
  const sandbox={URL,AbortController,atob,setTimeout,clearTimeout,console:new Proxy({}, {get:()=> (...args)=> logs.push(args)})};
  vm.createContext(sandbox); vm.runInContext(source,sandbox);
  const auth=sandbox.gdhCreateTrendingSession({chrome,fetch,now:()=>clock,onInvalidate:r=>invalidations.push(r),verificationTimeoutMs:100});
  return {auth,shared,hooks,frames,calls,logs,invalidations,sandbox,setClock:n=>clock=n};
}
let count=0;
async function test(name, fn) { await fn(); count++; console.log(`ok ${count} - ${name}`); }
await test('immutable global/API, namespace mapping, coalesced bounded verification',async()=>{
  const f=fixture(); await f.auth.observeAccount('fomo-a');
  const results=await Promise.all([f.auth.getSession(),f.auth.getSession(),f.auth.getSession()]);
  assert(results.every(r=>r?.sessionKey==='fomo-a')); assert.equal(f.calls.length,1);
  assert(Object.isFrozen(f.auth)); assert.equal(Object.getOwnPropertyDescriptor(f.sandbox,'gdhCreateTrendingSession').writable,false);
  assert.equal(f.calls[0].url,'https://prod-api.fomo.family/v2/users/current');
  assert.equal(f.calls[0].init.method,'GET'); assert.equal(f.calls[0].init.credentials,'omit');
  await f.auth.getSession(); assert.equal(f.calls.length,1);
  f.setClock(NOW+60001); await f.auth.getSession(); assert.equal(f.calls.length,2); assert.equal(f.logs.length,0);
});
await test('malformed, expired, missing-sub credentials never hit network',async()=>{
  for(const t of ['garbage',token('a',-1),token('a',3600,{exp:'9999999999'}),token('',3600)]) {
    const f=fixture(); f.shared.local.fomoToken.token=t; assert.equal(await f.auth.getSession(),null); assert.equal(f.calls.length,0);
  }
});
await test('restricted, malformed, 401, 403 and identity mismatch fail closed',async()=>{
  for(const spec of [{id:'fomo-a',isRestricted:true},{id:'fomo-a'},{isRestricted:false},{id:'fomo-b',isRestricted:false},401,403]) {
    const f=fixture(); await f.auth.observeAccount('fomo-a');
    f.hooks.fetch=async()=>({ok:typeof spec==='object',status:typeof spec==='number'?spec:200,json:async()=>({responseObject:spec})});
    assert.equal(await f.auth.getSession(),null); assert.equal(await f.auth.getSession(),null); assert.equal(f.calls.length,1);
  }
});
await test('native account change invalidates old verified mapping',async()=>{
  const f=fixture(); assert(await f.auth.getSession()); await f.auth.observeAccount('fomo-b');
  assert.equal(await f.auth.getSession(),null); assert.equal(f.calls.length,2); assert(f.invalidations.includes('account'));
});
await test('unchanged mirror heartbeat does not rewrite credentials or invalidate views',async()=>{
  const f=fixture(); let writes=0; f.hooks.localSet=async()=>{writes++;};
  await f.auth.handleMirror(message(),sender());
  await f.auth.handleMirror(message(token(),2),sender());
  assert.equal(writes,0); assert.equal(f.invalidations.length,0);
  assert.equal(f.shared.session.gdhTrendingAuthV1.owner.seq,2);
});
await test('same-sub rotation keeps session identity; other-sub earlier expiry replaces',async()=>{
  const f=fixture(); await f.auth.observeAccount('fomo-a');
  assert.equal((await f.auth.handleMirror(message(),sender())).ok,true);
  assert(await f.auth.getSession()); const before=f.invalidations.length;
  const newer=token('did:privy:a',7200);
  assert.equal((await f.auth.handleMirror(message(newer,2),sender())).ok,true);
  assert.equal((await f.auth.getSession()).sessionKey,'fomo-a'); assert.equal(f.invalidations.length,before);
  await f.auth.handleMirror(message(token('did:privy:a',3500),3),sender()); assert.equal(f.shared.local.fomoToken.token,newer);
  await f.auth.observeAccount('fomo-b'); const other=token('did:privy:b',1200);
  assert.equal((await f.auth.handleMirror(message(other,4,2),sender())).ok,true); assert.equal(f.shared.local.fomoToken.token,other);
  assert.equal(f.shared.local.fomoToken.refresh,'synthetic-refresh'); assert(f.invalidations.includes('token-account'));
});
await test('actual extension/topframe/current document only; owner conflict/replay',async()=>{
  const f=fixture();
  for(const s of [{...sender(),id:'other'},{...sender(),frameId:1},sender(1,'stale'),sender(1,'doc1','https://gmgn.ai/'),{...sender(),documentId:undefined}]) assert.equal((await f.auth.handleMirror(message(),s)).ok,false);
  assert.equal((await f.auth.handleMirror(message(),sender())).ok,true);
  assert.equal((await f.auth.handleMirror(message(),sender())).ok,false);
  assert.equal((await f.auth.handleMirror(message(token(),2,0),sender())).ok,false);
  f.frames.set(2,{documentId:'doc2',url:'https://fomo.family/'});
  assert.equal((await f.auth.handleMirror(message(),sender(2,'doc2'))).ok,false);
  f.frames.delete(1); assert.equal((await f.auth.handleMirror(message(),sender(2,'doc2'))).ok,true);
  assert.equal(f.calls.length,0);
});
await test('authoritative absence revokes still-valid token, restart cannot resurrect',async()=>{
  const f=fixture(); await f.auth.handleMirror(message(),sender()); assert(await f.auth.getSession());
  assert.equal((await f.auth.handleMirror({type:'fomo-auth-mirror-v1',status:'absent',seq:2,epoch:2},sender())).ok,true);
  assert.equal(await f.auth.getSession(),null); assert.equal(f.shared.local.fomoToken,undefined);
  f.shared.local.fomoToken={token:token()}; const restarted=fixture(f.shared);
  assert.equal(await restarted.auth.getSession(),null);
  assert.equal((await restarted.auth.handleMirror(message(token(),3,3),sender())).ok,false);
  await restarted.auth.observeAccount('fomo-a'); assert.equal(await restarted.auth.getSession(),null);
  assert.equal((await restarted.auth.handleMirror(message(token(),3,3),sender())).ok,true); assert(await restarted.auth.getSession());
});
await test('logout during pending local read and pending sender validation',async()=>{
  const f=fixture(); await f.auth.getSession(); const d=deferred(); f.hooks.localGet=()=>d.promise;
  const reading=f.auth.getSession(); await tick(); const logout=f.auth.revoke(); d.resolve();
  assert.equal(await reading,null); await logout; assert.equal(await f.auth.getSession(),null);
  const f2=fixture(), gate=deferred(); f2.hooks.tabs=()=>gate.promise;
  const mirroring=f2.auth.handleMirror(message(),sender()); await tick(); const out=f2.auth.revoke(); gate.resolve();
  assert.equal((await mirroring).ok,false); await out; assert.equal(f2.shared.local.fomoToken,undefined);
});
await test('logout during pending mirror write serialized cleanup survives restart',async()=>{
  const f=fixture(),d=deferred(); let writing=false;
  f.hooks.localSet=async()=>{writing=true; await d.promise;};
  const p=f.auth.handleMirror(message(token('did:privy:a',7200)),sender());
  for(let i=0;i<20&&!writing;i++) await tick(); assert(writing);
  const out=f.auth.revoke(); d.resolve(); assert.equal((await p).ok,false); await out;
  assert.equal(f.shared.local.fomoToken,undefined); const restarted=fixture(f.shared); assert.equal(await restarted.auth.getSession(),null);
});
await test('logout pending hydration cannot restore state',async()=>{
  const f=fixture(); await f.auth.handleMirror(message(),sender());
  // Create with a delayed storage read, not a post-construction hook.
  const d=deferred(), sandbox={URL,AbortController,atob,setTimeout,clearTimeout}; vm.createContext(sandbox); vm.runInContext(source,sandbox);
  const c={runtime:{id:'extension'},storage:{session:{get:async()=>{const v=structuredClone(f.shared.session); await d.promise; return v;},set:async v=>Object.assign(f.shared.session,v)},local:{remove:async()=>delete f.shared.local.fomoToken}}};
  const a=sandbox.gdhCreateTrendingSession({chrome:c,fetch:()=>{throw Error('unexpected network');}});
  const p=a.revoke(); d.resolve(); await p; assert.equal(await a.getSession(),null); assert.equal(f.shared.session.gdhTrendingAuthV1.revoked,true);
});
await test('generation and expiry guards extend through delayed response body',async()=>{
  for(const action of ['logout','account','expiry','rotation']) {
    const f=fixture(),d=deferred(); let body=false;
    f.hooks.fetch=async()=>({ok:true,status:200,json:async()=>{body=true; return d.promise;}});
    const p=f.auth.getSession(); for(let i=0;i<20&&!body;i++) await tick(); assert(body);
    if(action==='logout') await f.auth.revoke();
    if(action==='account') await f.auth.observeAccount('fomo-b');
    if(action==='expiry') f.setClock(NOW+3600000);
    if(action==='rotation') f.shared.local.fomoToken={token:token('did:privy:a',7200)};
    d.resolve({responseObject:{id:'fomo-a',isRestricted:false}}); assert.equal(await p,null);
  }
});
await test('stalled body has deadline, bounded negative cache, no retry loop',async()=>{
  const f=fixture(); f.hooks.fetch=async()=>({ok:true,status:200,json:()=>new Promise(()=>{})});
  assert.equal(await f.auth.getSession(),null); assert.equal(f.calls[0].init.signal.aborted,true);
  assert.equal(await f.auth.getSession(),null); assert.equal(f.calls.length,1); assert.equal(f.logs.length,0);
});
function mirrorFixture(entries) {
  const values={...entries}, messages=[], listeners={}, callbacks=[], intervals=[];
  const localStorage={getItem:k=>values[k]??null}; for(const k of Object.keys(values)) Object.defineProperty(localStorage,k,{enumerable:true,configurable:true,get:()=>values[k]});
  const window={localStorage,setInterval:fn=>intervals.push(fn),addEventListener:(n,fn)=>listeners[n]=fn}; window.top=window;
  const context={window,location:{hostname:'fomo.family',protocol:'https:',search:''},document:{visibilityState:'hidden',addEventListener(){}},URLSearchParams,atob,Date:class extends Date {static now(){return NOW;}},chrome:{runtime:{sendMessage(m,cb){messages.push(m); if(m.type==='fomo-auth-mirror-v1') callbacks.push(cb); else cb();}}},console:{log(){throw Error('secret log');}}};
  vm.runInNewContext(content,context);
  return {values,messages,listeners,callbacks,intervals};
}
await test('production content rejects ambiguous subjects, invalid JWT, expiration and absence',async()=>{
  for(const [entries,status] of [[{},'absent'],[{'privy:token':'bad'},'invalid'],[{'privy:token':token('a',-1)},'absent'],[{'privy:a:token':token('a',7200),'privy:b:token':token('b',1200)},'ambiguous']]) {
    const f=mirrorFixture(entries); const m=f.messages.find(m=>m.type==='fomo-auth-mirror-v1'); assert.equal(m.status,status); assert.equal(m.token,undefined);
  }
  const f=mirrorFixture({'privy:a:token':token('a',7200),'privy:b:token':token('a',1200),'privy:a:refresh_token':'unchanged-refresh'});
  const m=f.messages[0]; assert.equal(m.token,token('a',7200)); assert.equal(m.refresh,'unchanged-refresh');
});
await test('production content serializes per-document mirror and sends live logout',async()=>{
  const f=mirrorFixture({'privy:token':token()}); delete f.values['privy:token']; f.listeners.storage();
  assert.equal(f.messages.filter(m=>m.type==='fomo-auth-mirror-v1').length,1);
  f.callbacks.shift()(); const messages=f.messages.filter(m=>m.type==='fomo-auth-mirror-v1');
  assert.equal(messages.length,2); assert.equal(messages[1].status,'absent'); assert(messages[1].seq>messages[0].seq); assert(messages[1].epoch>messages[0].epoch);
  assert(!source.includes('refresh_token')); assert(!/tabs\.(create|update|reload)|new WebSocket|setInterval/.test(source));
});
await test('logout rearm requires new document epoch, not a late old-token message',async()=>{
  const f=fixture(); await f.auth.handleMirror(message(),sender()); await f.auth.revoke(); await f.auth.observeAccount('fomo-a');
  assert.equal((await f.auth.handleMirror(message(token(),2,1),sender())).ok,false);
  assert.equal(await f.auth.getSession(),null);
  assert.equal((await f.auth.handleMirror(message(token(),3,2),sender())).ok,true);
  assert(await f.auth.getSession());
});
await test('queued content logout is not lost to a fast subsequent login',async()=>{
  const f=mirrorFixture({'privy:token':token()}); delete f.values['privy:token']; f.listeners.storage();
  f.values['privy:token']=token('did:privy:b',1200); f.listeners.storage();
  f.callbacks.shift()(); let msgs=f.messages.filter(m=>m.type==='fomo-auth-mirror-v1'); assert.equal(msgs[1].status,'absent');
  f.callbacks.shift()(); msgs=f.messages.filter(m=>m.type==='fomo-auth-mirror-v1'); assert.equal(msgs[2].token,token('did:privy:b',1200)); assert(msgs[2].epoch>msgs[1].epoch);
});
console.log(`PASS ${count} owned auth tests (synthetic/offline; no live calls)`);
