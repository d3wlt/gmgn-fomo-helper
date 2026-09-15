import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto as crypto} from 'node:crypto';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../fomo-trending-demand.js',import.meta.url),'utf8');
const event=()=>({listeners:new Set(),addListener(fn){this.listeners.add(fn);},removeListener(fn){this.listeners.delete(fn);},emit(...args){for(const fn of [...this.listeners])fn(...args);}});
const key='gdhTrendingSelectionV1',store={};
let enabled=true,failRead=false,delayRead=null,delayWrite=null,frameDoc=null,starts=0;
const chrome={runtime:{id:'fixture-extension',onConnect:event()},storage:{session:{
 async get(){if(failRead){failRead=false;throw Error('transient');}const copy=structuredClone(store);if(delayRead)await delayRead;return copy;},
 async set(value){if(delayWrite)await delayWrite;Object.assign(store,structuredClone(value));}
},local:{get:async()=>({enableFomoPanel:enabled})},onChanged:event()},tabs:{get:async()=>({url:'https://gmgn.ai/'}),onRemoved:event()},webNavigation:{getFrame:async({tabId})=>({url:'https://gmgn.ai/',documentId:frameDoc||'doc'+tabId})}};
function create(){const ctx=vm.createContext({URL,crypto,setTimeout,clearTimeout});vm.runInContext(source,ctx);return ctx.gdhCreateTrendingDemand({chrome,start:()=>starts++,stop(){},refresh(){},snapshot:()=>({})});}
const sender=id=>({id:chrome.runtime.id,tab:{id},frameId:0,documentId:'doc'+id,url:'https://gmgn.ai/'});
const get=(api,id=1,overrides={})=>api.handleSelection({action:'get'},{...sender(id),...overrides});
const set=(api,epoch,selected=true,id=1)=>api.handleSelection({action:'set',selected,epoch},sender(id));
let api=create();
let r=await get(api);assert.equal(r.ok,true);assert.equal(r.selected,false);
assert.equal((await set(api,r.epoch)).selected,true);assert.deepEqual(store[key].tabs,[1]);
assert.equal((await get(api,2)).selected,false,'selection is tab-scoped');
assert.equal(starts,0,'preference I/O never starts live collection');
api.shutdown();api=create();r=await get(api);assert.equal(r.selected,true,'worker restart restores extension-session preference');
assert.equal((await get(api,1,{documentId:'old'})).ok,false);
assert.equal((await get(api,1,{url:'https://evil.invalid/'})).ok,false);
assert.equal((await get(api,1,{frameId:1})).ok,false);
assert.equal((await get(api,1,{id:'other-extension'})).ok,false);
assert.equal((await set(api,'old-epoch')).ok,false);
assert.equal((await api.handleSelection({action:'set',epoch:r.epoch,selected:'yes'},sender(1))).ok,false);
frameDoc='replacement';assert.equal((await get(api)).ok,false);frameDoc=null;
// Epochs invalidate late old-account writes, and clear removes persisted selection.
const oldEpoch=r.epoch;await api.clearSelection();r=await get(api);assert.notEqual(r.epoch,oldEpoch);assert.equal(r.selected,false);
assert.equal((await set(api,oldEpoch)).ok,false);assert.deepEqual(store[key].tabs,[]);
await set(api,r.epoch);enabled=false;chrome.storage.onChanged.emit({enableFomoPanel:{newValue:false}},'local');
r=await get(api);assert.equal(r.selected,false);enabled=true;assert.equal((await get(api)).selected,false,'reenable cannot resurrect old preference');
await set(api,r.epoch);chrome.tabs.onRemoved.emit(1);assert.equal((await get(api)).selected,false,'closed tabs are removed');
// Delayed save cannot win over a reset queued while the write is in progress.
r=await get(api);let release;delayWrite=new Promise(resolve=>release=resolve);
const pending=set(api,r.epoch);await new Promise(resolve=>setImmediate(resolve));const clear=api.clearSelection();delayWrite=null;release();
assert.equal((await pending).ok,false);await clear;assert.equal((await get(api)).selected,false);assert.deepEqual(store[key].tabs,[]);
api.shutdown();failRead=true;api=create();assert.equal((await get(api)).ok,false);assert.equal((await get(api)).ok,true,'transient hydration failure is retryable');
api.shutdown();
// Clear during startup must discard hydrated old rows, not resurrect them.
store[key]={epoch:crypto.randomUUID(),tabs:[1]};delayRead=new Promise(resolve=>release=resolve);api=create();
const initial=get(api);await new Promise(resolve=>setImmediate(resolve));const invalidation=api.clearSelection();delayRead=null;release();
assert.equal((await initial).ok,false);await invalidation;assert.equal((await get(api)).selected,false);
api.shutdown();
// Clearing still overwrites an old record when its read fails.
store[key]={epoch:crypto.randomUUID(),tabs:[1]};failRead=true;api=create();await api.clearSelection();assert.deepEqual(store[key].tabs,[]);assert.equal((await get(api)).selected,false);api.shutdown();
assert.equal(chrome.tabs.onRemoved.listeners.size,0);assert.equal(chrome.storage.onChanged.listeners.size,0);assert.equal(starts,0);
console.log('PASS Trending selection: extension-only per-tab session persistence, restart, sender/document/epoch validation, account reset and delayed-write races, disable/close cleanup, transient storage recovery, zero live demand');
