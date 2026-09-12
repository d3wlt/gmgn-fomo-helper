#!/usr/bin/env node
// Offline behavioral tests: execute the complete production worker in an isolated VM.
// Offline provider-schema fixtures only; no authenticated requests, browser, or third-party packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const address = '0x1234567890123456789012345678901234567890';
const tradeId = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const token = (sub, exp = 9999999999) => ({ token: `test.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.fixture` });
const response = (responseObject, status = 200, headers = {}) => new Response(JSON.stringify({ statusCode: status, responseObject }), { status, headers });
const rawResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const event = (id, ts, userId = 'followed') => ({ id, ts, type: 'swap_buy', userId, tokenAddress: address, networkId: 56 });
const detail = (n, userId = 'followed') => ({
  trade: { id: tradeId(n), userId, networkId: 56 }, user: { id: userId },
  swaps: [{ id: `swap-${n}`, outTokenAddress: address, createdAt: '2026-09-01T10:00:00Z', humanUsdAmountIn: n }],
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(route, session = null) {
  let now = 1800000000000;
  const changed = [], messages = [], calls = [], removed = [], updated = [];
  const tabs = new Map([[1, {id:1,url:'https://fomo.family/'}], [2, {id:2,url:'https://fomo.family/'}]]);
  const pushes = [];
  const store = { fomoToken: token('account-a') };
  const ignore = { addListener() {} };
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({
    console, Date: Clock, URL, URLSearchParams, atob, btoa, AbortController, TextDecoder, TextEncoder, crypto: webcrypto,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    importScripts() {},
    fetch: async (url, options) => {
      const path = String(url).replace('https://prod-api.fomo.family', '');
      calls.push({ path, options });
      return route(path, options);
    },
    chrome: {
      tabs: { get:async id => { if (!tabs.has(id)) throw Error('closed'); return tabs.get(id); }, query:async()=>[{id:99}], sendMessage:async(id,message)=>pushes.push(message), onRemoved:{addListener:fn=>removed.push(fn)}, onUpdated:{addListener:fn=>updated.push(fn)} },
      runtime: { onInstalled: ignore, onStartup: ignore, onMessage: { addListener(fn) { messages.push(fn); } } },
      alarms: { get: async () => ({}), create() {}, onAlarm: ignore },
      storage: { session, local: { remove: async keys => { for (const key of [keys].flat()) delete store[key]; }, get: async () => ({ ...store }), set: async (data) => Object.assign(store, data) }, onChanged: { addListener(fn) { changed.push(fn); } } },
    },
  });
  vm.runInContext(source, ctx, { filename: 'background.js' });
  return {
    calls, ctx, pushes,
    passive: (data, sender = {tab:{id:1,url:'https://fomo.family/'},url:'https://fomo.family/',frameId:0,documentId:'doc-1'}) => new Promise(resolve => messages.forEach(fn=>fn({type:'fomo-passive-event',data},sender,resolve))),
    close: id => {tabs.delete(id);removed.forEach(fn=>fn(id));},
    navigate: id => updated.forEach(fn=>fn(id,{status:'loading'})),
    run: (code) => vm.runInContext(code, ctx),
    token: (kind = 'swaps') => vm.runInContext(`fomoFetchToken(${JSON.stringify({ tokenAddress: address, networkId: 56, kind })})`, ctx),
    // Reference-only collector regression coverage; runtime tests below exercise passive path.
    feed: () => vm.runInContext('legacyFetchFomoFollowedFeed()', ctx),
    tick: (ms = 16000) => { now += ms; },
    switchAccount(sub, exp) {
      const oldValue = store.fomoToken;
      store.fomoToken = sub === null ? undefined : token(sub, exp);
      changed.forEach((fn) => fn({ fomoToken: { oldValue, newValue: store.fomoToken } }, 'local'));
    },
    poll: () => new Promise((resolve) => messages.forEach((fn) => fn({ type: 'fomo-followed-feed' }, {}, resolve))),
  };
}

function tokenRoute({ failDetail = () => false, following = () => response({ followingIds: ['followed'] }), count = 2 } = {}) {
  return (path) => {
    if (path.includes('followingIds')) return following();
    if (path.startsWith('/feed/token')) return response({ items: [], hasNextPage: false });
    if (path.startsWith('/hodlers/top')) return response([{ totalHolders: count, topHolders: Array.from({ length: count }, (_, i) => ({ tradeId: tradeId(i + 1), user: { id: 'followed' } })) }]);
    if (path.startsWith('/trades/')) {
      const n = Number(path.slice(-12));
      return failDetail(n) ? response(null, 500) : response(detail(n));
    }
    throw new Error(`Unexpected fixture path ${path}`);
  };
}

async function seedFeed(h, rows = [event('checkpoint', 100, 'not-followed'), event('retained', 90)]) {
  h.ctx.seedRows = rows;
  const result = await h.feed();
  assert.equal(result.ok, true);
  h.tick();
  return result;
}

const passiveEnvelope = (kind, seq, extra = {}) => ({source:'gdh-fomo-passive-v1',bridgeId:'fixture-bridge-1',epoch:1,seq,accountId:'account-a',kind,...extra});
await test('PASSIVE actual runtime is zero-fetch; buffers roster, rejects unfollowed, canonical native fields and digest push', async () => {
  const h = harness(() => { throw Error('passive MUST NOT fetch'); });
  assert.equal((await h.poll()).passiveStatus,'waiting-for-fomo-tab');
  assert.equal((await h.passive(passiveEnvelope('account',1))).ok,true);
  await h.passive(passiveEnvelope('activity',2,{items:[{...event('native',1800000000000),swapId:'swap1',usdAmount:42,fdv:123,ticker:'REAL',authorization:'secret'},event('bad',1800000000000,'stranger')]}));
  assert.equal((await h.poll()).events.length,0);
  await h.passive(passiveEnvelope('following',3,{followingIds:['followed']}));
  const result = await h.poll();
  assert.equal(result.mode,'passive'); assert.equal(result.passiveStatus,'waiting-for-activity');
  assert.equal(result.connected,false,'REST/roster alone never asserts native subscription liveness');
  await h.passive(passiveEnvelope('connection',4,{connected:true}));
  assert.equal((await h.poll()).passiveStatus,'connected');
  assert.equal(result.events.length,1); assert.equal(result.events[0].usd,42); assert.equal(result.events[0].mc,123);
  assert.equal(result.events[0].symbol,'REAL'); assert.ok(!JSON.stringify(result).includes('secret'));
  await h.passive(passiveEnvelope('activity',5,{items:[{...event('native',1800000000000),swapId:'swap1',usdAmount:42,fdv:123,ticker:'REAL'}]}));
  assert.equal((await h.poll()).events.length,1);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(h.pushes.some(p=>p.type==='fomo-followed-feed-update' && p.data.events.length===1 && /^[a-f0-9]{64}$/.test(p.epoch)));
  await h.passive(passiveEnvelope('following',6,{followingIds:[]}));
  assert.equal((await h.poll()).events.length,0); assert.equal((await h.poll()).followingKnown,true);
  assert.equal(h.calls.length,0);
});
await test('PASSIVE spoofed sender, stale seq/epoch, logout, account switch, close and expiry isolation', async()=>{
  const h=harness(()=>{throw Error('no network');});
  for(const sender of [{}, {tab:{id:1,url:'https://evil.fomo.family/'},url:'https://evil.fomo.family/',frameId:0}, {tab:{id:1,url:'https://fomo.family/'},url:'https://fomo.family/',frameId:1}]) assert.equal((await h.passive(passiveEnvelope('account',1),sender)).ok,false);
  await h.passive(passiveEnvelope('account',1));
  await h.passive(passiveEnvelope('following',2,{followingIds:['followed']}));
  await h.passive(passiveEnvelope('activity',3,{items:[event('one',1800000000000)]}));
  assert.equal((await h.passive(passiveEnvelope('activity',3,{items:[]}))).ok,false);
  h.tick(61000); assert.equal((await h.poll()).passiveStatus,'disconnected');
  await h.passive(passiveEnvelope('connection',4,{connected:true}));
  await h.passive(passiveEnvelope('logout',5,{epoch:2,accountId:''}));
  assert.equal((await h.poll()).events.length,0);
  assert.equal((await h.passive(passiveEnvelope('account',6))).ok,false);
  assert.equal((await h.passive(passiveEnvelope('account',7,{epoch:3,accountId:'account-b'}))).ok,true);
  assert.equal((await h.poll()).events.length,0);
  assert.equal((await h.passive(passiveEnvelope('activity',8,{items:[event('late',1800000000000)]}))).ok,false);
  h.close(1); assert.equal((await h.poll()).passiveStatus,'disconnected');
  assert.equal((await h.passive(passiveEnvelope('account',9,{epoch:4}))).ok,false);
  assert.equal(h.calls.length,0);
  const restarted=harness(()=>{throw Error('restart no network');});
  assert.equal((await restarted.poll()).events.length,0); assert.equal((await restarted.poll()).passiveStatus,'waiting-for-fomo-tab');
});

await test('PASSIVE competing documents, storage logout, navigation and bounded payloads are fail-closed', async()=>{
  const h=harness(()=>{throw Error('no passive requests');});
  const sender2={tab:{id:2,url:'https://fomo.family/'},url:'https://fomo.family/',frameId:0,documentId:'doc-2'};
  const second=(kind,seq,extra={})=>passiveEnvelope(kind,seq,{bridgeId:'fixture-bridge-2',...extra});
  await h.passive(passiveEnvelope('account',1));
  assert.equal((await h.passive(second('account',1),sender2)).reason,'other-active-tab');
  await h.passive(passiveEnvelope('account',2,{epoch:2,accountId:'account-b'}));
  assert.equal((await h.passive(second('account',2),sender2)).reason,'stale-epoch');
  assert.equal((await h.passive(passiveEnvelope('activity',3,{epoch:2,accountId:'account-b',items:Array(101).fill(event('x',1))}))).reason,'invalid-items');
  assert.equal((await h.passive(passiveEnvelope('following',4,{epoch:2,accountId:'account-b',followingIds:Array(10001).fill('followed')}))).reason,'invalid-roster');
  assert.equal((await h.poll()).followingKnown,false);
  await h.passive(passiveEnvelope('following',5,{epoch:2,accountId:'account-b',followingIds:['followed']}));
  for(let batch=0;batch<6;batch++) await h.passive(passiveEnvelope('activity',6+batch,{epoch:2,accountId:'account-b',items:Array.from({length:100},(_,i)=>event(`event-${batch}-${i}`,1800000000000+i))}));
  assert.equal((await h.poll()).events.length,500);
  h.switchAccount(null);assert.equal((await h.poll()).events.length,0);
  assert.equal((await h.passive(passiveEnvelope('account',20,{epoch:2,accountId:'account-b'}))).ok,false);
  await h.passive(passiveEnvelope('account',21,{epoch:3,accountId:'account-c'}));
  h.navigate(1);assert.equal((await h.poll()).passiveStatus,'disconnected');
  assert.equal((await h.passive(passiveEnvelope('account',22,{epoch:3,accountId:'account-c'}))).ok,false);
  assert.equal(h.calls.length,0);
});

await test('bot body metadata preserves display name, image and USD without inventing empty ticker', () => {
  // Same shape as fomo-telegram-bot/test/fixtures/fomo-feed-empty-ticker.json,
  // with bot TokenMetadataClient's optional enrichment fields added.
  const h = harness(() => response([]));
  h.ctx.fixture = { id:'fixture', type:'thesis_created', createdAt:'2030-01-02T03:04:05.678Z', networkId:1399811149,
    tokenAddress:'GQ5PbKtQexgfoh5zEPdA7crHsgr8xLxbdkZc5wsmjQMS', body:{userId:'followed',ticker:'',displayName:'Real display',
      tokenName:'Full token name', tokenImageUrl:'https://example.test/token.png',usdAmount:12,commentId:'comment'} };
  const row=h.run("slimFomoFollowedEvent(fixture,new Set(['followed']))");
  assert.equal(row.name,'Real display'); assert.equal(row.symbol,''); assert.equal(row.tokenName,'Full token name');
  assert.equal(row.img,'https://example.test/token.png'); assert.equal(row.usd,12);
});

await test('partial detail success propagates metadata and never enters either authoritative cache', async () => {
  let fail = true;
  const h = harness(tokenRoute({ failDetail: (n) => fail && n === 2 }));
  const partial = await h.token();
  assert.equal(partial.ok, true);
  assert.equal(partial.source, 'holder-history');
  assert.equal(partial.partial, true);
  assert.equal(partial.followingKnown, true);
  assert.equal(partial.items[0].followed, true);
  assert.deepEqual(plain(partial.coverage), { attempted: 2, succeeded: 1, limit: 50, truncated: false });
  assert.equal(h.run(`fomoCache.has('swaps|56|${address}')`), false);
  assert.equal(h.run('fomoTokenTradeFallbackCache.size'), 0);
  fail = false;
  h.tick();
  const recovered = await h.token();
  assert.equal(recovered.partial, false);
  assert.equal(recovered.count, 2);
  const fetchedAt = recovered.fetchedAt;
  h.tick(1000);
  assert.equal((await h.token()).fetchedAt, fetchedAt);
  h.tick(21000);
  assert.equal((await h.token()).fetchedAt, fetchedAt, 'inner aggregate cache preserves original timestamp too');
});

await test('all failed trade details and malformed data are failures, not authoritative empty', async () => {
  const h = harness(tokenRoute({ failDetail: () => true }));
  const result = await h.token();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'detail-failed');
  assert.ok(result.retryAt > 0);
  assert.equal(h.run(`fomoCache.has('swaps|56|${address}')`), false);
  for (const body of [null, { statusCode: 200, responseObject: {} }, { statusCode: 200, responseObject: { count: 0 } }]) {
    const bad = harness(() => rawResponse(body));
    assert.equal((await bad.token()).ok, false);
  }
});

await test('explicit empty holders are successful limited history; missing trade IDs are not', async () => {
  const h = harness(tokenRoute({ count: 0 }));
  const empty = await h.token();
  assert.equal(empty.ok, true);
  assert.equal(empty.count, 0);
  assert.equal(empty.source, 'holder-history');
  assert.equal(empty.partial, false);
  assert.equal((await h.run(`fetchFomoTokenTradeFallback('${address}', [{ user: { id: 'followed' } }])`)).ok, false);
});

await test('unknown following is distinct from known-empty for holders and token-feed swaps', async () => {
  for (const kind of ['holders', 'swaps', 'thesis']) {
    for (const known of [false, true]) {
      const h = harness((path) => path.includes('followingIds')
        ? (known ? response({ followingIds: [] }) : response({}))
        : path.startsWith('/hodlers/top') ? response([{ totalHolders: 1, topHolders: [{ userId: 'followed', followed: true }] }])
          : response({ items: [{ id: 'swap', userId: 'followed', followed: true }], hasNextPage: false }));
      const result = await h.token(kind);
      assert.equal(result.ok, true);
      assert.equal(result.followingKnown, known);
      assert.equal(result.items[0].followed, known ? false : null);
      assert.equal(result.source, kind === 'swaps' ? 'token-feed' : kind);
      assert.equal(h.run('fomoCache.size'), known ? 1 : 0);
    }
  }
});

await test('holder-history cap reports truncation at 50 current holders', async () => {
  const h = harness(tokenRoute({ count: 51 }));
  const result = await h.token();
  assert.equal(result.count, 50);
  assert.equal(result.partial, false);
  assert.equal(result.coverage.attempted, 50);
  assert.equal(result.coverage.truncated, true);
  assert.equal(h.calls.filter((call) => call.path.startsWith('/trades/')).length, 50);
});

await test('parallel token requests and following lookups share in-flight work', async () => {
  const h = harness(tokenRoute());
  const result = await Promise.all([h.token(), h.token(), h.token()]);
  assert.equal(result[0].count, 2);
  assert.equal(h.calls.filter((call) => call.path.startsWith('/feed/token')).length, 1);
  assert.equal(h.calls.filter((call) => call.path.includes('followingIds')).length, 1);
});

// Direct Following collector fixtures: these intentionally use the bot's provider schemas.
const swap = (id, ts = 1800000000000, sell = false) => ({ id, createdAt: new Date(ts).toISOString(),
  inNetworkId: 56, outNetworkId: 56, inTokenAddress: sell ? address : '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  outTokenAddress: sell ? '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' : address,
  inTradeId: 'position', outTradeId: 'position', humanUsdAmountIn: 10, humanUsdAmountOut: 11 });
const thesis = (id, type = 'thesis') => ({ id, type, createdAt: new Date(1800000000000).toISOString(), userId: 'followed', userHandle: 'alpha', networkId:56, tokenAddress:address, tradeId:'position', comment:{comment:'thesis'}, body:{userId:'followed',userHandle:'alpha',commentId:id,comment:'thesis'} });
function collectorRoute(custom = () => undefined, roster = ['followed']) {
  return (path, options) => custom(path, options) ?? (path.includes('followingIds') ? response({followingIds:roster})
    : path.startsWith('/feed/tradingActivity?') ? response({items:[],hasNextPage:true}) // Deliberately stalled native lane exercises recovery.
    : path.includes('/swaps') ? response({swaps:[],hasNextPage:false})
    : path.includes('/balances') ? response({balances:[]})
    : path.startsWith('/feed/token') ? response({items:[],hasNextPage:false})
    : path.startsWith('/feed?') ? response({feed:[],hasNextPage:false})
    : response([]));
}
await test('missing profiles recover from exact trade owner and hydrate retained and late thesis rows',async()=> {
  let round=0;
  const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:round?[]:[{...swap('buy'),outTradeId:tradeId(1)}],hasNextPage:false})
    :path==='/v2/users/followed'?response({id:'followed',userHandle:'recovered',profilePictureLink:'https://example.test/avatar.png'})
    :path==='/proxy/filterTokens'?response(round?[{token:{networkId:56,address,symbol:'REC',name:'Recovered token',info:{imageLargeUrl:'https://example.test/token.png'}}}]:[])
    :path.startsWith('/feed/token')?response({items:round?[{...thesis('late'),userHandle:'',body:{userId:'followed',commentId:'late'}}]:[],hasNextPage:false}):undefined));
  const first=await h.feed(); assert.equal(first.events[0].handle,'recovered'); assert.equal(first.events[0].symbol,'');
  round=1;h.tick(31000);const next=await h.feed();
  assert.equal(next.events.length,2); assert.ok(next.events.every(e=>e.symbol==='REC'&&e.handle==='recovered'));
  assert.ok(next.events.every(e=>e.img==='https://example.test/token.png'));
  h.tick(); await h.feed(); assert.equal(h.calls.filter(c=>c.path==='/v2/users/followed').length,1);
  assert.equal(h.calls.filter(c=>c.path==='/proxy/filterTokens').length,2,'positive token cache prevents repeated lookups');
});
await test('blank metadata never erases an existing symbol and mismatched trade profiles are rejected',async()=> {
  const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[{...swap('buy'),ticker:'KNOWN',outTradeId:tradeId(1)}],hasNextPage:false})
    :path==='/v2/users/followed'?response({id:'other',userHandle:'wrong'})
    :path==='/proxy/filterTokens'?response([{token:{networkId:56,address,symbol:''}}]):undefined));
  const result=await h.feed();assert.equal(result.events[0].symbol,'KNOWN');assert.equal(result.events[0].handle,'');
});

