import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Offline fixtures execute the unmodified production IIFE, including adapter discovery.
const source = readFileSync(new URL('../native-thesis.js', import.meta.url), 'utf8');
const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`;
class Target {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) { event.target = this; for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event); }
}
class Observable {
  observers = new Set(); history = []; subscriptions = 0; removals = 0;
  subscribe(observer) {
    this.observers.add(observer); this.history.push(observer); this.subscriptions++;
    let closed = false;
    return { unsubscribe: () => { if (!closed) { closed = true; this.observers.delete(observer); this.removals++; } } };
  }
  next(v) { for (const o of [...this.observers]) o.next?.(v); }
  error(v) { for (const o of [...this.observers]) o.error?.(v); }
  complete() { for (const o of [...this.observers]) o.complete?.(); }
}
function fixture(options = {}) {
  let now = 1800000000000, serial = 0;
  const timers = new Map(), mutations = [];
  const clock = (fn, ms, interval = false) => { const id = ++serial; timers.set(id, { fn, ms, at: now + ms, interval }); return id; };
  const tick = ms => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due; now = t.at;
      if (t.interval) t.at += t.ms; else timers.delete(id);
      t.fn();
    }
    now = until;
  };
  const attrs = new Map(), hostAttrs = new Map([['data-active', options.closed ? '0' : '1']]);
  const root = { getAttribute: n => attrs.get(n) ?? null, setAttribute: (n, v) => attrs.set(n, v), removeAttribute: n => attrs.delete(n) };
  const host = { isConnected: true, parentElement: null, hidden: false,
    getAttribute: n => hostAttrs.get(n) ?? null, getClientRects: () => options.noBox ? [] : [{}],
    getBoundingClientRect: () => ({ width: 220, height: 300 }), style: { display: 'block', visibility: 'visible', opacity: '1' } };
  const document = Object.assign(new Target(), { documentElement: root, visibilityState: options.hidden ? 'hidden' : 'visible',
    getElementById: () => options.unmounted ? null : host });
  const window = new Target();
  class Storage { setItem() {} removeItem() {} clear() {} }
  window.Storage = Storage; window.localStorage = new Storage();
  const location = { origin: 'https://gmgn.ai', pathname: `/eth/token/${A}` };
  const rest = [], streams = [], params = [], reconnect = new Observable();
  const manager = { webSocket: new Target(), state: 2, getConnectionState() { return this.state; }, reconnectionSubject: reconnect,
    getFomoThesisSocket: () => ({ getFomoThesisObservable: p => {
      params.push(p); if (options.streamThrows) throw new Error('fixture');
      const observable = new Observable(); streams.push(observable); return observable;
    } }) };
  let managers = 0;
  const modules = {
    902286: { Ay: { get: p => { params.push(p); const observable = new Observable(); rest.push(observable); return observable; } } },
    165523: { NK: { has: () => !options.unsupported, getTradingViewConfig: () => ({ markSupportList: ['fomo_thesis'] }) } },
    463958: { getQuotationSocketMgr: () => { managers++; return manager; } },
    277891: { Uw: { DONE: 2 }, MV: { invalidAccessToken: 10001 } }
  };
  const factories = { 902286() {}, 165523() {}, 277891() {},
    463958: function () { /* getFomoThesisObservable thesisPairMgr removeSubscribePair reconnectionSubject */ },
    180292: function () { /* /pf/api/v1/fomo/thesis/token fomo_thesis */ } };
  if (options.badAdapter) delete factories[180292];
  const chunks = [[[], factories]];
  chunks.push = entry => { Array.prototype.push.call(chunks, entry); entry[2]?.(id => modules[id]); };
  window.webpackChunk_N_E = chunks;
  const resultEvents = [];
  const result = () => attrs.has('data-gdh-thesis-result') ? JSON.parse(attrs.get('data-gdh-thesis-result')) : null;
  document.addEventListener('gdh-thesis-result', () => resultEvents.push(result()));
  const context = { window, document, location, URL, Event: class { constructor(type) { this.type = type; } },
    Date: class extends Date { static now() { return now; } }, getComputedStyle: e => e.style,
    setTimeout: (f, ms) => clock(f, ms), clearTimeout: id => timers.delete(id),
    setInterval: (f, ms) => clock(f, ms, true), clearInterval: id => timers.delete(id),
    MutationObserver: class { constructor(fn) { mutations.push(fn); } observe() {} } };
  vm.runInNewContext(source, context, { filename: 'native-thesis.js' });
  const request = (requestId = 'r1', extra = {}) => {
    attrs.set('data-gdh-thesis-demand', JSON.stringify({ v: 1, requestId, chain: 'eth', address: A, ...extra }));
    document.dispatchEvent({ type: 'gdh-thesis-demand' });
  };
  const mutate = () => mutations.forEach(f => f());
  const row = (id = 'one', extra = {}) => ({ id, chain: 'eth', token_address: A, thesis: '<b>plain text</b>',
    fomo_created_at: now - 1000, like_count: 4, author_name: 'Public name', author_handle: 'public',
    author_avatar_url: 'https://prod-fomo-profile-pics.s3.amazonaws.com/avatar.jpg?secret=query#fragment',
    private_id: 'DO-NOT-BRIDGE', access_token: 'DO-NOT-BRIDGE', ...extra });
  return { attrs, host, hostAttrs, document, window, location, rest, streams, params, manager, reconnect,
    request, result, resultEvents, mutate, row, tick, timers, managers: () => managers };
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${passed} - ${name}`); }

