#!/usr/bin/env node
// Deterministic tests against the shipped source, not a duplicate implementation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../debug-log.js', import.meta.url), 'utf8');
const KEY = 'gdhDebugLogV1';
const NOW = 1800000000000;
const TTL = 86400000;
const clone = value => JSON.parse(JSON.stringify(value));
const pump = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function harness(initial = {}, options = {}) {
  const state = options.state ?? clone(initial);
  const timers = new Map();
  const writes = [];
  let now = options.now ?? NOW;
  let sequence = 0;
  let active = 0;
  let maxActive = 0;
  const controls = { failGet: false, failSet: false, gate: null, getGate: null, onSet: null };
  Object.assign(controls, options.controls);
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: Clock,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      runtime: { getManifest: () => ({ version: options.version ?? '1.2.3', name: 'PRIVATE-MACHINE-NAME' }) },
      storage: { local: {
        async get() {
          if (controls.getGate) await controls.getGate.promise;
          if (controls.failGet) throw new Error('PRIVATE GET ERROR');
          return clone(state);
        },
        async set(payload) {
          writes.push(clone(payload));
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            if (controls.gate) { const gate = controls.gate; controls.gate = null; await gate.promise; }
            if (controls.failSet) throw new Error('PRIVATE SET ERROR');
            Object.assign(state, clone(payload));
            controls.onSet?.(clone(payload));
          } finally { active--; }
        }
      } }
    }
  });
  vm.runInContext(source, context, { filename: 'debug-log.js' });
  return {
    api: context.gdhDebug, state, timers, writes, controls,
    maxActive: () => maxActive,
    async advance(ms) {
      now += ms;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) { if (timers.delete(id)) timer.fn(); }
      await pump();
    },
    async report() { return clone(await context.gdhDebug.export()); }
  };
}

test('pagination is private and successful request bursts coalesce without hiding failures', async()=>{
  const h=harness({debugLogging:true}); await h.api.ready;
  for(let i=0;i<12;i++) h.api.record('request',{endpoint:'user-swaps',status:200,reason:'success',durationMs:i+1});
  for(let i=0;i<2;i++) h.api.record('request',{endpoint:'user-swaps',status:429,reason:'http-error'});
  h.api.record('pagination',{endpoint:'trading-activity',pages:3,received:150,hasMore:true,cursorAdvanced:false,reason:'cursor-stalled',cursor:'PRIVATE-CURSOR',userId:'PRIVATE-USER'});
  let out=await h.report(); assert.equal(out.entries.length,4);
  assert.equal(out.entries[0].count,12); assert.equal(out.entries[0].durationMs,12);
  assert.equal(out.entries[3].hasMore,true); assert.equal(out.entries[3].cursorAdvanced,false);
  assert.equal(out.entries[3].reason,'cursor-stalled'); assert.ok(!JSON.stringify(out).includes('PRIVATE'));
  await h.advance(10000); h.api.record('request',{endpoint:'user-swaps',status:200,reason:'success'});
  out=await h.report(); assert.equal(out.entries.length,5);
  const restart=harness(h.state); await restart.api.ready; assert.equal((await restart.report()).entries[3].pages,3);
});

test('tracker lifecycle and scroll diagnostics survive export without private fields',async()=>{
  const h=harness({debugLogging:true});await h.api.ready;
  for(const event of ['surface-created','validation-deferred','validation-failed','surface-destroyed','validation-recovered','scroll']) h.api.record('render',{source:'gmgn',event,failure:'stamp-timeout',surfaceId:3,scrollY:3500,nativeY:2200,visible:4,extent:8000,viewportHeight:900,pendingMs:1501,token:'PRIVATE',html:'PRIVATE',stack:'PRIVATE'});
  h.api.record('render',{event:'PRIVATE',failure:'PRIVATE',scrollY:-1,nativeY:Infinity});
  const out=await h.report();assert.equal(out.entries.length,7);assert.equal(out.entries[2].failure,'stamp-timeout');assert.equal(out.entries[5].scrollY,3500);assert.equal(out.entries[5].visible,4);assert.ok(!JSON.stringify(out).includes('PRIVATE'));assert.equal(out.entries[6].event,undefined);assert.equal(out.entries[6].scrollY,undefined);
  const restart=harness(h.state);await restart.api.ready;assert.equal((await restart.report()).entries[5].nativeY,2200);
});