await test('metadata identity, request caps, sparse replay and auth isolation',async()=> {
  for (const rows of [[{token:{networkId:8453,address,symbol:'WRONG'}}],
    [{token:{networkId:56,address,symbol:'GOOD'}},{token:{networkId:56,address,symbol:'DUP'}}],
    [{token:{networkId:56,address,symbol:{bad:true}}}]]) {
    const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[swap('one')],hasNextPage:false})
      :path==='/proxy/filterTokens'?response(rows):undefined));
    assert.equal((await h.feed()).events[0].symbol,'');
  }
  let round=0;
  const replay=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[{...swap('one'),...(round?{}:{ticker:'KEEP',tokenImageUrl:'https://example.test/keep.png'})}],hasNextPage:false}):undefined));
  await replay.feed();round=1;replay.tick();const repeated=await replay.feed();
  assert.equal(repeated.events[0].symbol,'KEEP');assert.equal(repeated.events[0].img,'https://example.test/keep.png');
  const pending=deferred(),started=deferred();let first=true;
  const isolated=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[{...swap('one'),outTradeId:tradeId(1)}],hasNextPage:false})
    :path==='/v2/users/followed'&&first?(first=false,started.resolve(),pending.promise):undefined));
  const old=isolated.feed();await started.promise;isolated.switchAccount('account-b');await isolated.feed();
  pending.resolve(response({id:'followed',userHandle:'old-account'}));
  assert.equal((await old).reason,'not-connected');assert.equal(isolated.run('fomoCollector.profiles.followed'),undefined);
  assert.ok((await isolated.feed()).events.every(e=>e.handle!=='old-account'));
  const roster=Array.from({length:12},(_,i)=>`u${i}`);
  const capped=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:Array.from({length:4},(_,i)=>({...swap(`${path.split('/')[3]}-s${i}`),outTradeId:tradeId(i+1),outTokenAddress:`0x${String(Number(path.split('/')[3].slice(1))*4+i+1).padStart(40,'0')}`})),hasNextPage:false}):undefined,roster));
  await capped.feed();
  assert.equal(capped.calls.filter(c=>/^\/v2\/users\/u[0-9]+$/.test(c.path)).length,12);
  assert.equal(JSON.parse(capped.calls.find(c=>c.path==='/proxy/filterTokens').options.body).length,30);
  capped.tick();await capped.feed();
  assert.equal(capped.calls.filter(c=>/^\/v2\/users\/u[0-9]+$/.test(c.path)).length,12,'untouched users progress before negative retries');
});
await test('balances recover validated tokenFilterResult metadata without a lookup',async()=> {
  for (const networkId of [56,8453]) {
    const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[swap('one')],hasNextPage:false})
      :path.includes('/balances')?response({balances:[{activeTrade:{id:'position',closedAt:null,userId:'followed',networkId:56,tokenAddress:address},userToken:{networkId:56,tokenAddress:address,humanAmountRemaining:1},tokenFilterResult:{token:{networkId,address,symbol:'BAL'}}}]}):undefined));
    const result=await h.feed();assert.equal(result.events[0].symbol,networkId===56?'BAL':'');
    assert.equal(h.calls.some(c=>c.path==='/proxy/filterTokens'),networkId!==56);
  }
});

