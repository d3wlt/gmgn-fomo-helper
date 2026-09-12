import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Synthetic, network-free VM tests of the actual MAIN bridge and content lane.
// No browser, provider traffic, credentials, extension installation or production hooks.
const root = new URL('../', import.meta.url);
const bridge = readFileSync(new URL('page-bridge.js', root), 'utf8');
const content = readFileSync(new URL('content.js', root), 'utf8');
const popup = readFileSync(new URL('popup.js', root), 'utf8');
const wallet = `0x${'1'.repeat(40)}`;
const otherWallet = `0x${'2'.repeat(40)}`;
const ca = `0x${'a'.repeat(40)}`;
const solWallet = '11111111111111111111111111111111';
const solCa = 'So11111111111111111111111111111111111111112';
const endpoint = 'https://gmgn.ai/td/api/v1/wallets/hybrid/holdings?device_id=fixture&client_id=fixture';
const body = (groups = [['bsc', wallet], ['robinhood', wallet], ['sol', solWallet]]) => ({
  chain_wallets: groups.map(([chain, address]) => ({ chain, wallet_addresses: [address] })),
  order_by: 'last_active_timestamp', direction: 'desc', hide_honeypot: false,
  hide_tiny_pool: false, hide_closed: true, hide_airdrop: true,
});
const row = (address = ca, addressWallet = wallet, extra = {}) => ({
  token_address: address, wallet_address: addressWallet, balance: '10', accu_amount: '20', accu_cost: '18', accu_fee: '2',
  token_basic_stats: { symbol: 'FIXTURE', private: 'omit' }, private: 'omit', ...extra,
});
const group = (chain, holdings = [row()]) => ({ chain, holdings });
const payload = (list = [group('bsc'), group('robinhood'), group('sol', [row(solCa, solWallet)])]) => ({ code: 0, data: { list } });
const response = (data) => ({ ok: true, status: 200, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const timers = new Map(); let timerId = 0; let now = 100000000;
  const attrs = new Map();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.documentElement = {
    setAttribute: (key, value) => attrs.set(key, String(value)),
    getAttribute: (key) => attrs.get(key) ?? null,
    removeAttribute: (key) => attrs.delete(key),
  };
  doc.querySelectorAll = () => [];
  let token = 'synthetic-account-token-never-a-real-secret';
  const requests = []; const envelopes = []; const alerts = []; const writes = [];
  let route = async () => response(payload());
  const timersApi = {
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame() { return 1; },
  };
  const fetch = (url, init) => {
    const helper = Boolean(init?.signal);
    requests.push({ url: typeof url === 'string' ? url : url.url, init, helper });
    return helper ? route(url, init) : Promise.resolve(response(payload()));
  };
  class XHR { open() {} send() {} }
  class Socket extends EventTarget { send() {} }
  const win = { ...timersApi, fetch, WebSocket: Socket, XMLHttpRequest: XHR, localStorage: { getItem: () => JSON.stringify({ token: { access_token: token } }) } };
  const shared = { console, URL, URLSearchParams, Request, Event, EventTarget, AbortController,
    Date: class extends Date { static now() { return now; } }, document: doc,
    location: new URL('https://gmgn.ai/fusion'), performance: { getEntriesByType: () => [] },
    MutationObserver: class { observe() {} }, Node: class {},
  };
  const main = vm.createContext({ ...shared, window: win, fetch: (...args) => win.fetch(...args) });
  vm.runInContext(bridge, main, { filename: 'page-bridge.js' });
  doc.addEventListener('gdh-holdings-result', () => envelopes.push(JSON.parse(attrs.get('data-gdh-holdings-result'))));
  const settings = { enableHoldingSurge: true, holdingSurgeThreshold: 20, holdingSurgeCooldown: 1, holdingWatchList: [] };
  const isolated = vm.createContext({ ...shared, window: timersApi, settings,
    normalizeWalletAddress: (value) => /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : '',
    chrome: { storage: { local: { set: (value) => writes.push(value) } }, runtime: { sendMessage: (value) => writes.push(value) } },
    showRemindCard: (value) => alerts.push(value), fetch: () => { throw new Error('content must not fetch holdings'); },
  });
  const section = content.slice(content.indexOf('  const HOLDING_ROW_SELECTOR ='), content.indexOf('  function scanRemindToasts()'));
  assert.ok(section.includes('function requestHoldingSnapshot()'));
  vm.runInContext(`${section}\nglobalThis.h = {
    sync: syncHoldingWatchFromApi, confirm: confirmHoldingStillOwned, handle: handleHoldingPriceUpdate,
    allow: holdingSignalAllowed, parse: parseGmgnHoldingSignalConfig, snapshot: requestHoldingSnapshot,
    watch: holdingWatchMap, put: putHolding, levels: holdingAlertLevel,
    config: (value) => { gmgnHoldingSignalConfig = { loaded: true, byChain: new Map(Object.entries(value)) }; },
  };`, isolated, { filename: 'content-holdings-production-section.js' });
  return { main, h: isolated.h, doc, win, attrs, settings, requests, envelopes, alerts, writes,
    route(fn) { route = fn; }, account(value) { token = value; }, advance(ms) { now += ms; },
    async expire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await tick(); },
    native(data = body()) { return win.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) }); },
    helperCalls() { return requests.filter((item) => item.helper); },
  };
}