test('passive connection diagnostics never export document or account identifiers',async()=>{
  const h=harness({debugLogging:true});await h.api.ready;
  h.api.record('passive',{status:'disconnected',event:'tab-closed',received:10,accountId:'PRIVATE',bridgeId:'PRIVATE',documentId:'PRIVATE',items:['PRIVATE']});
  const out=await h.report();assert.equal(out.entries[0].status,'disconnected');assert.equal(out.entries[0].event,'tab-closed');assert.equal(out.entries[0].received,10);assert.ok(!JSON.stringify(out).includes('PRIVATE'));
});

test('off by default, strict true opt-in, disable retains records, flag echo is idempotent', async () => {
  for (const value of [undefined, false, 'true', 1]) {
    const h = harness(value === undefined ? {} : { debugLogging: value });
    assert.equal(h.api.record('request', { endpoint: 'friends' }), false);
    await h.api.ready;
    assert.equal(h.api.record('request', { endpoint: 'friends' }), false);
    assert.equal((await h.report()).entries.length, 0);
    assert.equal(h.writes.length, 0);
  }
  const h = harness();
  await h.api.ready;
  h.controls.onSet = payload => {
    if ('debugLogging' in payload) void h.api.setEnabled(payload.debugLogging);
  };
  assert.equal(h.api.enabled, false);
  await h.api.setEnabled(true);
  assert.equal(h.api.enabled, true);
  assert.equal(h.state.debugLogging, true);
  assert.equal(h.api.record('request', { endpoint: 'friends' }), true);
  await h.api.setEnabled(false);
  assert.equal(h.api.record('collector', { received: 99 }), false);
  const report = await h.report();
  assert.equal(report.enabled, false);
  assert.equal(report.entries.length, 1);
  assert.equal(h.writes.filter(w => 'debugLogging' in w).length, 2);
});

test('exact allowlist strips secrets, objects, getters, invalid enums and injected timestamps', async () => {
  const h = harness({ debugLogging: true });
  await h.api.ready;
  const secret = 'SECRET-0x123-https://user:token@example.test';
  const fields = {
    endpoint: secret, status: '200', durationMs: Infinity, count: secret,
    reason: secret, at: 123, kind: 'lifecycle', url: secret, address: secret,
    token: secret, cookie: secret, comments: secret, username: secret,
    id: secret, payload: { nested: secret }, toJSON() { throw new Error(secret); }
  };
  Object.defineProperty(fields, 'received', { get() { throw new Error('getter invoked'); } });
  assert.equal(h.api.record('request', fields), true);
  assert.equal(h.api.record(secret, fields), false);
  assert.equal(h.api.record('__proto__', fields), false);
  assert.equal(h.api.record({ toString() { throw new Error('coercion'); } }, fields), false);
  h.api.record('collector', Object.create({ received: 555 }));
  h.api.record('render', { source: secret, received: -1, eligible: NaN, placed: {}, filtered: '9' });
  const report = await h.report();
  assert.deepEqual(report.entries, [
    { at: NOW, kind: 'request' }, { at: NOW, kind: 'collector' }, { at: NOW, kind: 'render' }
  ]);
  assert.equal(report.dropped, 3);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(h.state).includes(secret));
  assert.deepEqual(Object.keys(report).sort(), ['schema', 'version', 'capturedAt', 'enabled', 'dropped', 'caps', 'environment', 'entries'].sort());
  assert.deepEqual(report.environment, { extensionVersion: '1.2.3' });
  assert.equal(report.schema, 'gdh-debug-log');
  assert.deepEqual(report.caps, { maxEntries: 500, ttlMs: TTL, maxCount: 1000000, maxDurationMs: 600000 });
});

