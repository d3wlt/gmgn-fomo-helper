#!/usr/bin/env node
// Offline J7Tracker behavioral tests execute the complete production worker.
// Fixtures are synthetic; no real account, token, or third-party request is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fomoRecord(id, account = 'alice', side = 'buy') {
  return {
    channel: 'fomo_event',
    payload: {
      kind: 'trade',
      data: {
        id,
        side,
        timestamp: '2026-09-06T19:00:00Z',
        userHandle: account,
        usdAmount: 42,
        txHash: `0x${id}`,
        token: {
          address: '0x1111111111111111111111111111111111111111',
          symbol: 'J7T',
          networkId: 56,
          marketCapUsd: 750000,
        },
      },
    },
  };
}

function pumpRecord(id, account = 'bob') {
  return {
    channel: 'pump_event',
    payload: {
      kind: 'callout',
      data: {
        id,
        timestamp: '2026-09-06T19:00:01Z',
        text: 'Synthetic callout',
        author: { username: account, wallet: '0x2222222222222222222222222222222222222222' },
        token: {
          address: '0x3333333333333333333333333333333333333333',
          symbol: 'PUMP',
          networkId: 56,
          marketCapUsd: 500000,
        },
      },
    },
  };
}

function harness({ fetchRoute, historyRoute, token = 'fixture-token-a', accountId = 'account-a' } = {}) {
  let now = 1800000000000;
  const fetchCalls = [];
  const socketCalls = [];
  const sockets = [];
  const storageListeners = [];
  const messages = [];
  const store = {
    j7TrackerSessionV1: { token, accountId, displayName: accountId, at: now },
  };
  const ignore = { addListener() {} };
  const timer = (fn, ms) => setTimeout(fn, ms >= 8000 ? 15 : ms);
  class Clock extends Date { static now() { return now; } }

  const io = (origin, options) => {
    const handlers = {};
    const socket = {
      on(name, callback) {
        handlers[name] = callback;
        if (name === 'connect') queueMicrotask(() => handlers.connect?.());
        return socket;
      },
      emit(name, payload, callback) {
        socketCalls.push({ origin, options, name, payload });
        let routed;
        try {
          routed = historyRoute ? historyRoute({ origin, options, name, payload }) : [];
        } catch (error) {
          handlers.connect_error?.(error);
          return;
        }
        Promise.resolve(routed)
          .then(result => callback(result?.rawAck === true ? result.value : { events: result }), error => handlers.connect_error?.(error));
      },
      disconnect() {},
    };
    sockets.push({ origin, options, handlers, socket });
    return socket;
  };

  const context = vm.createContext({
    console, Date: Clock, URL, URLSearchParams, atob, btoa, AbortController, TextDecoder,
    Response, ReadableStream, DOMException, crypto, clearTimeout, clearInterval, setInterval,
    setTimeout: timer, importScripts() {}, io,
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      if (fetchRoute) return fetchRoute(String(url), options, fetchCalls.length);
      if (String(url).endsWith('/api/fomo/list')) return response({ fomo_users: [{ id: 'f1' }] });
      if (String(url).endsWith('/api/pump/list')) return response({ pump_users: [{ id: 'p1' }] });
      throw new Error(`Unexpected fixture URL: ${url}`);
    },
    chrome: {
      runtime: {
        onInstalled: ignore,
        onStartup: ignore,
        onMessage: { addListener(fn) { messages.push(fn); } },
      },
      alarms: { get: async () => ({}), create() {}, onAlarm: ignore },
      tabs: { query(_query, callback) { callback([]); }, sendMessage() {} },
      storage: {
        local: {
          get: async (keys) => {
            const requested = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
            const result = {};
            for (const key of requested) if (key in store) result[key] = store[key];
            return result;
          },
          set: async values => Object.assign(store, values),
          remove: async keys => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; },
        },
        onChanged: { addListener(fn) { storageListeners.push(fn); } },
      },
    },
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return {
    context, store, fetchCalls, socketCalls, sockets,
    run: code => vm.runInContext(code, context),
    fomo: () => vm.runInContext('fetchJ7TrackerFomoFeed()', context),
    pump: () => vm.runInContext('fetchJ7TrackerPumpFeed()', context),
    advance: ms => { now += ms; },
    switchSession(nextToken, nextAccount) {
      const oldValue = store.j7TrackerSessionV1;
      const newValue = nextToken ? { token: nextToken, accountId: nextAccount, displayName: nextAccount, at: now } : null;
      store.j7TrackerSessionV1 = newValue;
      for (const listener of storageListeners) listener({ j7TrackerSessionV1: { oldValue, newValue } }, 'local');
    },
    message: (message, sender) => new Promise(resolve => {
      for (const listener of messages) {
        const keep = listener(message, sender, resolve);
        if (keep === false) break;
      }
    }),
  };
}

