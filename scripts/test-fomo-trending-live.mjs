// Deterministic real-source VM tests. No network, credentials, worker reload or storage.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../fomo-trending-live.js',import.meta.url),'utf8');
const TOPIC = '56,143,4663,8453,1399811149';
const A = i => '0x'+i.toString(16).padStart(40,'0');
const row = (i,n=56) => ({token:{address:A(i),networkId:n,symbol:'T'+i,name:'Token',info:{totalSupply:'100'}},priceUSD:'2',change24:'-.2'});
const key = (i,n=56) => `${A(i)}:${n}`;
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };
const settle = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function fixture(initialTime=1000000,jitter=0) {
  let time=initialTime, tid=0, calls=0, getter=null;
  const timers=new Map(), sockets=[], updates=[];
  let session={token:'SECRET-JWT',expiresAt:time+3600000,sessionKey:'account-a'};
  class MockWS {
    constructor(url) { this.url=url; this.readyState=0; this.handlers={}; this.sent=[]; sockets.push(this); }
    addEventListener(type,fn) { (this.handlers[type] ||= []).push(fn); }
    emit(type,event={}) { for (const fn of this.handlers[type] || []) fn(event); }
    open() { this.readyState=1; this.emit('open'); }
    send(value) { assert.equal(this.readyState,1); this.sent.push(JSON.parse(value)); }
    close() { this.readyState=3; this.emit('close',{code:1000}); }
    frame(m) { this.emit('message',{data:JSON.stringify(m)}); }
    payload(payload,topicId=TOPIC) { this.frame({type:'data',topicType:'trending_tokens',topicId,payload}); }
    full(tokens=[row(1)]) { this.payload({kind:'snapshot',tokens}); }
    delta(kind,i,index,update=row(i)) { this.payload({kind,tokenKey:key(i),index,update}); }
  }
  const context=vm.createContext({}); vm.runInContext(source,context);
  const api=context.gdhCreateTrendingLive({getSession:async()=>{ calls++; return getter ? getter() : session; },onUpdate:s=>updates.push(s),WebSocket:MockWS,now:()=>time,random:()=>jitter,
    setTimeout(fn,ms) { const id=++tid; timers.set(id,{at:time+ms,fn}); return id; },clearTimeout:id=>timers.delete(id)});
  async function tick(ms) { const end=time+ms; for (;;) { const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0]; if (!next) break; time=next[1].at; timers.delete(next[0]); next[1].fn(); await settle(); } time=end; await settle(); }
  async function open() { api.start(); await settle(); const s=sockets.at(-1); s.open(); await settle(); return s; }
  async function auth(s) { s.frame({type:'challenge'}); await settle(); s.frame({type:'challengeAccepted'}); }
  return {api,context,sockets,updates,timers,tick,open,auth,get calls(){return calls;},get time(){return time;},set session(v){session=v;},set getter(v){getter=v;}};
}
const tests=[]; const test=(name,fn)=>tests.push([name,fn]);
test('immutable classic global, start deduplication, auth and snapshot gate',async()=>{
  const f=fixture(); assert.ok(Object.isFrozen(f.api)); assert.ok(Object.isFrozen(f.context.gdhCreateTrendingLive));
  assert.equal(Object.getOwnPropertyDescriptor(f.context,'gdhCreateTrendingLive').writable,false);
  f.api.start(); f.api.start(); await settle(); assert.equal(f.sockets.length,1); assert.equal(f.calls,1);
  const s=f.sockets[0]; assert.equal(s.url,'wss://prod-api.fomo.family/ws'); s.open(); await settle();
  assert.equal(s.sent[0].jwt,'SECRET-JWT'); await f.auth(s);
  assert.deepEqual(s.sent.map(v=>v.type),['challengeResponse','challengeResponse','subscribe']);
  assert.deepEqual(s.sent[2],{type:'subscribe',topicType:'trending_tokens',topicId:TOPIC});
  s.frame({type:'subscribed',topicType:'trending_tokens',topicId:TOPIC}); assert.equal(f.api.getSnapshot().ok,false);
  s.full(); const snap=f.api.getSnapshot(); assert.equal(snap.ok,true); assert.equal(snap.items[0].marketCap,200); assert.equal(snap.items[0].change24Percent,-20);
  assert.equal(snap.items[0].rank,1); assert.ok(Object.isFrozen(snap.items[0]));
});
test('preauth snapshot and delta without baseline rejected',async()=>{
  for (const preauth of [true,false]) { const f=fixture(),s=await f.open(); if (!preauth) await f.auth(s);
    if (preauth) s.full(); else s.delta('update',1,0);
    assert.equal(f.api.getSnapshot().ok,false); assert.equal(s.readyState,3); assert.equal(f.api.getSnapshot().items.length,0);
  }
});
test('native replacement, clamped integer ordering and absent remove',async()=>{
  const f=fixture(),s=await f.open(); await f.auth(s); s.full([row(1),row(2),row(3)]);
  s.delta('update',2,-9,{token:{address:A(2),networkId:56}});
  assert.equal(f.api.getSnapshot().items[0].price,null); assert.equal(f.api.getSnapshot().items[0].name,'');
  s.delta('new',1,999); s.delta('new',4,1); s.delta('remove',999);
  assert.deepEqual(Array.from(f.api.getSnapshot().items,r=>r.address),[A(2),A(4),A(3),A(1)]);
  s.full([row(3),row(1)]); assert.deepEqual(Array.from(f.api.getSnapshot().items,r=>r.address),[A(3),A(1)]);
  s.delta('update',1,0.5); assert.equal(f.api.getSnapshot().status,'reconnecting'); assert.equal(f.api.getSnapshot().items.length,0);
});
test('strict identity, key, topic, duplicate and bound validation',async()=>{
  const bad=[
    s=>s.full([{token:{address:'bad',networkId:56}}]),
    s=>s.full([row(1,1)]),s=>s.full([row(1,'056')]),s=>s.full([row(1),row(1)]),
    s=>s.full([row(10),{...row(10),token:{...row(10).token,address:A(10).toUpperCase().replace('0X','0x')}}]),
    s=>s.full(Array.from({length:1001},(_,i)=>row(i))),
    s=>s.payload({kind:'snapshot',tokens:[]},'56'),
    s=>s.payload({kind:'remove',tokenKey:'garbage'}),
    s=>s.payload({kind:'update',tokenKey:key(1),update:row(2),index:0}),
    s=>s.payload({kind:'other'}),s=>s.payload(null),s=>s.emit('message',{data:'{'}),
    s=>s.full([{...row(1),tokenKey:key(2)}]),s=>s.payload({kind:'remove',tokenKey:`${A(1)}:056`})
  ];
  for (const invalid of bad) { const f=fixture(),s=await f.open(); await f.auth(s); s.full(); invalid(s);
    assert.equal(s.readyState,3); assert.equal(f.api.getSnapshot().items.length,0); }
  const f=fixture(),s=await f.open(); await f.auth(s); s.full(Array.from({length:1000},(_,i)=>row(i+1)));
  assert.equal(f.api.getSnapshot().items.length,100); s.delta('update',1000,-1); assert.equal(f.api.getSnapshot().items[0].address,A(1000));
  s.delta('new',1001,0); assert.equal(s.readyState,3);
});
test('SOL case preserved, same CA separate chains, unknown metrics null',async()=>{
  const f=fixture(),s=await f.open(); await f.auth(s);
  const sol='So11111111111111111111111111111111111111112';
  s.full([row(1,56),row(1,8453),{token:{address:sol,networkId:1399811149},priceUSD:'bad',change24:true}]);
  const items=f.api.getSnapshot().items; assert.equal(items.length,3); assert.equal(items[2].address,sol);
  for (const field of ['price','marketCap','change24Percent']) assert.equal(items[2][field],null);
  s.payload({kind:'remove',tokenKey:`${sol.toLowerCase()}:1399811149`}); assert.equal(f.api.getSnapshot().items.length,3);
});
test('coalescing newest state and stop cancels every callback/socket',async()=>{
  const f=fixture(),s=await f.open(); await f.auth(s); s.full();
  for(let i=2;i<50;i++) s.delta('update',i,0);
  assert.equal(f.updates.length,0); await f.tick(250); assert.equal(f.updates.length,1); assert.equal(f.updates[0].items[0].address,A(49));
  f.api.stop(); assert.equal(f.timers.size,0); assert.equal(s.readyState,3); assert.equal(f.api.getSnapshot().items.length,0);
  const count=f.updates.length; s.full(); s.frame({type:'challengeAccepted'}); f.api.refresh(); await f.tick(1000000);
  assert.equal(f.updates.length,count); assert.equal(f.sockets.length,1);
});
test('pending session results after stop, refresh and challenge races ignored',async()=>{
  const f=fixture(),pending=deferred(); f.getter=()=>pending.promise; f.api.start(); f.api.stop();
  pending.resolve({token:'OLD',expiresAt:f.time+100000,sessionKey:'a'}); await settle(); assert.equal(f.sockets.length,0);
  const g=fixture(),s=await g.open(),p=deferred(); g.getter=()=>p.promise;
  s.frame({type:'challenge'}); g.api.refresh(); g.api.stop(); p.resolve({token:'OLD',expiresAt:g.time+100000,sessionKey:'a'}); await settle();
  assert.equal(s.sent.length,1); assert.equal(g.sockets.length,1); assert.equal(g.timers.size,0);
});
test('expiry blocks transmission and invalid sessions fail closed',async()=>{
  for (const session of [null,{token:'x',sessionKey:'a',expiresAt:1},{token:'',sessionKey:'a',expiresAt:9999999}]) {
    const f=fixture(); f.session=session; f.api.start(); await settle(); assert.equal(f.sockets.length,0); assert.equal(f.api.getSnapshot().status,'not-connected'); assert.equal(f.timers.size,0);
  }
  const f=fixture(); f.session={token:'EXPIRING',sessionKey:'a',expiresAt:f.time+500}; const s=await f.open(); await f.auth(s); s.full();
  await f.tick(500); assert.equal(f.api.getSnapshot().items.length,0); assert.equal(s.readyState,3);
  const sends=s.sent.length; s.frame({type:'challenge'}); await settle(); assert.equal(s.sent.length,sends);
});
test('session change clears old baseline and never transmits new identity on old socket',async()=>{
  const f=fixture(),s=await f.open();
  f.session={token:'NEW-TOKEN',sessionKey:'account-b',expiresAt:f.time+100000};
  s.frame({type:'challenge'}); await settle(); assert.equal(s.readyState,3); assert.equal(s.sent.length,1); assert.equal(f.sockets.length,2);
  const next=f.sockets[1]; next.open(); await settle(); assert.equal(next.sent[0].jwt,'NEW-TOKEN'); await f.auth(next); next.full([row(2)]);
  s.full([row(1)]); assert.equal(f.api.getSnapshot().items[0].address,A(2));
  f.session={token:'THIRD',sessionKey:'account-c',expiresAt:f.time+100000}; f.api.refresh(); await settle(); assert.equal(f.api.getSnapshot().items.length,0);
});
test('auth rejection and excessive challenges are terminal',async()=>{
  for (const type of ['challengeRejected','authenticationError','authError','unauthorized','error']) {
    const f=fixture(),s=await f.open(); s.frame({type}); await f.tick(1000000); assert.equal(f.sockets.length,1); assert.equal(f.api.getSnapshot().status,'error'); assert.equal(f.timers.size,0);
  }
  const f=fixture(),s=await f.open(); for(let i=0;i<4;i++){s.frame({type:'challenge'}); await settle();}
  assert.equal(s.sent.length,4); assert.equal(f.api.getSnapshot().status,'error');
});
test('transport retry backoff bounded at eight consecutive failures',async()=>{
  const f=fixture(); f.api.start(); await settle();
  const waits=[1000,2000,4000,8000,16000,30000,30000];
  for(let i=0;i<8;i++) { f.sockets.at(-1).emit('error'); if(i<7){const count=f.sockets.length; await f.tick(waits[i]-1); assert.equal(f.sockets.length,count); await f.tick(1); assert.equal(f.sockets.length,count+1);} }
  await f.tick(1000000); assert.equal(f.sockets.length,8); assert.equal(f.api.getSnapshot().status,'error');
});
test('auth and snapshot deadlines, reconnect recovery replaces baseline',async()=>{
  const f=fixture(); f.api.start(); await settle(); await f.tick(15000); assert.equal(f.sockets[0].readyState,3);
  await f.tick(1000); const s=f.sockets.at(-1); s.open(); await settle(); await f.auth(s); await f.tick(15000); assert.equal(s.readyState,3);
  await f.tick(2000); const next=f.sockets.at(-1); next.open(); await settle(); await f.auth(next); next.full([row(9)]); next.emit('error');
  assert.equal(f.api.getSnapshot().ok,false); assert.equal(f.api.getSnapshot().items[0].address,A(9));
  await f.tick(1000); const recovered=f.sockets.at(-1); recovered.open(); await settle(); await f.auth(recovered); recovered.full([row(2)]);
  assert.deepEqual(Array.from(f.api.getSnapshot().items,r=>r.address),[A(2)]); assert.equal(f.api.getSnapshot().ok,true);
});
test('stale reconnect retention expires, quiet live worker has no heartbeat',async()=>{
  const f=fixture(),s=await f.open(); await f.auth(s); s.full(); const sends=s.sent.length;
  await f.tick(600000); assert.equal(s.sent.length,sends); assert.equal(f.sockets.length,1); assert.equal(f.api.getSnapshot().ok,true); assert.equal(f.api.getSnapshot().items.length,1);
  // A freshly observed list can be retained, but never renewed by reconnect/acks.
  s.full(); const fetchedAt=f.api.getSnapshot().fetchedAt; s.emit('error'); await f.tick(299999);
  assert.equal(f.api.getSnapshot().fetchedAt,fetchedAt); assert.equal(f.api.getSnapshot().items.length,1);
  await f.tick(1); assert.equal(f.api.getSnapshot().items.length,0);
});
test('no token/session leakage in snapshots, updates or exception text',async()=>{
  const f=fixture(),s=await f.open(); await f.auth(s); s.full(); await f.tick(250);
  f.getter=()=>{throw Error('SECRET-JWT');}; f.api.refresh(); await settle();
  const output=JSON.stringify([f.api.getSnapshot(),f.updates]); assert.ok(!output.includes('SECRET-JWT')); assert.ok(!output.includes('account-a'));
  assert.equal(f.api.getSnapshot().status,'error');
});
test('late challenge checks session identity and expires pending credentials',async()=>{
  const f=fixture(),s=await f.open(); await f.auth(s); s.full();
  f.session={token:'NEW-AUTH',expiresAt:f.time+100000,sessionKey:'account-b'};
  const sends=s.sent.length; s.frame({type:'challenge'}); await settle();
  assert.equal(s.sent.length,sends); assert.equal(s.readyState,3); assert.equal(f.api.getSnapshot().items.length,0);
  const g=fixture(),old=await g.open(),p=deferred(); g.getter=()=>p.promise;
  old.frame({type:'challenge'}); await g.tick(1000); p.resolve({token:'EXPIRED',expiresAt:g.time,sessionKey:'account-a'}); await settle();
  assert.equal(old.sent.length,1); assert.equal(g.api.getSnapshot().status,'not-connected');
});
test('superseded challenge promise cannot send stale token',async()=>{
  const f=fixture(),s=await f.open(),a=deferred(),b=deferred(); let calls=0;
  f.getter=()=>++calls===1 ? a.promise : b.promise;
  s.frame({type:'challenge'}); s.frame({type:'challenge'});
  b.resolve({token:'LATEST',expiresAt:f.time+100000,sessionKey:'account-a'}); await settle();
  a.resolve({token:'STALE',expiresAt:f.time+100000,sessionKey:'account-a'}); await settle();
  assert.deepEqual(s.sent.map(x=>x.jwt),['SECRET-JWT','LATEST']); s.frame({type:'challengeAccepted'}); s.full(); assert.equal(f.api.getSnapshot().ok,true);
});
test('stop during pending handshake prevents automatic subscribe',async()=>{
  const f=fixture(),s=await f.open(),p=deferred(); f.getter=()=>p.promise;
  s.frame({type:'challenge'}); f.api.stop(); p.resolve({token:'DELAYED',expiresAt:f.time+100000,sessionKey:'account-a'}); await settle();
  s.frame({type:'challengeAccepted'}); s.full(); await f.tick(20000);
  assert.equal(s.sent.length,1); assert.equal(f.api.getSnapshot().items.length,0); assert.equal(f.timers.size,0);
});
test('zero clock baseline retention and bounded injected jitter',async()=>{
  const f=fixture(0,1),s=await f.open(); await f.auth(s); s.full(); s.emit('error');
  assert.equal(f.api.getSnapshot().items.length,1); await f.tick(1199); assert.equal(f.sockets.length,1);
  await f.tick(1); assert.equal(f.sockets.length,2); assert.equal(f.api.getSnapshot().items.length,1);
  f.api.stop();
});
for (const [name,fn] of tests) { await fn(); console.log('ok - '+name); }
console.log(`${tests.length} deterministic owned Trending tests passed`);
