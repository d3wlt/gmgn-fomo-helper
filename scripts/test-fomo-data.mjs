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
  const changed = [], messages = [], calls = [];
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
      runtime: { onInstalled: ignore, onStartup: ignore, onMessage: { addListener(fn) { messages.push(fn); } } },
      alarms: { get: async () => ({}), create() {}, onAlarm: ignore },
      storage: { session, local: { get: async () => ({ ...store }), set: async (data) => Object.assign(store, data) }, onChanged: { addListener(fn) { changed.push(fn); } } },
    },
  });
  vm.runInContext(source, ctx, { filename: 'background.js' });
  return {
    calls, ctx,
    run: (code) => vm.runInContext(code, ctx),
    token: (kind = 'swaps') => vm.runInContext(`fomoFetchToken(${JSON.stringify({ tokenAddress: address, networkId: 56, kind })})`, ctx),
    feed: () => vm.runInContext('fetchFomoFollowedFeed()', ctx),
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
    : path.includes('/swaps') ? response({swaps:[],hasNextPage:false})
    : path.includes('/balances') ? response({balances:[]})
    : path.startsWith('/feed/token') ? response({items:[],hasNextPage:false})
    : path.startsWith('/feed?') ? response({feed:[],hasNextPage:false})
    : response([]));
}
await test('missing profiles recover from exact trade owner and hydrate retained and late thesis rows',async()=> {
  let round=0;
  const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:round?[]:[{...swap('buy'),outTradeId:tradeId(1)}],hasNextPage:false})
    :path.startsWith('/trades/')?response({...detail(1),user:{id:'followed',userHandle:'recovered',profilePictureLink:'https://example.test/avatar.png'}})
    :path==='/proxy/filterTokens'?response(round?[{token:{networkId:56,address,symbol:'REC',name:'Recovered token',info:{imageLargeUrl:'https://example.test/token.png'}}}]:[])
    :path.startsWith('/feed/token')?response({items:round?[{...thesis('late'),userHandle:'',body:{userId:'followed',commentId:'late'}}]:[],hasNextPage:false}):undefined));
  const first=await h.feed(); assert.equal(first.events[0].handle,'recovered'); assert.equal(first.events[0].symbol,'');
  round=1;h.tick(31000);const next=await h.feed();
  assert.equal(next.events.length,2); assert.ok(next.events.every(e=>e.symbol==='REC'&&e.handle==='recovered'));
  assert.ok(next.events.every(e=>e.img==='https://example.test/token.png'));
  h.tick(); await h.feed(); assert.equal(h.calls.filter(c=>c.path.startsWith('/trades/')).length,1);
  assert.equal(h.calls.filter(c=>c.path==='/proxy/filterTokens').length,2,'positive token cache prevents repeated lookups');
});
await test('blank metadata never erases an existing symbol and mismatched trade profiles are rejected',async()=> {
  const h=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:[{...swap('buy'),ticker:'KNOWN',outTradeId:tradeId(1)}],hasNextPage:false})
    :path.startsWith('/trades/')?response({...detail(1),user:{id:'other',userHandle:'wrong'}})
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
    :path.startsWith('/trades/')&&first?(first=false,started.resolve(),pending.promise):undefined));
  const old=isolated.feed();await started.promise;isolated.switchAccount('account-b');await isolated.feed();
  pending.resolve(response({...detail(1),user:{id:'followed',userHandle:'old-account'}}));
  assert.equal((await old).reason,'not-connected');assert.equal(isolated.run('fomoCollector.profiles.followed'),undefined);
  assert.ok((await isolated.feed()).events.every(e=>e.handle!=='old-account'));
  const roster=Array.from({length:12},(_,i)=>`u${i}`);
  const capped=harness(collectorRoute(path=>path.includes('/swaps')?response({swaps:Array.from({length:4},(_,i)=>({...swap(`${path.split('/')[3]}-s${i}`),outTradeId:tradeId(i+1),outTokenAddress:`0x${String(Number(path.split('/')[3].slice(1))*4+i+1).padStart(40,'0')}`})),hasNextPage:false}):undefined,roster));
  await capped.feed();
  assert.equal(capped.calls.filter(c=>c.path.startsWith('/trades/')).length,4);
  assert.equal(JSON.parse(capped.calls.find(c=>c.path==='/proxy/filterTokens').options.body).length,30);
  capped.tick();await capped.feed();
  assert.equal(capped.calls.filter(c=>c.path.startsWith('/trades/')).length,8,'untouched users progress before negative retries');
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
      :path.startsWith('/trades/')?response({...detail(9),trade:{...detail(9).trade,userId:wrong?'other':'followed'},user:{id:'followed',userHandle:'seller'}}):undefined));
    const result=await h.feed();assert.equal(result.events[0].type,'sell');assert.equal(result.events[0].handle,wrong?'':'seller');
    assert.equal(h.calls.filter(c=>c.path.startsWith('/trades/')).length,1);
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
    assert.equal(restored.run('fomoCollector.profileRetry.followed'),undefined);
    await restored.run('fomoCollectorSave');
  }
});

await test('repeated buys, sells and comments on one position keep separate canonical identities', async () => {
  const h = harness(collectorRoute(path => path.includes('/swaps') ? response({swaps:[swap('buy1'),swap('buy2'),swap('sell1',1800000000000,true)],hasNextPage:false})
    : path.startsWith('/feed?') ? response({feed:[{...thesis('global','thesis_created'),body:{...thesis('c1').body,commentId:'c1'}}],hasNextPage:false})
    : path.startsWith('/feed/token') ? response({items:[thesis('c1'),thesis('c2')],hasNextPage:false}) : undefined));
  const result = await h.poll();
  assert.equal(result.events.length,5);
  assert.equal(new Set(result.events.map(e=>e.key)).size,5);
  assert.ok(result.events.every(e=>e.tx === '' && e.tradeId === 'position'));
  assert.equal(result.events.find(e=>e.swapId==='sell1').type,'sell');
  assert.equal(result.events.filter(e=>e.commentId==='c1').length,1);
  assert.equal(result.historyLimited,true);
  assert.equal(result.coverageGap,true);
  h.tick(); const overlapped = await h.feed(); assert.equal(overlapped.coverageGap,false);
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
  round=2; h.tick(); const repaired=await h.feed(); assert.equal(repaired.ok,true); assert.equal(repaired.coverageGap,false);
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
await test('active positions baseline silently; changed comments recover with recent overlap and cross-source identity',async()=> {
  let commentId='old';let fail=false;
  const h=harness(collectorRoute(path=>path.includes('/balances')?response({balances:[{activeTrade:{id:'position',closedAt:null,userId:'followed',networkId:56,tokenAddress:address,commentId},userToken:{networkId:56,tokenAddress:address,humanAmountRemaining:1}}]})
    :path.startsWith('/feed/token')?(fail?response(null,500):response({items:[thesis(commentId)],hasNextPage:false})):undefined));
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
