import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const content=fs.readFileSync(new URL('../content.js',import.meta.url),'utf8'),bridge=fs.readFileSync(new URL('../page-bridge.js',import.meta.url),'utf8');
const calls=[];let fail=false;
const c=vm.createContext({console,Map,Set,Date,AbortController,fetch:async url=>{calls.push(url);return {ok:!fail,json:async()=>({code:fail?1:0,data:{creator_ath_info:{ath_mc:url.includes('/robinhood/')?200:100,token_symbol:'TEST'}}})}}});
vm.runInContext(`const settings={showDevPerformance:true};const window={setTimeout:()=>1,clearTimeout:()=>{}};const scheduleScan=()=>{};const setBoundedMap=(m,k,v)=>m.set(k,v);
${content.slice(content.indexOf('  const DEV_ATH_TTL_MS'),content.indexOf('  function formatAthMc'))}
globalThis.api={getDevAth,processDevAthQueue,devIdentity,cache:devAthCache,queue:devAthQueue};
${bridge.slice(bridge.indexOf('  const ADDRESS_RE'),bridge.indexOf('  function searchProps'))}
globalThis.parse={normalizeDevAddress,toTokenData,getCardAddress};`,c);
const evm='0x1111111111111111111111111111111111111111',sol='F8ttwMWpSiwRxd9d7U7kk4e1MF8aCgKxQAVLdvAD3tEC';
for(const chain of ['bsc','robinhood','sol']){
 const addr=chain==='sol'?sol:evm;
 assert.equal(c.api.getDevAth(addr,chain),null);await c.api.processDevAthQueue();
 assert.ok(calls.at(-1).includes(`/dev_created_tokens/${chain}/${addr}?`));
 assert.equal(c.api.getDevAth(addr,chain).mc,chain==='robinhood'?200:100);
 assert.equal(c.parse.getCardAddress({getAttribute:k=>k==='href'?`/${chain}/token/${addr}`:null}),addr);
 const parsed=c.parse.toTokenData({address:addr,creator:addr,creator_created_count:5,creator_created_open_count:2},addr);
 assert.equal(parsed.creator,addr);assert.equal(parsed.total,5);assert.equal(parsed.migrated,2);
}
assert.equal(c.api.cache.size,3,'same EVM creator on BSC and RH must be separate');
assert.notEqual(c.api.devIdentity(sol,'sol').key,c.api.devIdentity(sol.toLowerCase(),'sol')?.key,'Solana case retained');
assert.equal(c.api.getDevAth(evm,'sol'),null);assert.equal(c.api.getDevAth(sol,'bsc'),null);assert.equal(c.api.getDevAth(evm,'eth'),null);
assert.equal(c.parse.toTokenData({address:sol.toLowerCase(),creator:sol},sol),null,'wrong-case SOL token rejected');
const missing=c.parse.toTokenData({address:sol,creator:sol},sol);assert.equal(missing.total,undefined);assert.equal(missing.migrated,undefined);
fail=true;const other='0x2222222222222222222222222222222222222222';c.api.getDevAth(other,'robinhood');await c.api.processDevAthQueue();assert.equal(c.api.getDevAth(other,'robinhood'),null,'failed RH lookup cannot borrow BSC ATH');
console.log('PASS production dev stats: BSC/RH/SOL routes, exact Solana case, chain-separated cache, counts/missing values and failed-lookup isolation.');