await test('closed sell profile recovery is exact-owner-only and does not require current holdings',async()=> {
  for (const wrong of [false,true]) {
    const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[{...swap('exit',1800000000000,true),inTradeId:tradeId(9)}],hasNextPage:false})
      :path==='/v2/users/followed'?response({id:wrong?'other':'followed',userHandle:'seller'}):undefined));
    const result=await h.feed();assert.equal(result.events[0].type,'sell');assert.equal(result.events[0].handle,wrong?'':'seller');
    assert.equal(h.calls.filter(c=>c.path==='/v2/users/followed').length,1);
  }
});
await test('V1 restart tolerates missing metadata caches and invalid retry clocks',async()=> {
  const data={};const session={get:async()=>structuredClone(data),set:async value=>Object.assign(data,structuredClone(value)),remove:async key=>delete data[key]};
  const route=collectorRoute(path=>path.includes('/swaps')?response({swaps:[swap('one')],hasNextPage:false}):undefined);
  const first=harness(route,session);await first.feed();await first.run('fomoCollectorSave');
  const snapshot=structuredClone(data.fomoFollowingCollectorV1);
  for (const corrupt of [false,true]) {
    data.fomoFollowingCollectorV1=structuredClone(snapshot);
    const state=data.fomoFollowingCollectorV1.state;
    if(corrupt){state.tokens={[`56:${address}`]:{symbol:'',retryAt:'forever'}};state.profileRetry={followed:1e20};}
    else {delete state.tokens;delete state.profileRetry;}
    const restored=harness(route,session);const result=await restored.feed();assert.equal(result.ok,true);
    assert.ok(restored.calls.some(c=>c.path==='/proxy/filterTokens'));
    assert.ok(restored.run('fomoCollector.profileRetry.followed') > restored.run('Date.now()'));
    await restored.run('fomoCollectorSave');
  }
});

