// Synthetic trusted-event VM fixtures: actual MAIN -> isolated -> production worker.
// No live provider/browser claim. Website transport calls counted separately.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {harness} from './test-token-discovery-worker.mjs';
const src=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const A=i=>'0x'+i.toString(16).padStart(40,'0');
const row=i=>({token:{address:A(i),networkId:56,symbol:'T'+i,info:{totalSupply:'100'}},priceUSD:'2',change24:'-0.2'});
function fixture(late=false,initialView){
 const worker=harness(()=>{throw Error('helper fetch');});
 const listeners=new Map(),timers=new Map(),events=[];let id=0,websiteFetch=0,sends=0,constructs=0, accountId='a', status=200;
 const add=(kind,fn)=>{if(!listeners.has(kind))listeners.set(kind,[]);listeners.get(kind).push(fn);};
 const dispatch=(kind,event)=>{for(const fn of listeners.get(kind)||[])fn(event);};
 class Socket{constructor(url){this.url=url;this.readyState=1;this.listeners=new Map();constructs++;}addEventListener(k,f){this.listeners.set(k,f);}send(){sends++;}frame(payload,topic='56',trusted=true){this.listeners.get('message')({isTrusted:trusted,data:JSON.stringify({type:'data',topicType:'trending_tokens',topicId:topic,payload})});}close(){this.listeners.get('close')();}}
 class XHR{open(){}send(){throw Error('unexpected XHR');}}
 const w={addEventListener:add,postMessage(data){dispatch('message',{source:w,origin:'https://fomo.family',data});},WebSocket:Socket,
  fetch:async()=>{websiteFetch++;return new Response(JSON.stringify({success:true,responseObject:{id:accountId}}),{status});}};
 w.top=w;
 let view=initialView,viewChanged=null;
 if(initialView!==undefined)w.__gdhFomoNativeView={read:()=>view,observe(fn){viewChanged=fn;return()=>{viewChanged=null;};}};
 const ctx=vm.createContext({window:w,location:{origin:'https://fomo.family',href:'https://fomo.family/'},document:{visibilityState:'visible',addEventListener(){}},XMLHttpRequest:XHR,URL,Response,console,
  Date:worker.run('Date'),crypto:webcrypto,setTimeout(fn){const n=++id;timers.set(n,fn);return n;},clearTimeout(n){timers.delete(n);},setInterval(){},
  chrome:{runtime:{sendMessage:async msg=>{events.push(msg.data);const d=msg.data;return worker.passive(d.kind,d.seq,d.epoch,d.accountId,d);}}}});
 const isolated=()=>vm.runInContext(src('fomo-passive-content.js'),ctx);
 if(!late)isolated();vm.runInContext(src('fomo-passive.js'),ctx);
 const settle=async()=>{for(let i=0;i<25;i++)await new Promise(r=>setImmediate(r));};
 const flush=async()=>{for(const [n,fn] of [...timers]){timers.delete(n);fn();}await settle();};
 return {worker,w,events,isolated,flush,settle,ctx,setView(value){view=value;viewChanged?.();},counts:()=>({websiteFetch,sends,constructs}),account:async(next='a',code=200)=>{accountId=next;status=code;await w.fetch('https://prod-api.fomo.family/v2/users/current');await settle();}};
}
let f=fixture();assert.deepEqual(f.counts(),{websiteFetch:0,sends:0,constructs:0});
let socket=new f.w.WebSocket('wss://prod-api.fomo.family/ws');
socket.frame({kind:'update',tokenKey:A(1)+':56',index:0,update:row(1)});await f.account();await f.flush();
assert.equal((await f.worker.load()).ok,false,'snapshot required');
const rows=Array.from({length:150},(_,i)=>row(i+1));socket.frame({kind:'snapshot',tokens:rows});await f.flush();
let data=await f.worker.load();assert.equal(data.items.length,100);assert.equal(data.items[0].marketCap,200);assert.equal(data.items[0].change24Percent,-20);
const reference=rows.map(r=>r.token.address);
function delta(kind,i,index){const key=A(i);const old=reference.indexOf(key);if(old>=0)reference.splice(old,1);if(kind!=='remove')reference.splice(index,0,key);socket.frame({kind,tokenKey:key+':56',index,update:row(i)});}
delta('update',150,0);delta('remove',1);delta('new',151,4);delta('update',3,99);
for(let i=0;i<100;i++)delta('update',150,i%10);
assert.ok(f.events.filter(e=>e.kind==='trending').length<=2,'burst coalesced before timer');await f.flush();
assert.deepEqual(JSON.parse(JSON.stringify((await f.worker.load()).items.map(r=>r.address))),reference.slice(0,100),'native Wp ordering top100');
socket.frame({kind:'update',tokenKey:A(151)+':56',index:900,update:row(151)});await f.flush();assert.equal((await f.worker.load()).ok,false);
socket.frame({kind:'update',tokenKey:A(151)+':56',index:0,update:row(151)});await f.flush();assert.equal((await f.worker.load()).ok,false);
socket.frame({kind:'snapshot',tokens:[row(1)]});await f.flush();assert.equal((await f.worker.load()).ok,true);
for(const tokens of [[row(1),row(1)],[{token:{address:'bad',networkId:56}}],Array.from({length:1001},()=>row(1))]){socket.frame({kind:'snapshot',tokens});await f.flush();assert.equal((await f.worker.load()).ok,false);}
socket.frame({kind:'snapshot',tokens:[row(1)]},'56',false);await f.flush();assert.equal((await f.worker.load()).ok,false,'untrusted ignored');
socket.frame({kind:'snapshot',tokens:[row(1)]});await f.flush();socket.close();await f.flush();assert.equal((await f.worker.load()).ok,false,'close clears');
socket=new f.w.WebSocket('wss://prod-api.fomo.family/ws');
const sol='So11111111111111111111111111111111111111112';
socket.frame({kind:'snapshot',tokens:[{token:{address:sol,networkId:1399811149}}]},'1399811149');await f.flush();
data=await f.worker.load();assert.equal(data.items[0].address,sol);assert.equal(data.items[0].symbol,'');
assert.equal(data.items[0].price,null);assert.equal(data.items[0].marketCap,null);assert.equal(data.items[0].change24Percent,null);
socket.listeners.get('error')();await f.flush();assert.equal((await f.worker.load()).ok,false,'socket error clears');
assert.equal(f.worker.calls.length,0);assert.deepEqual(f.counts(),{websiteFetch:1,sends:0,constructs:2});
// Native hidden suspension acknowledges unsubscribe after 3 seconds, keeping token lists.
const control=(s,type,topic='56')=>s.listeners.get('message')({isTrusted:true,data:JSON.stringify({type,topicType:'trending_tokens',topicId:topic})});
f=fixture();socket=new f.w.WebSocket('wss://prod-api.fomo.family/ws');await f.account();
for(let cycle=0;cycle<3;cycle++){
 socket.frame({kind:'snapshot',tokens:[row(7)]});await f.flush();
 const before=await f.worker.load();f.ctx.document.visibilityState='hidden';f.worker.tick(3000);
 control(socket,'unsubscribed');await f.flush();data=await f.worker.load();
 assert.equal(data.ok,true,'background unsubscribe must retain the validated snapshot');
 assert.equal(data.fetchedAt,before.fetchedAt,'unsubscribe cannot renew freshness');
 assert.equal(data.items[0].address,A(7));
 f.ctx.document.visibilityState='visible';control(socket,'subscribed');await f.flush();
 assert.equal((await f.worker.load()).fetchedAt,before.fetchedAt,'resubscription alone cannot renew freshness');
}
control(socket,'unsubscribed');await f.flush();socket.close();await f.flush();
assert.equal((await f.worker.load()).ok,true,'suspended close retains bounded snapshot');
socket=new f.w.WebSocket('wss://prod-api.fomo.family/ws');
socket.frame({kind:'update',tokenKey:A(8)+':56',index:0,update:row(8)});await f.flush();
assert.equal((await f.worker.load()).items[0].address,A(7),'successor socket requires snapshot');
f.worker.tick(300000);assert.equal((await f.worker.load()).ok,false,'suspension does not defeat TTL');
assert.equal(f.worker.calls.length,0);assert.equal(f.counts().sends,0);
// Native data before account and isolated-listener lateness, replay only existing memory.
f=fixture(true);socket=new f.w.WebSocket('wss://prod-api.fomo.family/ws');socket.frame({kind:'snapshot',tokens:[row(2)]});await f.account();await f.flush();f.isolated();await f.flush();assert.equal((await f.worker.load()).items[0].address,A(2));
// Account switch is native-observed; old socket/frames cannot populate its successor.
await f.account('b');await f.flush();assert.equal((await f.worker.load()).ok,false);
socket.frame({kind:'snapshot',tokens:[row(3)]});await f.flush();assert.equal((await f.worker.load()).ok,false,'old socket epoch rejected');
socket=new f.w.WebSocket('wss://prod-api.fomo.family/ws');socket.frame({kind:'snapshot',tokens:[row(4)]});await f.flush();assert.equal((await f.worker.load()).items[0].address,A(4));
await f.account('b',401);await f.flush();assert.equal((await f.worker.load()).ok,false,'native unauthorized');
socket.frame({kind:'snapshot',tokens:[row(5)]});await f.flush();assert.equal((await f.worker.load()).ok,false,'post logout frames rejected');
assert.equal(f.worker.calls.length,0);assert.equal(f.counts().sends,0);
// Reader DTO contract integration; the separate reader suite verifies committed React resolution.
f=fixture(false,null);socket=new f.w.WebSocket('wss://prod-api.fomo.family/ws');await f.account();socket.frame({kind:'snapshot',tokens:[row(1),row(2),row(3)]});await f.flush();
const descriptor=i=>({key:A(i)+':56',address:A(i),networkId:56,snapshot:null});
const view={hiddenFilters:true,hoverFreeze:true,items:[descriptor(3),descriptor(1)],prices:[{...descriptor(3),price:7,totalSupply:100,change24Percent:-4,chartOverride:true}]};
const observedAt=(await f.worker.load()).fetchedAt;f.setView(view);await f.flush();data=await f.worker.load();
assert.equal(data.viewMode,'native-view');assert.equal(data.nativeHiddenFilters,true);assert.equal(data.nativeHoverFreeze,true);assert.equal(data.nativePriceRows,1);assert.equal(data.nativeChartOverrides,1);
assert.deepEqual(JSON.parse(JSON.stringify(data.items.map(r=>r.address))),[A(3),A(1)]);assert.equal(data.items[0].price,7);assert.equal(data.items[0].marketCap,700);assert.equal(data.items[0].priceSource,'native-chart');
f.worker.tick(100);f.setView({...view,prices:[]});await f.flush();data=await f.worker.load();assert.equal(data.items[0].price,2);assert.equal(data.nativeChartOverrides,0);assert.equal(data.fetchedAt,observedAt,'view changes do not revive stale stream age');
f.setView({...view,items:[{...descriptor(2),snapshot:{price:4,totalSupply:10,change24Percent:12,symbol:'FROZEN',name:'Frozen Token'}},descriptor(1)],prices:[]});
socket.frame({kind:'remove',tokenKey:A(2)+':56'});await f.flush();data=await f.worker.load();assert.equal(data.items[0].address,A(2));assert.equal(data.items[0].marketCap,40);assert.equal(data.items[0].priceSource,'native-frozen','removed frozen fallback retained from validated snapshot descriptor');
f.setView({...view,items:[descriptor(999)],prices:[]});await f.flush();data=await f.worker.load();assert.equal(data.viewMode,'stream');assert.equal(data.nativeHiddenFilters,false);assert.equal(data.nativePriceRows,0,'invalid native view falls back explicitly and loses overlays');
f.setView({...view,prices:[{...view.prices[0],price:-1,totalSupply:null}]});await f.flush();data=await f.worker.load();assert.equal(data.items[0].price,null);assert.equal(data.items[0].marketCap,null);
f.setView(null);await f.flush();assert.equal((await f.worker.load()).viewMode,'stream');assert.equal(f.worker.calls.length,0);assert.deepEqual(f.counts(),{websiteFetch:1,sends:0,constructs:1});
console.log('PASS production MAIN + isolated + worker: native stream order/bounds/epochs, native-view DTO ordering, mounted chart prices, frozen fallback, overlay replacement, explicit stream fallback, zero helper fetch/socket/send.');