test('hybrid MAIN → content hydrates all chains, same EVM CA stays separated, exact native POST retained and secrets omitted', async () => {
  const t = harness();
  await t.native();
  t.route(async () => response(payload([group('bsc'), group('robinhood', [row(ca, wallet, { accu_cost: 38 })]), group('sol', [row(solCa, solWallet)])])));
  const result = await t.h.sync();
  assert.equal(result.ok, true);
  assert.equal(t.h.watch.size, 3);
  assert.equal(t.h.watch.get(`bsc:${ca}`).cost, 1);
  assert.equal(t.h.watch.get(`robinhood:${ca}`).cost, 2);
  assert.equal(t.h.watch.get(`sol:${solCa}`).cost, 1);
  const [call] = t.helperCalls();
  assert.equal(t.helperCalls().length, 1);
  assert.equal(call.url, endpoint);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), body());
  assert.equal(call.init.redirect, 'error');
  const exported = JSON.stringify(t.envelopes);
  for (const privateValue of [JSON.stringify(wallet), JSON.stringify(solWallet), 'synthetic-account-token', 'device_id', 'wallet_address', 'private']) assert.ok(!exported.includes(privateValue));
  assert.equal(t.attrs.has('data-gdh-holdings-result'), false);
  await t.h.sync('', true);
  assert.equal(t.helperCalls().length, 2, 'helper replay must not replace/reobserve native scope');
});

test('native selected wallet changes replace only that chain, no wallet union/fallback or unrelated purge', async () => {
  const t = harness(); await t.native(); await t.h.sync();
  await t.native(body([['bsc', otherWallet]]));
  t.route(async (_url, init) => {
    const groups = JSON.parse(init.body).chain_wallets;
    return response(payload(groups.map(({ chain }) => group(chain, chain === 'sol' ? [row(solCa, solWallet)] : [row()]))));
  });
  assert.equal(await t.h.confirm('bsc', `bsc:${ca}`), false, 'other wallet row cannot confirm new selected scope');
  assert.equal(t.h.watch.has(`bsc:${ca}`), true, 'filtered/selected group is not a chain-wide deletion');
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), true);
  const lastBodies = t.helperCalls().slice(-2).map((call) => JSON.parse(call.init.body));
  assert.ok(lastBodies.some((value) => value.chain_wallets.length === 1 && value.chain_wallets[0].wallet_addresses[0] === otherWallet));
  await t.native(body([['sol', solWallet]]));
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), true, 'sol-only lane must not erase RH scope');
});

test('empty, missing, duplicate, malformed, error and partial chains fail closed without purging other watch rows', async () => {
  const t = harness(); await t.native(); await t.h.sync();
  const fixtures = [
    payload([group('robinhood', [])]), payload([group('sol', [])]), payload([]),
    payload([group('robinhood', null)]), payload([group('robinhood'), group('robinhood')]),
    { code: 1, data: payload().data }, { code: 0, data: {} },
    payload([group('robinhood', [row(ca, wallet, { balance: 0 })])]),
    payload([group('robinhood', [row(ca, wallet, { accu_cost: null })])]),
    payload([group('robinhood', [row(ca, wallet, { chain: 'bsc' })])]),
  ];
  for (const value of fixtures) {
    t.route(async () => response(value));
    assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), false);
    assert.equal(t.h.watch.size, 3);
  }
  t.route(async () => ({ ok: false, status: 401, json: async () => payload() }));
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), false);
  t.route(async () => { throw new Error('fixture failure'); });
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), false);
  t.route(async () => response(payload([group('robinhood')])));
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), true, 'valid partial positive chain remains usable');
  assert.equal(t.h.watch.size, 3);
});