await test('current token MC reaches retained feed rows with explicit provenance and refreshes',async()=> {
  let mc=41400;
  const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[swap('ludes')],hasNextPage:false})
    :path==='/proxy/filterTokens'?response([{marketCap:mc,token:{networkId:56,address,symbol:'LUDES'}}]):undefined));
  let row=(await h.feed()).events[0];assert.equal(row.mc,41400);assert.equal(row.mcSource,'current-token');
  mc=42000;h.tick(16000);row=(await h.feed()).events[0];assert.equal(row.mc,42000);
  mc=null;h.tick(16000);row=(await h.feed()).events[0];assert.equal(row.mc,0,'expired current MC must not masquerade as event-time MC');
});
await test('recent thesis is visible on initial position census, old thesis is not replayed',async()=> {
  const h=harness(collectorRoute(path=>path.includes('/balances')?response({balances:[{activeTrade:{id:'position',closedAt:null,userId:'followed',networkId:56,tokenAddress:address,commentId:'recent'},userToken:{networkId:56,tokenAddress:address,humanAmountRemaining:1}}]})
    :path.startsWith('/feed/token')?response({items:[thesis('recent'),{...thesis('ancient'),createdAt:new Date(1800000000000-700000).toISOString()}],hasNextPage:false}):undefined));
  const result=await h.feed();assert.deepEqual(plain(result.events.map(e=>e.commentId)),['recent']);
});