await test('parallel FOMO and Pump reads share verified config and one bounded history request', async () => {
  const h = harness({ historyRoute: () => [fomoRecord('trade-1'), pumpRecord('pump-1')] });
  const [fomo, pump] = await Promise.all([h.fomo(), h.pump()]);
  assert.equal(fomo.ok, true);
  assert.equal(pump.ok, true);
  assert.equal(fomo.events[0].source, 'j7-fomo');
  assert.equal(pump.events[0].source, 'j7-pump');
  assert.equal(pump.events[0].type, 'callout');
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.socketCalls.length, 1);
  assert.equal(h.socketCalls[0].name, 'social_history');
  assert.equal(h.socketCalls[0].payload.limit, 500);
  assert.equal(h.socketCalls[0].options.path, '/wallets/socket.io/');
  assert.deepEqual(plain(h.store.j7TrackerFomoConfigV1), { connected: true, trackedCount: 1, at: h.store.j7TrackerFomoConfigV1.at });
  assert.equal(h.store.j7TrackerSyncStateV1.connected, true);
});

await test('live FOMO and Pump events merge into the verified account caches', async () => {
  const h = harness({ historyRoute: () => [] });
  assert.equal((await h.fomo()).ok, true);
  const live = h.sockets.find(entry => entry.options.reconnection === true);
  assert.ok(live);
  live.handlers.fomo_event(fomoRecord('live-fomo', 'live-alice').payload);
  live.handlers.pump_event(pumpRecord('live-pump', 'live-bob').payload);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.run('j7TrackerFomoCache[0].handle'), 'live-alice');
  assert.equal(h.run('j7TrackerPumpCache[0].handle'), 'live-bob');
  h.switchSession('fixture-token-b', 'account-b');
  live.handlers.fomo_event(fomoRecord('late-old-event', 'old-user').payload);
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.run('j7TrackerFomoCache.length'), 0);
});

await test('invalid J7 credentials clear the mirrored session and never return cached success', async () => {
  const h = harness({ fetchRoute: () => response({ error: 'Invalid token' }, 401) });
  h.run(`j7TrackerFomoCache = [${JSON.stringify({ ...fomoRecord('old').payload.data, key: 'old', source: 'j7-fomo', type: 'buy', ts: 1 })}]`);
  const result = await h.fomo();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-connected');
  assert.equal(h.store.j7TrackerSessionV1, null);
  assert.equal(h.store.j7TrackerSyncStateV1.connected, false);
  assert.equal(h.store.j7TrackerSyncStateV1.reason, 'session-expired');
  assert.equal(h.run('j7TrackerFomoCache.length'), 0);
});

await test('history failures return visibly stale same-account events, publish retry state, and honor cooldown', async () => {
  let fail = false;
  const h = harness({
    historyRoute: () => {
      if (fail) throw new Error('fixture network failure');
      return [fomoRecord('trade-1')];
    },
  });
  assert.equal((await h.fomo()).ok, true);
  fail = true;
  h.advance(13000);
  const failed = await h.fomo();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'network');
  assert.equal(failed.stale, true);
  assert.equal(failed.events.length, 1);
  assert.equal(failed.events[0].stale, true);
  assert.equal(h.store.j7TrackerSyncStateV1.reason, 'network');
  assert.equal(h.socketCalls.length, 2);
  const cooldown = await h.fomo();
  assert.equal(cooldown.ok, false);
  assert.equal(h.socketCalls.length, 2, 'cooldown avoids reconnect loops');
});