test('legacy GET continues using exact URL with wallet scope validation', async () => {
  const t = harness();
  const url = `https://gmgn.ai/td/api/v1/wallets/holdings?chain=bsc&wallet_addresses=${wallet}&hide_closed=true`;
  await t.win.fetch(url);
  t.route(async () => response({ code: 0, data: { holdings: [row(), row(ca, otherWallet, { accu_cost: 999 })] } }));
  assert.equal(await t.h.confirm('bsc', `bsc:${ca}`), true);
  assert.equal(t.h.watch.get(`bsc:${ca}`).cost, 1);
  assert.equal(t.helperCalls()[0].url, url);
  assert.equal(t.helperCalls()[0].init.method, 'GET');
  assert.equal(t.helperCalls()[0].init.body, undefined);
});

test('Request clone/asynchronous body, init overrides, XHR observation, and out-of-order capture stay scoped', async () => {
  const t = harness();
  const original = new Request(endpoint, { method: 'POST', body: JSON.stringify(body([['robinhood', wallet]])) });
  await t.win.fetch(original);
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), true);
  assert.equal(original.bodyUsed, false, 'observer only reads clone');
  const late = deferred();
  await t.win.fetch({ url: endpoint, method: 'POST', clone: () => ({ text: () => late.promise }) });
  const xhr = new t.win.XMLHttpRequest();
  xhr.open('POST', endpoint); xhr.send(JSON.stringify(body([['robinhood', otherWallet]])));
  late.resolve(JSON.stringify(body([['robinhood', wallet]])));
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), false, 'late old request body cannot replace later XHR wallet');
  assert.deepEqual(JSON.parse(t.helperCalls().at(-1).init.body), body([['robinhood', otherWallet]]));
  await t.win.fetch(original, { body: JSON.stringify(body([['robinhood', wallet]])) });
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), true);
});

test('scope/account switches during response decoding and parallel completion reject stale results', async () => {
  for (const change of ['wallet', 'account']) {
    const t = harness(); await t.native(body([['robinhood', wallet]]));
    const pending = deferred(); t.route(async () => ({ ok: true, json: () => pending.promise }));
    const confirmation = t.h.confirm('robinhood', `robinhood:${ca}`); await tick();
    if (change === 'wallet') await t.native(body([['robinhood', otherWallet]]));
    else t.account('synthetic-different-account-token-only');
    pending.resolve(payload([group('robinhood')]));
    assert.equal(await confirmation, false);
    assert.equal(t.h.watch.size, 0);
  }
  const t = harness();
  await t.native(body([['bsc', wallet]])); await t.native(body([['robinhood', wallet]]));
  const pending = deferred();
  t.route(async (_url, init) => JSON.parse(init.body).chain_wallets[0].chain === 'bsc'
    ? { ok: true, json: () => pending.promise } : response(payload([group('robinhood')])));
  const confirmation = t.h.confirm('robinhood', `robinhood:${ca}`); await tick();
  await t.native(body([['robinhood', otherWallet]]));
  pending.resolve(payload([group('bsc')]));
  assert.equal(await confirmation, false, 'already decoded RH result rechecked after slower BSC finishes');
});

test('deadlines include response body and native Request body; retries release inflight work and coalesce', async () => {
  const t = harness(); await t.native();
  let signal;
  t.route(async (_url, init) => { signal = init.signal; return { ok: true, json: () => new Promise(() => {}) }; });
  const a = t.h.sync('', true); const b = t.h.confirm('robinhood', `robinhood:${ca}`);
  await tick(); assert.equal(t.helperCalls().length, 1);
  await t.expire(10000);
  assert.equal((await a).ok, false); assert.equal(await b, false); assert.equal(signal.aborted, true);
  t.route(async () => response(payload()));
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), true);
  await t.win.fetch({ url: endpoint, method: 'POST', clone: () => ({ text: () => new Promise(() => {}) }) });
  const retry = t.h.sync('', true); await tick(); await t.expire(10000);
  assert.equal((await retry).ok, true, 'stalled observation does not pin the bridge forever');
});

test('bounds and TTL: no URL guessing, hybrid GET, unknown chain, oversized body, expired scope or missing account fallback', async () => {
  const t = harness();
  await t.win.fetch(endpoint);
  await t.win.fetch('https://evil.example/td/api/v1/wallets/hybrid/holdings', { method: 'POST', body: JSON.stringify(body()) });
  await t.native(body([['eth', wallet]]));
  await t.win.fetch(endpoint, { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal((await t.h.sync('', true)).ok, false); assert.equal(t.helperCalls().length, 0);
  await t.native(); t.advance(10 * 60 * 1000 + 1);
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), false);
  await t.native(); t.account('');
  assert.equal(await t.h.confirm('robinhood', `robinhood:${ca}`), false);
});