await test('repeated buys, sells and comments on one position keep separate canonical identities', async () => {
  const h = harness(collectorRoute(path => path.includes('/swaps') ? response({swaps:[swap('buy1'),swap('buy2'),swap('sell1',1800000000000,true)],hasNextPage:false})
    : path.startsWith('/feed?') ? response({feed:[{...thesis('global','thesis_created'),body:{...thesis('c1').body,commentId:'c1'}}],hasNextPage:false})
    : path.startsWith('/feed/token') ? response({items:[thesis('c1'),thesis('c2')],hasNextPage:false}) : undefined));
  const result = await h.feed();
  assert.equal(result.events.length,5);
  assert.equal(new Set(result.events.map(e=>e.key)).size,5);
  assert.ok(result.events.every(e=>e.tx === '' && e.tradeId === 'position'));
  assert.equal(result.events.find(e=>e.swapId==='sell1').type,'sell');
  assert.equal(result.events.filter(e=>e.commentId==='c1').length,1);
  assert.equal(result.historyLimited,true);
  assert.equal(result.coverageGap,true);
  h.tick(); const overlapped = await h.feed(); assert.equal(overlapped.coverageGap,true,'native stalled lane remains disclosed');
  assert.equal((await h.feed()).stale,false);
});
await test('bounded missing-predecessor repair never stalls fresh ingestion and reports persistent gaps', async () => {
  let round=0;
  const h=harness(collectorRoute(path=>path.includes('/swaps') ? response({swaps:[swap(round ? `new-${round}` : 'anchor')],hasNextPage:round>0}) : undefined));
  await h.feed(); h.tick(); round=1;
  const result=await h.feed(); assert.equal(result.coverageGap,true); assert.equal(result.events.length,2);
  assert.equal(h.run("fomoCollector.lanes['swap:followed'].target"),'anchor');
  h.tick(); round=2; const more=await h.feed(); assert.ok(more.events.some(e=>e.swapId==='new-2'));
  assert.equal(h.run("fomoCollector.lanes['swap:followed'].target"),'anchor');
  assert.ok(h.calls.filter(c=>c.path.includes('/swaps')).length <= 7);
});
await test('partial pagination failure retains new and cached events, then overlap repairs coverage', async () => {
  let round=0;
  const h=harness(collectorRoute(path=> {
    if (!path.includes('/swaps')) return;
    if (!round) return response({swaps:[swap('anchor')],hasNextPage:false});
    if (!path.includes('lastSwapId')) return response({swaps:[swap('new')],hasNextPage:true});
    if (round===1) throw new Error('offline synthetic');
    return response({swaps:[swap('anchor')],hasNextPage:false});
  }));
  await h.feed(); round=1; h.tick(); const failed=await h.feed();
  assert.equal(failed.ok,false); assert.equal(failed.events.length,2); assert.equal(failed.stale,true);
  assert.equal(h.run('fomoApiRetryAt'),0,'optional collector failure does not block unrelated lanes');
  round=2; h.tick(); const repaired=await h.feed(); assert.equal(repaired.ok,true); assert.equal(repaired.coverageGap,true,'fallback repairs cannot certify the stalled native lane');
});
await test('known-empty roster remains distinct from unknown roster', async()=> {
  const empty=harness(collectorRoute(()=>undefined,[])); assert.equal((await empty.feed()).followingKnown,true);
  assert.equal(empty.calls.some(c=>c.path.includes('/swaps')),false);
  const bad=harness(()=>response({})); const result=await bad.feed();
  assert.equal(result.ok,false); assert.equal(result.followingKnown,false); assert.equal(bad.calls.length,1);
});
await test('incremental cache and push publish swaps before slow active-position recovery', async()=> {
  const pending=deferred(), started=deferred();
  const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[swap('fast')],hasNextPage:false})
    :path.includes('/balances')?(started.resolve(),pending.promise):undefined));
  const running=h.feed(); await started.promise;
  assert.equal(h.run('fomoFollowedFeedCache.events[0].swapId'),'fast');
  assert.equal((await h.feed()).events[0].swapId,'fast');
  pending.resolve(response({balances:[]})); await running;
});
await test('slow success and failure after account switch never overwrite new account',async()=> {
  for(const reject of [false,true]) {
    const pending=deferred(),started=deferred(); let first=true;
    const h=harness(collectorRoute(path=>{
      if(!path.includes('/swaps'))return;
      if(first){first=false;started.resolve();return pending.promise;}
      return response({swaps:[swap('current')],hasNextPage:false});
    }));
    const old=h.feed();await started.promise;h.switchAccount('account-b');
    const current=await h.feed();assert.equal(current.events[0].swapId,'current');
    if(reject)pending.reject(new Error('old offline'));else pending.resolve(response({swaps:[swap('old')],hasNextPage:false}));
    const late=await old;assert.equal(late.reason,'not-connected');assert.equal(late.events.length,0);
    assert.equal(h.run('fomoFollowedFeedCache.events[0].swapId'),'current');assert.equal(h.run('fomoApiRetryAt'),0);
  }
});
await test('account switch while following unresolved and during token decode stays isolated',async()=> {
  const pending=deferred(),started=deferred();let first=true;
  const h=harness(collectorRoute(path=>{if(path.includes('followingIds')&&first){first=false;started.resolve();return pending.promise;}}));
  const old=h.feed();await started.promise;h.switchAccount('account-b');await h.feed();pending.resolve(response({followingIds:['old']}));
  assert.equal((await old).ok,false);assert.equal(h.run("fomoFollowingIdsCache.ids.has('old')"),false);
  const bodyWait=deferred(),decoding=deferred();const tokens=harness(()=>{const result=response({items:[]});result.json=()=>{decoding.resolve();return bodyWait.promise;};return result;});
  const oldToken=tokens.token();await decoding.promise;tokens.switchAccount('account-b');bodyWait.resolve({statusCode:200,responseObject:{items:[event('old',100)]}});
  assert.equal((await oldToken).reason,'not-connected');assert.equal(tokens.run('fomoCache.size'),0);
});
await test('same-account refresh preserves lanes; logout and roster changes erase removed users',async()=> {
  let roster=['followed'];const h=harness(collectorRoute(path=>path.includes('followingIds')?response({followingIds:roster}):path.includes('/swaps')?response({swaps:[swap('anchor')],hasNextPage:false}):undefined));
  await h.feed();h.switchAccount('account-a',9999999998);assert.equal(h.run("fomoCollector.lanes['swap:followed'].head"),'anchor');
  roster=[];h.tick(121000);assert.equal((await h.feed()).events.length,0);assert.equal(h.run("fomoCollector.lanes['swap:followed']"),undefined);
  h.switchAccount(null);assert.equal(h.run('fomoFollowedFeedCache.events.length'),0);assert.equal(h.run('fomoFollowedFeedCache.coverageGap'),true);
});
await test('old active-position comments stay outside recent window; changed comments recover with overlap',async()=> {
  let commentId='old';let fail=false;
  const h=harness(collectorRoute(path=>path.includes('/balances')?response({balances:[{activeTrade:{id:'position',closedAt:null,userId:'followed',networkId:56,tokenAddress:address,commentId},userToken:{networkId:56,tokenAddress:address,humanAmountRemaining:1}}]})
    :path.startsWith('/feed/token')?(fail?response(null,500):response({items:[{...thesis(commentId),...(commentId==='old'?{createdAt:new Date(1800000000000-700000).toISOString()}:{})}],hasNextPage:false})):undefined));
  assert.equal((await h.feed()).events.length,0);
  commentId='changed';fail=true;h.tick();assert.equal((await h.feed()).partial,true);
  fail=false;h.tick();const recovered=await h.feed();assert.equal(recovered.events[0].commentId,'changed');
  assert.ok(h.calls.filter(c=>c.path.startsWith('/feed/token')).every(c=>new URL('https://fixture'+c.path).searchParams.has('afterTime')));
  assert.equal(h.run("fomoCollector.positions.followed.position.pending"),'');
});
await test('bounded concurrency and round-robin roster scheduling',async()=> {
  let active=0,max=0;const roster=Array.from({length:15},(_,i)=>`user${i}`);
  const route=collectorRoute(()=>undefined,roster);
  const h=harness(async(path,options)=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return route(path,options);});
  const result=await h.feed();assert.equal(result.coverage.usersAttempted,12);assert.equal(result.coverageGap,true);assert.ok(max<=4);
  h.tick();await h.feed();assert.equal(new Set(h.calls.filter(c=>c.path.includes('/swaps')).map(c=>c.path.split('/')[3])).size,15);
});