test('parent request, collector and renderer contracts plus numeric report caps', async () => {
  const h = harness({ debugLogging: true });
  await h.api.ready;
  for (const endpoint of ['current-following', 'user-swaps', 'user-balances', 'social-feed',
    'token-thesis', 'token-metadata', 'friends', 'trade-profile', 'user-profile', 'other']) {
    h.api.record('request', { endpoint, status: 200, durationMs: 13.9, count: 2, reason: 'success' });
  }
  for (const reason of ['http-error', 'network', 'backoff', 'not-connected', 'invalid-response', 'error']) {
    h.api.record('request', { endpoint: 'other', reason, status: 0 });
  }
  const collector = { received: 1, retained: 2, missingProfiles: 3, missingSymbols: 4,
    missingMC: 5, buy: 6, sell: 7, thesis: 8, coverageGap: 9,
    attempted: 10, succeeded: 11, rejected: 12, usersAttempted: 13, usersTotal: 14 };
  h.api.record('collector', collector);
  for (const reason of ['disabled', 'no-native-rows', 'filtered', 'rendered']) {
    h.api.record('render', { source: 'gmgn', received: 8, eligible: 6, placed: 5, filtered: 3,
      missingProfiles: 1, missingSymbols: 2, missingMC: 3, reason });
  }
  h.api.record('render', { source: 'gmgn' });
  h.api.record('lifecycle', { event: 'startup', reason: 'startup', address: 'DROP' });
  h.api.record('request', { count: 1e99, durationMs: 1e99, status: 999 });
  const report = await h.report();
  assert.equal(report.entries.length, 24);
  assert.equal(report.entries[0].durationMs, 13);
  assert.deepEqual(report.entries[16], { at: NOW, kind: 'collector', ...collector });
  assert.equal(report.entries[20].reason, 'rendered');
  assert.equal(report.entries[21].source, 'gmgn');
  assert.deepEqual(report.entries[22], { at: NOW, kind: 'lifecycle', reason: 'startup', event: 'startup' });
  assert.deepEqual(report.entries[23], { at: NOW, kind: 'request', count: 1000000, durationMs: 600000 });
});

test('500-entry ring, drop accounting, one-second batching, detached export', async () => {
  const h = harness({ debugLogging: true });
  await h.api.ready;
  for (let i = 0; i < 750; i++) h.api.record('collector', { received: i });
  assert.equal(h.writes.length, 0);
  assert.equal(h.timers.size, 1);
  await h.advance(999);
  assert.equal(h.writes.length, 0);
  await h.advance(1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.state[KEY].entries.length, 500);
  assert.equal(h.state[KEY].dropped, 250);
  const report = await h.api.export();
  assert.equal(report.entries[0].received, 250);
  report.entries[0].received = 99999;
  report.entries.push({ username: 'SECRET' });
  assert.equal((await h.report()).entries[0].received, 250);
  assert.equal((await h.report()).entries.length, 500);
});

test('TTL expires on export while disabled and on restart, future timestamps rejected', async () => {
  const h = harness({ debugLogging: true });
  await h.api.ready;
  h.api.record('collector', { received: 1 });
  await h.api.setEnabled(false);
  await h.advance(TTL - 1);
  assert.equal((await h.report()).entries.length, 1);
  await h.advance(1);
  assert.equal((await h.report()).entries.length, 0);
  assert.equal(h.state[KEY].entries.length, 0);
  const restored = harness({ [KEY]: { version: 1, dropped: 0, entries: [
    { at: NOW - TTL, kind: 'render' }, { at: NOW + 1, kind: 'render' },
    { at: NOW - TTL + 1, kind: 'render', received: 3 }
  ] } });
  await restored.api.ready;
  assert.deepEqual((await restored.report()).entries, [{ at: NOW - TTL + 1, kind: 'render', received: 3 }]);
  assert.equal((await restored.report()).dropped, 1);
});

test('restart restores durable sanitized ring and flag, hostile storage is re-sanitized', async () => {
  const h = harness({ debugLogging: true });
  await h.api.ready;
  h.api.record('render', { placed: 7, source: 'gmgn' });
  await h.advance(1000);
  const restarted = harness({}, { state: h.state, now: NOW + 2000 });
  await restarted.api.ready;
  assert.deepEqual((await restarted.report()).entries, [{ at: NOW, kind: 'render', placed: 7, source: 'gmgn' }]);
  assert.equal((await restarted.report()).enabled, true);
  const hostile = harness({ [KEY]: { version: 1, dropped: 1e99, secret: 'PRIVATE', entries: [
    { at: NOW, kind: 'request', endpoint: 'https://PRIVATE', reason: 'PRIVATE', username: 'PRIVATE', status: 200 },
    { at: NOW, kind: 'PRIVATE' }, { at: 'PRIVATE', kind: 'render' }
  ] } }, { version: 'PRIVATE' });
  await hostile.api.ready;
  const report = await hostile.report();
  assert.deepEqual(report.entries, [{ at: NOW, kind: 'request', status: 200 }]);
  assert.equal(report.dropped, 1000000);
  assert.deepEqual(report.environment, { extensionVersion: null });
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.ok(!JSON.stringify(hostile.state).includes('PRIVATE'));
});