test('Robinhood native config false wins, missing entry falls back to master toggle; popup explains fallback', () => {
  const t = harness();
  t.h.config({ bsc: true, sol: false });
  assert.equal(t.h.allow('robinhood'), true); assert.equal(t.h.allow('bsc'), true);
  assert.equal(t.h.allow('sol'), false); assert.equal(t.h.allow('base'), false);
  t.h.config({ robinhood: false }); assert.equal(t.h.allow('robinhood'), false);
  t.h.config({ robinhood: true }); assert.equal(t.h.allow('robinhood'), true);
  t.settings.enableHoldingSurge = false; assert.equal(t.h.allow('robinhood'), false);
  const sanitize = bridge.slice(bridge.indexOf('  function sanitizeHoldingConfig('), bridge.indexOf('  async function fetchHoldingConfig('));
  const sanitized = vm.runInNewContext(`${sanitize}\nsanitizeHoldingConfig({data:[{push_chain:'robinhood',push_switch_dict:{holding_signal:false,secret:'omit'}}]})`);
  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)), [{ push_chain: 'robinhood', push_switch_dict: { holding_signal: false } }]);
  const node = {};
  const render = popup.slice(popup.indexOf('function renderGmgnHoldingSyncState('), popup.indexOf('function shortJ7TrackerAccount('));
  vm.runInNewContext(`${render}\nrenderGmgnHoldingSyncState({synced:true, enabledChains:[], robinhoodFallback:true});`, { gmgnHoldingSyncStatus: node });
  assert.match(node.textContent, /Robinhood uses the extension toggle/);
  assert.doesNotMatch(node.textContent, /position price alerts are disabled/);
});

test('same EVM CA subscriptions never infer BSC price for Robinhood or vice versa', () => {
  const t = harness(); const socket = new t.win.WebSocket(); const emitted = [];
  t.doc.addEventListener('gdh-token-stat', () => emitted.push(JSON.parse(t.attrs.get('data-gdh-token-stat'))));
  const subscription = (action, chain) => socket.send(JSON.stringify({ channel: 'token_stat', action, data: [{ chain, addresses: [ca] }] }));
  const message = (chain) => {
    const event = new Event('message');
    event.data = JSON.stringify({ channel: 'token_stat', data: [{ a: ca, c: chain, p: 2, p5m: 1 }] });
    socket.dispatchEvent(event);
  };
  subscription('subscribe', 'bsc'); subscription('subscribe', 'robinhood');
  message(); assert.equal(emitted.length, 0, 'ambiguous untagged frame is not attributed');
  message('bsc'); message('robinhood');
  assert.deepEqual(emitted.map((items) => items[0].chain), ['bsc', 'robinhood']);
  subscription('unsubscribe', 'bsc'); message();
  assert.equal(emitted.at(-1)[0].chain, 'robinhood');
});

test('actual surge handler rejects sold token, respects chain/master changes during confirmation, and emits owned Robinhood alert', async () => {
  const t = harness(); await t.native(body([['robinhood', wallet]])); await t.h.sync();
  t.h.config({ bsc: true });
  const update = (price) => ({ chain: 'robinhood', address: ca, price, price5m: 1 });
  await t.h.handle(update(1.1)); assert.equal(t.alerts.length, 0);
  t.route(async () => response(payload([group('robinhood', [row(ca, wallet, { balance: 0 })])])));
  await t.h.handle(update(1.5)); assert.equal(t.alerts.length, 0);
  const delayed = deferred(); t.route(async () => ({ ok: true, json: () => delayed.promise }));
  const pending = t.h.handle(update(1.5)); await tick(); t.h.config({ robinhood: false }); delayed.resolve(payload([group('robinhood')]));
  await pending; assert.equal(t.alerts.length, 0);
  t.h.config({ bsc: true });
  t.route(async () => response(payload([group('robinhood')])));
  await t.h.handle(update(1.5)); assert.equal(t.alerts.length, 1);
  assert.equal(t.alerts[0].href, `/robinhood/token/${ca}`);
  t.settings.enableHoldingSurge = false;
  const count = t.helperCalls().length;
  await t.h.handle(update(2)); await t.h.sync('', true);
  assert.equal(t.helperCalls().length, count); assert.equal(t.alerts.length, 1);
});
