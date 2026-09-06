#!/usr/bin/env node
// Offline behavioral tests: execute the complete production worker in an isolated VM.
// Synthetic API fixtures only; no authenticated requests, browser, or third-party packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

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

function harness(route) {
  let now = 1800000000000;
  const changed = [], messages = [], calls = [];
  const store = { fomoToken: token('account-a') };
  const ignore = { addListener() {} };
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({
    console, Date: Clock, URL, URLSearchParams, atob, btoa, AbortController, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, options) => {
      const path = String(url).replace('https://prod-api.fomo.family', '');
      calls.push({ path, options });
      return route(path, options);
    },
    chrome: {
      runtime: { onInstalled: ignore, onStartup: ignore, onMessage: { addListener(fn) { messages.push(fn); } } },
      alarms: { get: async () => ({}), create() {}, onAlarm: ignore },
      storage: { local: { get: async () => ({ ...store }), set: async (data) => Object.assign(store, data) }, onChanged: { addListener(fn) { changed.push(fn); } } },
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

await test('restart baseline is honestly labeled and flows through existing poll message', async () => {
  const route = (path) => path.includes('followingIds') ? response({ followingIds: ['followed'] }) : response({ items: [event('seed', 100)], hasNextPage: true });
  const h = harness(route);
  const result = await h.poll();
  assert.equal(result.coverageGap, true);
  assert.equal(result.gapReason, 'restart-baseline');
  assert.equal(result.events.length, 1);
  assert.ok(result.fetchedAt > 0);
  assert.equal(h.calls.length, 2, 'baseline uses one global page, not an unbounded historical scan');
  const restarted = harness(route);
  assert.equal((await restarted.feed()).gapReason, 'restart-baseline');
  assert.equal(restarted.run('fomoFollowedFeedCheckpoint.id'), 'seed');
});

await test('pagination overlaps raw checkpoint, drains timestamp ties, dedups and retains older followed events', async () => {
  let round = 0;
  const h = harness((path) => {
    if (path.includes('followingIds')) return response({ followingIds: ['followed'] });
    if (!round) return response({ items: [event('checkpoint', 100, 'not-followed'), event('retained', 90)], hasNextPage: true });
    const page = Number(new URL(`https://fixture${path}`).searchParams.get('page'));
    return response(page === 0 ? { items: [event('new', 200), event('checkpoint', 100, 'not-followed')], hasNextPage: true }
      : { items: [event('new', 200), event('tie', 100), event('older', 99, 'not-followed')], hasNextPage: false });
  });
  await seedFeed(h);
  assert.equal(h.run('fomoFollowedFeedCheckpoint.id'), 'checkpoint', 'unfollowed event is the anchor');
  round = 1;
  const results = await Promise.all([h.feed(), h.feed()]);
  assert.deepEqual(plain(results[0].events.map((item) => item.key)), ['fomo-followed:new', 'fomo-followed:tie', 'fomo-followed:retained']);
  assert.equal(h.run('fomoFollowedFeedCheckpoint.id'), 'new');
  assert.equal(results[0].coverageGap, false, 'proven continuity since baseline is not a permanent warning');
  assert.equal(results[0].historyLimited, true, 'continuity is not lifetime history');
  const cached = await h.feed();
  assert.equal(cached.stale, false, 'fresh cached success is not a stale-feed warning');
  assert.equal(cached.coverageGap, false);
  assert.equal(h.calls.filter((call) => call.path.includes('tradingActivity')).length, 3);
});

await test('page cap exposes a gap without advancing the stable checkpoint', async () => {
  let round = 0;
  const h = harness((path) => path.includes('followingIds') ? response({ followingIds: ['followed'] })
    : response({ items: round ? [event(`page-${new URL(`https://fixture${path}`).searchParams.get('page')}`, 200)] : [event('checkpoint', 100)], hasNextPage: true }));
  await seedFeed(h);
  round = 1;
  const result = await h.feed();
  assert.equal(result.ok, true);
  assert.equal(result.coverageGap, true);
  assert.equal(result.gapReason, 'page-cap');
  assert.equal(result.events.length, 6);
  assert.equal(h.run('fomoFollowedFeedCheckpoint.id'), 'checkpoint');
  assert.equal(h.calls.filter((call) => call.path.includes('tradingActivity')).length, 6);
  const stale = await h.feed();
  assert.equal(stale.gapReason, 'page-cap');
  assert.equal(stale.fetchedAt, result.fetchedAt);
});

await test('pagination failure keeps both old and newly collected events and retries the old checkpoint', async () => {
  let round = 0;
  const h = harness((path) => {
    if (path.includes('followingIds')) return response({ followingIds: ['followed'] });
    const page = Number(new URL(`https://fixture${path}`).searchParams.get('page'));
    if (!round) return response({ items: [event('checkpoint', 100)], hasNextPage: true });
    if (page === 0) return response({ items: [event('new', 200)], hasNextPage: true });
    if (round === 1) throw new Error('offline fixture');
    return response({ items: [event('checkpoint', 100)], hasNextPage: false });
  });
  await seedFeed(h);
  round = 1;
  const result = await h.feed();
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.gapReason, 'pagination-failed');
  assert.equal(result.events.length, 2);
  assert.ok(result.retryAt > result.fetchedAt);
  assert.equal(h.run('fomoFollowedFeedCheckpoint.id'), 'checkpoint');
  assert.equal((await h.feed()).gapReason, 'pagination-failed');
  round = 2; h.tick();
  const repaired = await h.feed();
  assert.equal(repaired.ok, true);
  assert.equal(h.run('fomoFollowedFeedCheckpoint.id'), 'new');
});

await test('explicit hasNextPage false stops early; omitted flag uses bounded short-page default', async () => {
  for (const explicit of [false, undefined]) {
    let round = 0;
    const h = harness((path) => path.includes('followingIds') ? response({ followingIds: ['followed'] })
      : response({ items: [event(round ? 'missing-anchor' : 'checkpoint', round ? 200 : 100)], ...(explicit === undefined ? {} : { hasNextPage: explicit }) }));
    await seedFeed(h); round = 1;
    const result = await h.feed();
    assert.equal(result.gapReason, 'checkpoint-missing');
    assert.equal(h.calls.filter((call) => call.path.includes('tradingActivity')).length, 2);
  }
});

await test('known zero follows still establishes a global checkpoint; unknown follows never imply empty success', async () => {
  const empty = harness((path) => path.includes('followingIds') ? response({ followingIds: [] }) : response({ items: [event('global', 100)], hasNextPage: false }));
  assert.equal((await empty.feed()).events.length, 0);
  assert.equal(empty.run('fomoFollowedFeedCheckpoint.id'), 'global');
  const bad = harness(() => response({}));
  const result = await bad.feed();
  assert.equal(result.ok, false);
  assert.equal(result.followingKnown, false);
  assert.equal(result.coverageGap, true);
  assert.equal(bad.calls.length, 1);
});

await test('slow success AND rejected old-account feed requests cannot leak or overwrite new-account state', async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), started = deferred();
    let first = true;
    const h = harness((path) => {
      if (path.includes('followingIds')) return response({ followingIds: ['followed'] });
      if (first) { first = false; started.resolve(); return pending.promise; }
      return response({ items: [event('new-account', 200)], hasNextPage: false });
    });
    const old = h.feed(); await started.promise;
    h.switchAccount('account-b');
    const current = await h.feed();
    assert.equal(current.events[0].key, 'fomo-followed:new-account');
    if (reject) pending.reject(new Error('old offline')); else pending.resolve(response({ items: [event('old-account', 100)], hasNextPage: false }));
    const late = await old;
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'not-connected');
    assert.equal(late.events.length, 0);
    assert.equal(h.run('fomoFollowedFeedCache.events[0].key'), 'fomo-followed:new-account');
    assert.equal(h.run('fomoApiRetryAt'), 0, 'old failure must not back off new account');
  }
});

await test('account switch while following is unresolved and during token JSON decode is isolated', async () => {
  const pending = deferred(), started = deferred();
  let first = true;
  const h = harness((path) => {
    if (first) { first = false; started.resolve(); return pending.promise; }
    if (path.includes('followingIds')) return response({ followingIds: ['followed'] });
    return response({ items: [event('current', 200)], hasNextPage: false });
  });
  const old = h.feed(); await started.promise;
  h.switchAccount('account-b');
  await h.feed();
  pending.resolve(response({ followingIds: ['old-follow'] }));
  assert.equal((await old).ok, false);
  assert.equal(h.run("fomoFollowingIdsCache.ids.has('old-follow')"), false);

  const bodyWait = deferred(), decoding = deferred();
  const tokens = harness(() => {
    const result = response({ items: [] });
    result.json = () => { decoding.resolve(); return bodyWait.promise; };
    return result;
  });
  const oldToken = tokens.token(); await decoding.promise;
  tokens.switchAccount('account-b');
  bodyWait.resolve({ statusCode: 200, responseObject: { items: [event('old', 100)] } });
  assert.equal((await oldToken).reason, 'not-connected');
  assert.equal(tokens.run('fomoCache.size'), 0);
});

await test('same-account JWT refresh retains checkpoint; logout and unidentified token changes reset it', async () => {
  const h = harness((path) => path.includes('followingIds') ? response({ followingIds: ['followed'] }) : response({ items: [event('anchor', 100)], hasNextPage: false }));
  await h.feed();
  h.switchAccount('account-a', 9999999998);
  assert.equal(h.run('fomoFollowedFeedCheckpoint.id'), 'anchor');
  assert.equal(h.run('fomoAuthGeneration'), 0);
  h.switchAccount(null);
  assert.equal(h.run('fomoFollowedFeedCheckpoint'), null);
  assert.equal(h.run('fomoFollowedFeedCache.events.length'), 0);
  assert.equal(h.run('fomoFollowedFeedCache.coverageGap'), true);
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
