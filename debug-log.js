/* Standalone MV3 diagnostics. Load once in the background worker.
 * Storage: debugLogging (strict boolean opt-in), gdhDebugLogV1 (sanitized v1 ring).
 * Records are flat: {at, kind, ...allowedFields}. No free-form text is accepted.
 * Request: endpoint, status (0 or HTTP 100..599), durationMs, count, received,
 * retained, reason. Collector/render fields are counts; lifecycle uses event/reason.
 * All counters are integers in [0, 1e6]; durations are capped at 10 minutes.
 * dropped counts invalid records and capacity evictions (not normal TTL expiry).
 * Unknown fields/invalid individual values are omitted, never string-coerced.
 * Parent may forward storage flag changes with setEnabled(newValue === true).
 * One worker owns this ring; this is not a cross-context transactional store.
 */
(() => {
  'use strict';
  const KEY = 'gdhDebugLogV1';
  const MAX = 500;
  const TTL = 24 * 60 * 60 * 1000;
  const COUNT_CAP = 1000000;
  const DURATION_CAP = 600000;
  const ENDPOINTS = new Set(['current-following', 'user-swaps', 'user-balances',
    'social-feed', 'token-thesis', 'token-metadata', 'friends', 'trade-profile',
    'user-profile', 'trading-activity', 'following-profiles', 'other']);
  const REASONS = new Set(['success', 'network', 'backoff', 'not-connected', 'error',
    'no-native-rows', 'rendered', 'ok', 'http-error', 'network-error', 'timeout', 'aborted',
    'rate-limited', 'unauthorized', 'forbidden', 'not-found', 'invalid-response',
    'page-cap', 'exhausted', 'overlap', 'baseline', 'pagination-stalled', 'fetch-failed', 'complete', 'page-limit', 'cursor-stalled', 'empty', 'cache-hit', 'cache-miss', 'filtered', 'missing-profile', 'missing-symbol',
    'missing-mc', 'coverage-gap', 'disabled', 'startup', 'manual', 'other']);
  const EVENTS = new Set(['startup', 'enabled', 'disabled', 'refresh', 'collector-start',
    'collector-end', 'render-start', 'render-end', 'cache-reset', 'worker-start', 'other']);
  const COUNTERS = Object.freeze({
    request: ['count', 'received', 'retained'],
    collector: ['received', 'retained', 'missingProfiles', 'missingSymbols', 'missingMC',
      'buy', 'sell', 'thesis', 'coverageGap', 'count', 'attempted', 'succeeded',
      'rejected', 'unsupported', 'usersAttempted', 'usersTotal'],
    render: ['received', 'eligible', 'placed', 'filtered', 'count', 'missingProfiles',
      'missingSymbols', 'missingMC'],
    passive: ['received', 'retained', 'rejected', 'unsupported'],
    pagination: ['pages', 'received'],
    lifecycle: []
  });
  let entries = [];
  let dropped = 0;
  let enabled = false;
  let override;
  let ignoreRestore = false;
  let initialized = false;
  let dirty = false;
  let timer = null;
  let flushQueued = false;
  let queue = Promise.resolve();

  // Own data properties only: getters, inherited fields and coercions are not run.
  function own(object, key) {
    if (!object || typeof object !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; }
    catch { return undefined; }
  }
  function number(value, cap = COUNT_CAP) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.min(cap, Math.floor(value)) : undefined;
  }
  function addDropped(n = 1) { dropped = Math.min(COUNT_CAP, dropped + n); }
  function sanitize(kind, fields, at, now) {
    if (typeof kind !== 'string' || !Object.hasOwn(COUNTERS, kind)) return null;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > now) return null;
    if (now - at >= TTL) return null;
    const out = { at, kind };
    for (const key of COUNTERS[kind]) {
      const value = number(own(fields, key));
      if (value !== undefined) out[key] = value;
    }
    if (kind === 'collector' && typeof own(fields, 'coverageGap') === 'boolean') out.coverageGap=own(fields,'coverageGap');
    const reason = own(fields, 'reason');
    if (REASONS.has(reason)) out.reason = reason;
    if (kind === 'passive') {
      const status=own(fields,'status'), event=own(fields,'event');
      if (['waiting-for-fomo-tab','waiting-for-account','waiting-for-following','waiting-for-activity','connected','disconnected'].includes(status)) out.status=status;
      if (['account','following','activity','connection','logout','expired','tab-closed','rejected'].includes(event)) out.event=event;
    }
    if (kind === 'pagination') {
      const endpoint=own(fields,'endpoint');
      if (ENDPOINTS.has(endpoint)) out.endpoint=endpoint;
      for (const key of ['hasMore','cursorAdvanced']) if (typeof own(fields,key)==='boolean') out[key]=own(fields,key);
    }
    if (kind === 'request') {
      const endpoint = own(fields, 'endpoint');
      if (ENDPOINTS.has(endpoint)) out.endpoint = endpoint;
      const status = own(fields, 'status');
      if (Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599))) out.status = status;
      const duration = number(own(fields, 'durationMs'), DURATION_CAP);
      if (duration !== undefined) out.durationMs = duration;
    } else if (kind === 'render') {
      const source = own(fields, 'source');
      if (source === 'gmgn' || source === 'debot') out.source = source;
    } else if (kind === 'lifecycle') {
      const event = own(fields, 'event');
      if (EVENTS.has(event)) out.event = event;
    }
    return out;
  }
  function prune() {
    const now = Date.now();
    // In-memory entries are private and already sanitized. Keep the hot record
    // path cheap; perform full field sanitization again at snapshot/export.
    const clean = entries.filter(entry => entry.at <= now && now - entry.at < TTL);
    if (clean.length !== entries.length) dirty = true;
    entries = clean;
    if (entries.length > MAX) {
      addDropped(entries.length - MAX);
      entries = entries.slice(-MAX);
      dirty = true;
    }
  }
  function snapshot() {
    prune();
    const now = Date.now();
    return { version: 1, dropped,
      entries: entries.map(entry => sanitize(entry.kind, entry, entry.at, now)).filter(Boolean) };
  }
  function storage() { return globalThis.chrome?.storage?.local; }
  // Every write (including clear/config) uses this chain. Failures are swallowed;
  // logs remain in memory and a later record/export can retry persistence.
  function enqueue(operation) {
    queue = queue.then(operation).catch(() => false);
    return queue;
  }
  async function write(payload) {
    try {
      const local = storage();
      if (!local) return false;
      await local.set(payload);
      return true;
    } catch { return false; }
  }
  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    if (!initialized || timer !== null || flushQueued || !dirty) return;
    timer = setTimeout(() => { timer = null; void flush(); }, 1000);
  }
  function flush() {
    cancelTimer();
    if (flushQueued) return queue;
    flushQueued = true;
    const result = enqueue(async () => {
      if (!dirty) return true;
      const data = snapshot();
      dirty = false;
      const ok = await write({ [KEY]: data });
      if (!ok) dirty = true;
      return ok;
    });
    // Do not run an endless retry timer when storage is broken.
    return result.then(ok => {
      flushQueued = false;
      if (ok && dirty) schedule();
      return ok;
    });
  }
  const ready = (async () => {
    try {
      const saved = await storage()?.get(['debugLogging', KEY]);
      enabled = override === undefined ? own(saved, 'debugLogging') === true : override;
      if (!ignoreRestore) {
        const blob = own(saved, KEY);
        if (own(blob, 'version') === 1) {
          dropped = number(own(blob, 'dropped')) ?? 0;
          const restored = own(blob, 'entries');
          if (Array.isArray(restored)) {
            // Only the newest 500 are inspected; hostile oversized storage cannot
            // create an unbounded runtime ring or export.
            addDropped(Math.max(0, restored.length - MAX));
            const now = Date.now();
            for (let i = Math.max(0, restored.length - MAX); i < restored.length; i++) {
              const entry = own(restored, String(i));
              const at = own(entry, 'at');
              const clean = sanitize(own(entry, 'kind'), entry, at, now);
              if (clean) entries.push(clean);
              else if (!(typeof at === 'number' && at <= now && now - at >= TTL)) addDropped();
            }
          }
        }
        // Rewrite restored data through the allowlist, even while disabled.
        if (blob !== undefined) dirty = true;
      }
    } catch { enabled = override === true; }
    initialized = true;
    schedule();
  })();

  globalThis.gdhDebug = Object.freeze({
    ready,
    get enabled() { return initialized && enabled; },
    record(kind, fields = {}) {
      if (!initialized || !enabled) return false;
      prune();
      const now = Date.now();
      const entry = sanitize(kind, fields, now, now);
      if (!entry) addDropped();
      else {
        // Coalesce successful requests by endpoint into ten-second buckets.
        // Keep failures and pagination records individually visible.
        if (entry.kind==='request' && entry.reason==='success') {
          const prior=entries.findLast(e=>e.kind==='request' && e.reason==='success' && e.endpoint===entry.endpoint && e.status===entry.status && Math.floor(e.at/10000)===Math.floor(now/10000));
          if (prior) { prior.count=Math.min(COUNT_CAP,(prior.count||1)+1); prior.durationMs=Math.max(prior.durationMs||0,entry.durationMs||0); dirty=true; schedule(); return true; }
          entry.count=1;
        }
        if (entries.length === MAX) { entries.shift(); addDropped(); }
        entries.push(entry);
      }
      dirty = true;
      schedule();
      return entry !== null;
    },
    setEnabled(value) {
      const flag = value === true;
      const changed = !initialized || enabled !== flag;
      override = flag;
      enabled = flag;
      // A storage.onChanged echo sees the same state and does not write again.
      if (!changed) return ready.then(() => true);
      return enqueue(async () => { await ready; return write({ debugLogging: flag }); });
    },
    clear() {
      ignoreRestore = true;
      entries = [];
      dropped = 0;
      dirty = false;
      cancelTimer();
      // Capture empty now; a later record is persisted by a later batch. Waiting
      // for earlier writes prevents an in-flight snapshot resurrecting old logs.
      return enqueue(async () => {
        await ready;
        const ok = await write({ [KEY]: { version: 1, dropped: 0, entries: [] } });
        if (!ok) dirty = true;
        return ok;
      });
    },
    async export() {
      await ready;
      prune();
      await flush();
      const data = snapshot();
      let extensionVersion = null;
      try {
        const version = globalThis.chrome?.runtime?.getManifest()?.version;
        if (typeof version === 'string' && version.length <= 23 && /^\d+(?:\.\d+){0,3}$/.test(version)) extensionVersion = version;
      } catch { /* Never include exception messages or environment identifiers. */ }
      return {
        schema: 'gdh-debug-log', version: 1, capturedAt: Date.now(), enabled,
        dropped: data.dropped,
        caps: { maxEntries: MAX, ttlMs: TTL, maxCount: COUNT_CAP, maxDurationMs: DURATION_CAP },
        environment: { extensionVersion }, entries: data.entries
      };
    }
  });
})();