test('oversized restored storage bounded to newest 500 entries', async () => {
  const h = harness({ [KEY]: { version: 1, dropped: 0,
    entries: Array.from({ length: 1500 }, (_, i) => ({ at: NOW, kind: 'render', placed: i })) } });
  await h.api.ready;
  const report = await h.report();
  assert.equal(report.entries.length, 500);
  assert.equal(report.entries[0].placed, 1000);
  assert.equal(report.dropped, 1000);
  assert.equal(h.state[KEY].entries.length, 500);
});

test('clear cancels timer, serializes behind in-flight writes, survives restart', async () => {
  const h = harness({ debugLogging: true });
  await h.api.ready;
  h.api.record('render', { placed: 1 });
  await h.api.clear();
  await h.advance(1000);
  assert.equal(h.state[KEY].entries.length, 0);
  h.api.record('render', { placed: 2 });
  const gate = deferred();
  h.controls.gate = gate;
  await h.advance(1000);
  assert.equal(h.writes.at(-1)[KEY].entries[0].placed, 2);
  const cleared = h.api.clear();
  await pump();
  assert.equal(h.maxActive(), 1);
  gate.resolve();
  assert.equal(await cleared, true);
  await h.advance(1000);
  assert.equal(h.state[KEY].entries.length, 0);
  assert.equal((await h.report()).dropped, 0);
  const restarted = harness({}, { state: h.state });
  await restarted.api.ready;
  assert.equal((await restarted.report()).entries.length, 0);
});

test('records after clear are retained and in-flight batching stays bounded', async () => {
  const h = harness({ debugLogging: true });
  await h.api.ready;
  const gate = deferred();
  h.controls.gate = gate;
  h.api.record('render', { placed: 1 });
  await h.advance(1000);
  for (let i = 0; i < 20; i++) {
    h.api.record('render', { placed: i });
    await h.advance(1000);
  }
  assert.equal(h.writes.length, 1);
  assert.equal(h.timers.size, 0);
  const clear = h.api.clear();
  h.api.record('render', { placed: 777 });
  gate.resolve();
  await clear;
  await h.advance(1000);
  assert.deepEqual((await h.report()).entries, [{ at: NOW + 21000, kind: 'render', placed: 777 }]);
  assert.equal(h.state[KEY].entries[0].placed, 777);
  assert.equal(h.maxActive(), 1);
});

test('clear and opt-in before ready override restored state without resurrection', async () => {
  const getGate = deferred();
  const h = harness({ debugLogging: true, [KEY]: { version: 1, dropped: 4,
    entries: [{ at: NOW, kind: 'render', placed: 1 }] } }, { controls: { getGate } });
  const clear = h.api.clear();
  const disabled = h.api.setEnabled(false);
  getGate.resolve();
  await Promise.all([h.api.ready, clear, disabled]);
  assert.equal(h.state.debugLogging, false);
  assert.equal(h.api.enabled, false);
  assert.equal((await h.report()).enabled, false);
  assert.equal((await h.report()).entries.length, 0);
  assert.equal((await h.report()).dropped, 0);
});

test('storage failures resolve safely; later export retries log persistence and clear', async () => {
  const h = harness({}, { controls: { failGet: true, failSet: true } });
  await h.api.ready;
  assert.equal((await h.report()).enabled, false);
  assert.equal(await h.api.setEnabled(true), false);
  h.api.record('request', { reason: 'network' });
  await h.advance(1000);
  assert.equal((await h.report()).entries.length, 1);
  assert.equal(h.timers.size, 0);
  h.controls.failSet = false;
  await h.report();
  assert.equal(h.state[KEY].entries.length, 1);
  h.controls.failSet = true;
  assert.equal(await h.api.clear(), false);
  assert.equal((await h.report()).entries.length, 0);
  h.controls.failSet = false;
  await h.report();
  assert.equal(h.state[KEY].entries.length, 0);
});

test('missing Chrome storage and manifest are safe with no unhandled failures', async () => {
  const context = vm.createContext({ setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(source, context);
  const api = context.gdhDebug;
  await api.ready;
  assert.equal(await api.setEnabled(true), false);
  assert.equal(api.record('lifecycle', { event: 'startup' }), true);
  assert.equal((await api.export()).environment.extensionVersion, null);
  assert.equal(await api.clear(), false);
  assert.equal((await api.export()).entries.length, 0);
});
