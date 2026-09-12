import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../content.js',import.meta.url),'utf8');
const loader=source.slice(source.indexOf('  let fomoFollowedHoldersContextInvalidated'),source.indexOf('  function getMarkedHolders()'));
function fixture(send){
 const c=vm.createContext({send,Promise,Map,Set,Date,calls:0,scans:0,chain:'eth'});
 vm.runInContext(`const FOMO_NETWORK_ID={eth:1,bsc:56}; const FOMO_FOLLOWED_HOLDERS_TTL=10000,FOMO_FOLLOWED_HOLDERS_RETRY_MIN=1,FOMO_FOLLOWED_HOLDERS_RETRY_MAX=100;
 const fomoFollowedHoldersFailures=new Map(),fomoFollowedHoldersByChain=new Map(),fomoFollowedHoldersInflight=new Map();let fomoFollowedHoldersGeneration=0;
 const currentTokenRoute=()=>({chain}),settings={},document={visibilityState:'visible'};
 const currentChain=()=>chain,visibleFomoTokenRefs=()=>[{address:'0x1111111111111111111111111111111111111111'}],normalizeFomoTokenAddress=x=>x,scheduleScan=()=>scans++;
 const chrome={runtime:{sendMessage:()=>{calls++;return send(chain)}}};
 ${loader}
 globalThis.load=loadFomoFollowedHoldings;globalThis.state=()=>({dead:fomoFollowedHoldersContextInvalidated,inflight:fomoFollowedHoldersInflight.size,failures:fomoFollowedHoldersFailures.size,cache:fomoFollowedHoldersByChain.size});globalThis.retry=()=>fomoFollowedHoldersFailures.clear();`,c);return c;
}
for(const send of [()=>{throw new Error('Extension context invalidated.')},()=>Promise.reject(new Error('Extension context invalidated.'))]){
 const c=fixture(send);await c.load();await c.load();assert.equal(c.calls,1);assert.equal(c.state().dead,true);assert.equal(c.state().inflight,0);assert.equal(c.state().failures,0);
}
let attempts=0;const transient=fixture(()=>{if(!attempts++)throw new Error('Temporary worker failure');return Promise.resolve({ok:true,holdings:[]})});
await transient.load();assert.equal(transient.state().dead,false);assert.equal(transient.state().failures,1);transient.retry();await transient.load();assert.equal(transient.calls,2);assert.equal(transient.state().cache,1);
let release;const racing=fixture(chain=>chain==='eth'?new Promise(r=>release=r):Promise.reject(new Error('Extension context invalidated.')));
const first=racing.load();await Promise.resolve();racing.chain='bsc';await racing.load();release({ok:true,holdings:[]});await first;assert.equal(racing.state().cache,0);assert.equal(racing.scans,0);assert.equal(racing.state().inflight,0);
const fresh=fixture(()=>Promise.resolve({ok:true,holdings:[]}));await Promise.all([fresh.load(),fresh.load()]);assert.equal(fresh.calls,1);assert.equal(fresh.state().cache,1);
console.log('PASS production holder loader: synchronous invalidation, rejected invalidation, no repeat sends, transient retry, stale in-flight suppression, fresh-page recovery and coalescing.');