const nativeAlert = (id, userId = 'followed', extra = {}) => ({ id, userId, type:'swap_buy', createdAt:new Date(1800000000000).toISOString(), networkId:56, tokenAddress:address, tradeId:'position', usdAmount:556, fdv:41400, ...extra });

await test('native contract paginates outside 12-user rotation and recovers roster profiles', async () => {
  const roster = Array.from({length:98},(_,i)=>`user-${i}`), logs=[];
  const h=harness(collectorRoute(path=> {
    const u=new URL('https://fixture'+path);
    if(u.pathname==='/feed/tradingActivity') {
      assert.equal(u.searchParams.get('limit'),'50');
      return response({items:[nativeAlert(u.searchParams.has('lastId')?'native-b':'native-a','user-97')],hasNextPage:!u.searchParams.has('lastId')});
    }
    if(path==='/v2/users/current')return response({id:'actual-fomo-id'});
    if(u.pathname==='/v2/users/actual-fomo-id/followingPaginate')return response({users:u.searchParams.has('lastId')?[]:[{id:'user-97',userHandle:'outside-batch'}]});
    if(path==='/proxy/filterTokens')throw new Error('optional metadata offline');
  },roster));
  h.ctx.gdhDebug={record:(kind,data)=>logs.push({kind,...plain(data)})};
  const result=await h.feed();
  assert.equal(result.events.length,2); assert.ok(result.events.every(e=>e.handle==='outside-batch'&&e.usd===556&&e.mc===41400&&e.mcSource==='alerts-fdv'));
  assert.equal(result.coverage.usersAttempted,0);assert.equal(result.coverageGap,false);
  assert.equal(h.calls.some(c=>c.path.includes('/swaps')),false);
  const log=logs.find(e=>e.kind==='pagination'&&e.endpoint==='trading-activity');assert.equal(log.pages,2);assert.equal(log.received,2);assert.equal(log.hasMore,false);
  assert.ok(logs.some(e=>e.endpoint==='following-profiles'&&e.pages===2));
  assert.ok(!JSON.stringify(logs).includes('native-a'));assert.ok(!JSON.stringify(logs).includes('user-97'));
});