await test('an old-account history response cannot overwrite a switched account', async () => {
  const oldHistory = deferred();
  let round = 0;
  const h = harness({ historyRoute: () => (++round === 1 ? oldHistory.promise : [fomoRecord('new-trade', 'new-user')]) });
  const pending = h.fomo();
  while (!h.socketCalls.length) await new Promise(resolve => setTimeout(resolve, 1));
  h.switchSession('fixture-token-b', 'account-b');
  oldHistory.resolve([fomoRecord('old-trade', 'old-user')]);
  const oldResult = await pending;
  assert.equal(oldResult.ok, false);
  assert.equal(h.run('j7TrackerFomoCache.length'), 0);
  const current = await h.fomo();
  assert.equal(current.ok, true);
  assert.equal(current.events[0].handle, 'new-user');
  assert.doesNotMatch(JSON.stringify(current.events), /old-user/);
});

await test('an old-account history failure cannot poison a switched account', async () => {
  const oldHistory = deferred();
  let round = 0;
  const h = harness({ historyRoute: () => (++round === 1 ? oldHistory.promise : [fomoRecord('new-trade', 'new-user')]) });
  const pending = h.fomo();
  while (!h.socketCalls.length) await new Promise(resolve => setTimeout(resolve, 1));
  h.switchSession('fixture-token-b', 'account-b');
  oldHistory.reject(new Error('old account network failure'));
  assert.equal((await pending).ok, false);
  assert.equal(h.store.j7TrackerSessionV1.token, 'fixture-token-b');
  assert.notEqual(h.store.j7TrackerSyncStateV1?.reason, 'network');
  const current = await h.fomo();
  assert.equal(current.ok, true);
  assert.equal(current.events[0].handle, 'new-user');
});

await test('an old-account REST auth failure cannot clear a switched account', async () => {
  const oldFomo = deferred();
  const oldPump = deferred();
  let oldCalls = 0;
  const h = harness({
    fetchRoute: (url, options) => {
      if (String(options.headers.Authorization).includes('fixture-token-b')) {
        return response(url.endsWith('/api/fomo/list') ? { fomo_users: [] } : { pump_users: [] });
      }
      oldCalls += 1;
      return oldCalls === 1 ? oldFomo.promise : oldPump.promise;
    },
    historyRoute: () => [],
  });
  const pending = h.fomo();
  while (h.fetchCalls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  h.switchSession('fixture-token-b', 'account-b');
  oldFomo.resolve(response({ error: 'Invalid token' }, 401));
  oldPump.resolve(response({ error: 'Invalid token' }, 401));
  assert.equal((await pending).ok, false);
  assert.equal(h.store.j7TrackerSessionV1.token, 'fixture-token-b');
  const current = await h.fomo();
  assert.equal(current.ok, true);
});

await test('malformed history acknowledgements fail without publishing authoritative empty history', async () => {
  const h = harness({ historyRoute: () => ({ rawAck: true, value: {} }) });
  const result = await h.fomo();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
  assert.equal(h.run('j7TrackerHistoryAt'), 0);
});

await test('REST deadline covers body decoding and releases config work for retry', async () => {
  let stall = true;
  const h = harness({
    fetchRoute: (_url, options) => {
      if (!stall) return response({ fomo_users: [], pump_users: [] });
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
      };
    },
  });
  const first = await h.run('refreshJ7TrackerState(true)');
  assert.equal(first, false);
  assert.equal(h.store.j7TrackerSyncStateV1.reason, 'network');
  stall = false;
  h.advance(16000);
  const second = await h.run('refreshJ7TrackerState(false)');
  assert.equal(second, true);
  assert.equal(h.store.j7TrackerSyncStateV1.connected, true);
});

await test('session-update messages are accepted only from J7Tracker pages', async () => {
  const h = harness();
  const denied = await h.message({ type: 'j7tracker-session-updated' }, { url: 'https://gmgn.ai/' });
  assert.equal(denied.ok, false);
  const deniedSubdomain = await h.message({ type: 'j7tracker-session-updated' }, { url: 'https://docs.j7tracker.io/' });
  assert.equal(deniedSubdomain.ok, false);
  const allowed = await h.message({ type: 'j7tracker-session-updated' }, { url: 'https://j7tracker.io/' });
  assert.equal(typeof allowed.ok, 'boolean');
});