test('zero native calls while absent, closed, hidden, unmounted or without visible box', () => {
  for (const opts of [{ closed: true }, { hidden: true }, { unmounted: true }, { noBox: true }]) {
    const f = fixture(opts); f.request(); f.tick(60000); assert.equal(f.params.length, 0); assert.equal(f.managers(), 0);
  }
  const f = fixture(); f.tick(60000); assert.equal(f.params.length, 0);
});
test('invalid demand, unsupported route/origin and changed module contracts fail closed', () => {
  for (const extra of [{ v: 2 }, { requestId: '<bad>' }, { chain: 'fake' }, { address: '0x123' }, { secret: 'bad' }]) {
    const f = fixture(); f.request('r', extra); assert.equal(f.params.length, 0);
  }
  for (const route of ['/eth/token/nope', `/base/token/${A}`, `/eth/token/${B}`, '/eth/trenches']) {
    const f = fixture(); f.location.pathname = route; f.request(); assert.equal(f.params.length, 0);
  }
  const f = fixture(); f.location.origin = 'https://evil.test'; f.request(); assert.equal(f.params.length, 0);
  for (const opts of [{ badAdapter: true }, { unsupported: true }]) {
    const g = fixture(opts); g.request(); assert.equal(g.result().error, 'native_unavailable'); assert.equal(g.params.length, 0);
  }
});
test('native GET contract, buffering, sanitization, dedupe and descending millisecond order', () => {
  const f = fixture(); f.request(); assert.equal(f.result().status, 'loading');
  assert.deepEqual(JSON.parse(JSON.stringify(f.params[1])), { url: '/pf/api/v1/fomo/thesis/token', data: { chain: 'eth', token: A, limit: 50 } });
  f.streams[0].next([f.row('one', { thesis: 'new', like_count: 6 }), f.row('two', { fomo_created_at: 1799999999999 })]);
  assert.equal(f.result().status, 'loading');
  f.rest[0].next({ items: [f.row()] });
  const r = f.result(); assert.equal(r.status, 'streaming'); assert.equal(r.coverage, 'limited');
  assert.deepEqual(r.items.map(x => x.id), ['two', 'one']); assert.equal(r.items[1].thesis, 'new');
  assert.equal(r.items[1].like_count, 6); assert.ok(!JSON.stringify(r).includes('DO-NOT-BRIDGE'));
  assert.equal(r.items[1].author_avatar_url, 'https://prod-fomo-profile-pics.s3.amazonaws.com/avatar.jpg');
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['id', 'chain', 'token_address', 'token_symbol', 'author_name', 'author_handle',
    'author_avatar_url', 'author_is_dev', 'thesis', 'like_count', 'fomo_created_at'].sort());
});
test('empty snapshot is explicit; empty stream never means streaming', () => {
  const f = fixture(); f.request(); f.streams[0].next([]); f.rest[0].next({ items: [] });
  assert.equal(f.result().status, 'snapshot'); assert.deepEqual(f.result().items, []);
  f.streams[0].next([f.row()]); assert.equal(f.result().status, 'streaming');
});
test('malformed vs empty, wrong token and partial batches reject rather than manufacture empty', () => {
  for (const payload of [{}, { items: null }, { items: [null] }, { items: [fixture().row(), { id: 'bad' }] }]) {
    const f = fixture(); f.request(); f.rest[0].next(payload); assert.equal(f.result().error, 'malformed_snapshot');
  }
  const f = fixture(); f.request(); f.rest[0].next({ items: [] });
  f.streams[0].next([f.row('foreign', { token_address: B })]); assert.equal(f.result().error, 'malformed_stream');
  assert.deepEqual(f.result().items, []);
});
test('REST failure after buffered stream remains error with valid partial rows', () => {
  const f = fixture(); f.request(); f.streams[0].next([f.row()]); f.rest[0].error({ status: 500, secret: 'never' });
  assert.equal(f.result().status, 'error'); assert.equal(f.result().error, 'snapshot_failed'); assert.equal(f.result().items.length, 1);
  f.streams[0].next([f.row('later')]); assert.equal(f.result().status, 'error'); assert.equal(f.result().items.length, 2);
});
test('stream creation failure does not discard independently successful history', () => {
  const f = fixture({ streamThrows: true }); f.request(); f.rest[0].next({ items: [f.row()] });
  assert.equal(f.result().error, 'native_stream_unavailable'); assert.equal(f.result().items.length, 1);
});
test('token race, stale success/error/completion cannot overwrite replacement', () => {
  const f = fixture(); f.request(); const old = f.rest[0].history[0], oldStream = f.streams[0].history[0];
  f.tick(3000); f.location.pathname = `/eth/token/${B}`; f.request('r2', { address: B });
  f.rest[1].next({ items: [f.row('b', { token_address: B })] });
  old.next({ items: [f.row()] }); old.error({ status: 401 }); old.complete(); oldStream.next([f.row()]);
  assert.equal(f.result().requestId, 'r2'); assert.equal(f.result().items[0].id, 'b');
  assert.equal(f.streams[0].removals, 1); assert.equal(f.rest[0].removals, 1);
});
test('hidden, removed demand, unmount, inactive, route and pagehide stop and clear', () => {
  for (const trigger of [f => { f.document.visibilityState = 'hidden'; f.document.dispatchEvent({ type: 'visibilitychange' }); },
    f => { f.attrs.delete('data-gdh-thesis-demand'); f.document.dispatchEvent({ type: 'gdh-thesis-demand' }); },
    f => { f.host.isConnected = false; f.mutate(); }, f => { f.hostAttrs.set('data-active', '0'); f.mutate(); },
    f => { f.location.pathname = '/eth/trenches'; f.tick(250); }, f => f.window.dispatchEvent({ type: 'pagehide' }),
    f => { f.host.style.opacity = '0'; f.mutate(); }]) {
    const f = fixture(); f.request(); f.rest[0].next({ items: [f.row()] }); trigger(f);
    assert.equal(f.result().status, 'stopped'); assert.deepEqual(f.result().items, []);
    assert.equal(f.streams[0].observers.size, 0); assert.equal(f.reconnect.observers.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.manager.webSocket.listeners.get('message').size, 0);
  }
});
test('same-tab and cross-tab account boundary clear without reading storage values', () => {
  for (const trigger of [f => f.window.localStorage.setItem('tgInfo', 'opaque'), f => f.window.localStorage.removeItem('tgInfo'),
    f => f.window.localStorage.clear(), f => f.window.dispatchEvent({ type: 'storage', key: 'tgInfo' })]) {
    const f = fixture(); f.request(); f.rest[0].next({ items: [f.row()] }); trigger(f);
    assert.equal(f.result().error, 'account_changed'); assert.deepEqual(f.result().items, []);
    f.request(); assert.equal(f.rest.length, 1);
  }
});
test('native auth errors clear both lanes, including socket auth acknowledgment', () => {
  for (const trigger of [f => f.rest[0].error({ status: 401 }), f => f.streams[0].error({ code: 10001 }),
    f => f.manager.webSocket.dispatchEvent({ type: 'message', data: JSON.stringify({ channel: 'ack', data: [{ code: 10001 }] }) })]) {
    const f = fixture(); f.request(); f.streams[0].next([f.row()]); trigger(f);
    assert.equal(f.result().error, 'native_auth_failure'); assert.deepEqual(f.result().items, []);
    assert.equal(f.streams[0].observers.size, 0);
  }
});
test('deadline, backoff, event spam and explicit refresh only', () => {
  const f = fixture(); f.request(); for (let i = 0; i < 100; i++) f.request(); assert.equal(f.rest.length, 1);
  f.tick(10000); assert.equal(f.result().error, 'snapshot_timeout'); assert.equal(f.rest[0].removals, 1);
  f.request('r2'); assert.equal(f.result().error, 'rate_limited'); assert.equal(f.rest.length, 1);
  f.tick(6000); f.request('r2'); assert.equal(f.rest.length, 1); f.request('r3'); assert.equal(f.rest.length, 2);
  f.rest[1].next({ items: [] }); f.tick(60000); assert.equal(f.rest.length, 2);
});
test('native disconnect/reconnect never creates a socket or falsely claims streaming', () => {
  const f = fixture(); f.request(); f.rest[0].next({ items: [f.row()] }); f.streams[0].next([f.row()]);
  f.manager.state = 3; f.manager.webSocket.dispatchEvent({ type: 'close' });
  assert.equal(f.result().error, 'native_disconnected'); assert.equal(f.result().items.length, 1);
  f.manager.webSocket = new Target(); f.manager.state = 2; f.reconnect.next(1);
  assert.equal(f.result().error, 'native_reconnected_gap'); assert.equal(f.rest.length, 1); assert.equal(f.streams.length, 1);
  f.streams[0].next([f.row('recovered')]); assert.equal(f.result().status, 'streaming'); assert.equal(f.managers(), 1);
});
test('bounded history, fields, unsafe avatar and chain-specific address identity', () => {
  const f = fixture(); f.request();
  f.rest[0].next({ items: Array.from({ length: 300 }, (_, i) => f.row(`id-${i}`, { thesis: 'x'.repeat(9000),
    author_avatar_url: 'javascript:alert(1)', fomo_created_at: 1799999990000 + i })) });
  assert.equal(f.result().items.length, 200); assert.equal(f.result().items[0].id, 'id-299');
  assert.equal(f.result().items[0].thesis.length, 9000, 'full supported post text is never silently truncated'); assert.equal(f.result().items[0].author_avatar_url, '');
  const g = fixture(); g.location.pathname = `/eth/token/${A.toUpperCase().replace('0X', '0x')}`; g.request();
  g.rest[0].next({ items: [g.row('upper', { token_address: A.toUpperCase().replace('0X', '0x') })] });
  assert.equal(g.result().status, 'snapshot'); assert.equal(g.result().items[0].token_address, A);
  const h = fixture(), sol = 'A'.repeat(32); h.location.pathname = `/sol/token/${sol}`;
  h.request('sol', { chain: 'sol', address: sol }); h.rest[0].next({ items: [h.row('sol', { chain: 'sol', token_address: 'a'.repeat(32) })] });
  assert.equal(h.result().error, 'malformed_snapshot');
});
test('untrusted event detail cannot authorize demand; malformed/oversized attributes stay closed', () => {
  const f = fixture();
  f.document.dispatchEvent({ type: 'gdh-thesis-demand', detail: { v: 1, requestId: 'fake', chain: 'eth', address: A } });
  for (const raw of ['{broken', 'x'.repeat(1000), 'null', '[]']) {
    f.attrs.set('data-gdh-thesis-demand', raw); f.document.dispatchEvent({ type: 'gdh-thesis-demand' });
  }
  assert.equal(f.params.length, 0);
});
test('reentrant unmount during loading starts no native work', () => {
  const f = fixture();
  f.document.addEventListener('gdh-thesis-result', () => { f.host.isConnected = false; });
  f.request(); assert.equal(f.params.length, 0); assert.equal(f.result().status, 'stopped');
});
test('snapshot completion without value, nonzero response code and completed stream are explicit failures', () => {
  const f = fixture(); f.request(); f.rest[0].complete(); assert.equal(f.result().error, 'snapshot_missing');
  const g = fixture(); g.request(); g.rest[0].next({ code: 500, items: [] }); assert.equal(g.result().error, 'snapshot_failed');
  const h = fixture(); h.request(); h.rest[0].next({ items: [] }); h.streams[0].complete();
  assert.equal(h.result().error, 'native_stream_closed');
  assert.equal(h.rest[0].removals, 1);
});
console.log(`PASS ${passed} native-thesis production-VM tests (offline; no browser/network/trading calls)`);