await test('unsupported native groups remain partial and trigger individual fallback', async()=>{
  const h=harness(collectorRoute(path=>path.startsWith('/feed/tradingActivity?')?response({items:[nativeAlert('group','followed',{type:'multi_user_buy'})],hasNextPage:false}):undefined));
  const result=await h.feed();
  assert.equal(result.coverage.unsupported,1); assert.equal(result.coverageGap,true);
  assert.ok(h.calls.some(c=>c.path.includes('/swaps')));
  assert.ok(!result.events.some(e=>e.providerEventId==='group'));
});

await test('native exact USD/FDV/thesis fields and absent amount are not fallback guesses', () => {
  const h=harness(()=>response([]));
  h.ctx.rows=[nativeAlert('zero','followed',{usdAmount:0,fdv:0,marketCap:99}),nativeAlert('missing','followed',{usdAmount:undefined,usdValue:777}),nativeAlert('comment','followed',{type:'thesis',usdAmount:1,comment:{id:'comment-id',comment:'native text',shortCommentSegments:[{text:'native text'}]},authorTrade:{usdValue:456,closedAt:'2026-01-01',percentageRealizedPnl:-12,percentageUnrealizedPnl:99}})];
  const rows=h.run("rows.map(r=>slimFomoFollowedEvent({...r,dataSource:'trading-activity'},new Set(['followed'])))");
  assert.equal(rows[0].usd,0);assert.equal(rows[0].mc,0);assert.equal(rows[1].usd,null);
  assert.equal(rows[2].usd,456);assert.equal(rows[2].comment,'native text');assert.equal(rows[2].commentId,'comment-id');assert.equal(rows[2].pnlPercent,-12);assert.equal(rows[2].commentSegments.length,1);
});

await test('fallback first then native preserves identity, amount provenance and restart aliases', async () => {
  let healthy=false; const data={};
  const session={get:async()=>structuredClone(data),set:async value=>Object.assign(data,structuredClone(value)),remove:async key=>delete data[key]};
  const route=collectorRoute(path=>path.startsWith('/feed/tradingActivity?')?(healthy?response({items:[nativeAlert('alert-id')],hasNextPage:false}):undefined)
    :path.includes('/swaps')?response({swaps:[swap('swap-id')],hasNextPage:false}):undefined);
  const h=harness(route,session);const initial=await h.feed();const key=initial.events[0].key;
  healthy=true;h.tick();const result=await h.feed();
  assert.equal(result.events.length,1);assert.equal(result.events[0].key,key);assert.equal(result.events[0].usd,556);assert.equal(result.events[0].dataSource,'trading-activity');
  await h.run('fomoCollectorSave');const restored=harness(route,session);const next=await restored.feed();
  assert.equal(next.events.length,1);assert.equal(next.events[0].key,key);assert.equal(next.events[0].usd,556);
});

await test('ambiguous same-position transaction aliases never erase distinct swaps', () => {
  const h=harness(()=>response([]));h.ctx.raw=nativeAlert('native');
  const result=h.run(`(()=>{const ids=new Set(['followed']); const n=slimFomoFollowedEvent({...raw,dataSource:'trading-activity'},ids);const a={...n,key:'a',dataSource:'user-swaps',providerEventId:'a'};const b={...a,key:'b',providerEventId:'b'};return fomoMergeFollowedEvents([a,b,n]);})()`);
  assert.equal(result.length,3);
});

await test('native baseline page cap persists repair and never certifies head overlap alone', async () => {
  const logs=[];
  const h=harness(collectorRoute(path=> {
    const u=new URL('https://fixture'+path);if(u.pathname!=='/feed/tradingActivity')return;
    const n=Number((u.searchParams.get('lastId')||'n0').slice(1))+1;
    return response({items:[nativeAlert(`n${n}`)],hasNextPage:n<7});
  }));h.ctx.gdhDebug={record:(kind,data)=>logs.push({kind,...plain(data)})};
  assert.equal((await h.feed()).coverageGap,true);assert.equal(h.calls.filter(c=>c.path.startsWith('/feed/tradingActivity')).length,5);
  h.tick();assert.equal((await h.feed()).coverageGap,true);
  h.tick();const done=await h.feed();assert.equal(done.events.length,7);assert.equal(done.coverageGap,false);
  assert.ok(logs.filter(e=>e.kind==='pagination'&&e.endpoint==='trading-activity').every(e=>e.pages<=5));
});

await test('direct ID recovery needs no trade ID and rejects another profile owner', async () => {
  for(const wrong of [false,true]) {
    const h=harness(collectorRoute(path=>path.startsWith('/feed/tradingActivity?')?response({items:[nativeAlert('no-trade','followed',{tradeId:null})],hasNextPage:false})
      :path==='/v2/users/followed'?response({id:wrong?'other':'followed',userHandle:'direct'}):undefined));
    assert.equal((await h.feed()).events[0].handle,wrong?'':'direct');
    assert.equal(h.calls.some(c=>c.path.startsWith('/trades/')),false);
  }
});

await test('429 Retry-After and network failure backoff are bounded, shared, and reset on account switch', async () => {
  const h = harness(() => response(null, 429, { 'Retry-After': '60' }));
  const first = await h.token('holders');
  assert.equal(first.ok, false);
  assert.equal(first.status, 429);
  assert.equal(first.retryAt - h.run('Date.now()'), 60000);
  await h.token('thesis');
  assert.equal(h.calls.length, 1);
  h.switchAccount('account-b');
  await h.token('thesis');
  assert.equal(h.calls.length, 2);
  const huge = harness(() => response(null, 429, { 'Retry-After': '999999' }));
  assert.equal((await huge.token()).retryAt - huge.run('Date.now()'), 300000);
  const offline = harness(() => { throw new Error('offline'); });
  const failed = await offline.token();
  assert.equal(failed.reason, 'network');
  assert.equal(failed.retryAt - offline.run('Date.now()'), 15000);
  const backedOff = await offline.token();
  assert.equal(backedOff.status, undefined, 'network cooldown must not be falsely labeled HTTP 429');
  assert.ok(backedOff.retryAt > 0);
  assert.equal(offline.calls.length, 1);
});

await test('deadline covers a stalled response body and releases coalesced requests for retry', async () => {
  let stalled = true;
  const h = harness((path, options) => {
    if (!stalled) return path.includes('followingIds') ? response({followingIds:[]}) : response([{totalHolders:0,topHolders:[]}]);
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new Error('fixture body aborted')), {once:true});
    } }), {status:200});
  });
  const timers = new Map(); let timerId = 0;
  h.ctx.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, {fn,ms}); return id; };
  h.ctx.clearTimeout = id => timers.delete(id);
  const first = h.token('holders'); const shared = h.token('holders');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(timers.size, 1, 'deadline remains active after response headers');
  const deadline = [...timers.values()][0]; assert.equal(deadline.ms, 15000);
  deadline.fn();
  assert.equal((await first).ok, false); assert.equal((await shared).ok, false);
  assert.equal(h.run('fomoTokenInflight.size'), 0, 'failed body no longer blocks retries');
  assert.equal(timers.size, 0);
  stalled = false; h.tick();
  assert.equal((await h.token('holders')).ok, true, 'request recovers after backoff');
});
