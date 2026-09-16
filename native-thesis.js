(() => {
  'use strict';
  // MAIN only. Borrow GMGN's observed read/subscription contracts, never chart controls.
  if (window.__gdhNativeThesisStarted) return;
  window.__gdhNativeThesisStarted = true;
  const DEMAND = 'data-gdh-thesis-demand', RESULT = 'data-gdh-thesis-result';
  const CHAINS = new Set(['sol', 'eth', 'bsc', 'base', 'robinhood', 'arc', 'monad']);
  const MAX_ITEMS = 200, MAX_BATCH = 1000, DEADLINE = 10000, MIN_INTERVAL = 3000;
  let active = null, lastRequest = '', lastStart = -Infinity, blockedUntil = 0;
  let failures = 0, pageGone = false, runtime = null;
  const recent = new Map();
  const normal = (chain, address) => chain === 'sol' ? address : address.toLowerCase();
  const addressOK = (chain, address) => typeof address === 'string'
    && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(address);
  function demand() {
    try {
      const raw = document.documentElement?.getAttribute(DEMAND);
      if (!raw || raw.length > 512) return null;
      const d = JSON.parse(raw);
      if (!d || Object.keys(d).sort().join(',') !== 'address,chain,requestId,v' || d.v !== 1
        || typeof d.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/.test(d.requestId)
        || !CHAINS.has(d.chain) || !addressOK(d.chain, d.address)) return null;
      return d;
    } catch { return null; }
  }
  function eligible(d) {
    if (!d || pageGone || document.visibilityState !== 'visible' || location.origin !== 'https://gmgn.ai') return false;
    const route = /^\/([^/]+)\/token\/([^/]+)\/?$/.exec(location.pathname);
    if (!route || route[1] !== d.chain || !addressOK(d.chain, route[2])
      || normal(d.chain, route[2]) !== normal(d.chain, d.address)) return false;
    const host = document.getElementById('gdh-community-thesis');
    if (!host?.isConnected || host.getAttribute('data-active') !== '1' || !host.getClientRects().length) return false;
    const rect = host.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    for (let el = host; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (el.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || Number(style.opacity) === 0 || el.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  }
  const same = (a, b) => a && b && a.requestId === b.requestId && a.chain === b.chain && a.address === b.address;
  function publish(d, status, items = [], error) {
    const root = document.documentElement;
    if (!root) return;
    const value = { v: 1, requestId: d.requestId, chain: d.chain, address: d.address, status, items, coverage: 'limited' };
    if (error) value.error = error;
    if (error === 'rate_limited') value.retryAfterMs = Math.max(500, Math.min(30000, Math.max(lastStart + MIN_INTERVAL, blockedUntil) - Date.now()));
    root.setAttribute(RESULT, JSON.stringify(value));
    document.dispatchEvent(new Event('gdh-thesis-result'));
  }
  const unsubscribe = sub => { try { sub?.unsubscribe(); } catch { /* native teardown must not strand other resources */ } };
  function stop(code = 'demand_stopped', status = 'stopped') {
    const s = active;
    if (!s) return;
    active = null; // Invalidate before unsubscribe: native finalizers can emit synchronously.
    clearInterval(s.guard); clearTimeout(s.deadline);
    for (const sub of s.subs) unsubscribe(sub);
    s.unwatch?.(); s.rows = []; s.buffer = [];
    publish(s.d, status, [], code);
  }
  function current(s) {
    if (active !== s) return false;
    if (!same(s.d, demand()) || !eligible(s.d)) { stop('scope_changed'); return false; }
    return true;
  }
  function adapter() {
    if (runtime) return runtime;
    const chunks = window.webpackChunk_N_E;
    if (!Array.isArray(chunks)) return null;
    const factories = new Map();
    for (const chunk of chunks) for (const [id, fn] of Object.entries(chunk[1] || {})) factories.set(Number(id), fn);
    const source = String(factories.get(463958) || '');
    const chart = String(factories.get(180292) || '');
    if (!['getFomoThesisObservable', 'thesisPairMgr', 'removeSubscribePair', 'reconnectionSubject'].every(x => source.includes(x))
      || !chart.includes('/pf/api/v1/fomo/thesis/token') || !chart.includes('fomo_thesis')
      || ![902286, 165523, 277891].every(id => factories.has(id))) return null;
    let require;
    chunks.push([[`gdh-thesis-${Date.now()}`], {}, r => { require = r; }]);
    if (typeof require !== 'function') return null;
    const api = require(902286).Ay, registry = require(165523).NK, socket = require(463958), constants = require(277891);
    if (typeof api?.get !== 'function' || typeof registry?.has !== 'function'
      || typeof registry?.getTradingViewConfig !== 'function' || typeof socket?.getQuotationSocketMgr !== 'function'
      || constants?.Uw?.DONE !== 2 || constants?.MV?.invalidAccessToken !== 10001) return null;
    runtime = { api, registry, socket };
    return runtime;
  }
  const text = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n) : '';
  function avatar(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
      const url = new URL(value);
      // Only observed public image hosts; never pass signed queries, userinfo or fragments.
      if (url.protocol !== 'https:' || url.username || url.password
        || !['prod-fomo-profile-pics.s3.amazonaws.com', 'gmgn.ai', 'pbs.twimg.com'].includes(url.hostname)) return '';
      url.search = ''; url.hash = '';
      return url.href;
    } catch { return ''; }
  }
  function sanitize(batch, d) {
    if (!Array.isArray(batch) || batch.length > MAX_BATCH) return null;
    const rows = [];
    for (const item of batch) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
        || item.chain !== d.chain || !addressOK(d.chain, item.token_address)
        || normal(d.chain, item.token_address) !== normal(d.chain, d.address)
        || typeof item.thesis !== 'string' || !item.thesis.trim() || item.thesis.length > 20000
        || ['author_name','author_handle'].some(k => typeof item[k] === 'string' && item[k].length > 200)
        || !Number.isSafeInteger(item.fomo_created_at) || item.fomo_created_at <= 0
        || item.fomo_created_at > Date.now() + 300000) return null;
      rows.push({ id: item.id, chain: d.chain, token_address: normal(d.chain, item.token_address),
        token_symbol: text(item.token_symbol, 100), author_name: text(item.author_name, 200),
        author_handle: text(item.author_handle, 200), author_avatar_url: avatar(item.author_avatar_url),
        author_is_dev: item.author_is_dev === true, thesis: text(item.thesis, 20000),
        like_count: Number.isSafeInteger(item.like_count) && item.like_count >= 0 ? item.like_count : null,
        fomo_created_at: item.fomo_created_at });
    }
    return rows;
  }
  function merge(...groups) {
    const rows = new Map();
    for (const group of groups) for (const item of group) rows.set(`${item.chain}/${item.token_address}/${item.id}`, item);
    return [...rows.values()].sort((a, b) => b.fomo_created_at - a.fomo_created_at || a.id.localeCompare(b.id)).slice(0, MAX_ITEMS);
  }
  function emit(s) {
    if (!current(s)) return;
    const error = s.restError || s.streamError;
    publish(s.d, error ? 'error' : s.pending ? 'loading' : s.live ? 'streaming' : 'snapshot', s.rows, error);
  }
  function authError(error) {
    return [401, 403, 10001].includes(Number(error?.status ?? error?.response?.status ?? error?.code));
  }
  function fail(s, lane, code, error) {
    if (!current(s)) return;
    if (authError(error)) { stop('native_auth_failure', 'error'); return; }
    if (lane === 'rest') {
      clearTimeout(s.deadline); s.pending = false; s.restError = code;
      unsubscribe(s.restSub);
      s.rows = merge(s.rows, s.buffer); s.buffer = [];
      failures = Math.min(failures + 1, 4);
      blockedUntil = Date.now() + Math.min(30000, MIN_INTERVAL * (2 ** failures));
    } else { s.streamError = code; s.live = false; }
    emit(s);
  }
  function own(s, observable, observer) {
    if (!observable || typeof observable.subscribe !== 'function') throw new Error('contract');
    const sub = observable.subscribe(observer);
    if (!sub || typeof sub.unsubscribe !== 'function') throw new Error('contract');
    if (active === s) s.subs.push(sub); else unsubscribe(sub);
    return sub;
  }
  function watchSocket(s) {
    const socket = s.manager.webSocket;
    if (s.watchedSocket === socket) return;
    s.unwatch?.(); s.watchedSocket = socket;
    if (!socket?.addEventListener) return;
    const close = () => {
      if (!current(s)) return;
      s.live = false; s.streamError = 'native_disconnected'; emit(s);
    };
    const message = event => {
      if (!current(s) || typeof event.data !== 'string' || event.data.length > 16384) return;
      try {
        const value = JSON.parse(event.data);
        if (authError(value) || (value.channel === 'ack' && Array.isArray(value.data) && value.data.some(authError))) {
          stop('native_auth_failure', 'error');
        }
      } catch { /* Not a thesis/auth frame. Native socket owns parsing. */ }
    };
    socket.addEventListener('close', close); socket.addEventListener('message', message);
    s.unwatch = () => { socket.removeEventListener('close', close); socket.removeEventListener('message', message); };
  }
  function start(d) {
    const s = { d, subs: [], rows: [], buffer: [], pending: true, live: false, restError: '', streamError: '' };
    active = s; publish(d, 'loading');
    // Result delivery can synchronously unmount/replace the isolated UI.
    if (!current(s)) return;
    let native;
    try {
      native = adapter();
      if (!native || !native.registry.has(d.chain)
        || !native.registry.getTradingViewConfig(d.chain)?.markSupportList?.includes('fomo_thesis')) throw new Error('contract');
      s.manager = native.socket.getQuotationSocketMgr();
      if (typeof s.manager?.getFomoThesisSocket !== 'function' || typeof s.manager?.getConnectionState !== 'function'
        || typeof s.manager?.reconnectionSubject?.subscribe !== 'function') throw new Error('contract');
      watchSocket(s);
      s.guard = setInterval(() => {
        if (!current(s)) return;
        watchSocket(s);
        if (s.manager.getConnectionState() !== 2 && !s.streamError) {
          s.live = false; s.streamError = 'native_disconnected'; emit(s);
        }
      }, 250); // Local lifecycle only; never polls an endpoint.
      own(s, s.manager.reconnectionSubject, { next: () => {
        if (!current(s)) return;
        watchSocket(s); s.live = false; s.streamError = 'native_reconnected_gap'; emit(s);
        // Native manager replays its refcounted subscription. No synthetic socket/retry/history request.
      }, error: error => fail(s, 'stream', 'native_stream_error', error) });
      if (!current(s)) return;
      try {
        own(s, s.manager.getFomoThesisSocket().getFomoThesisObservable({ chain: d.chain, token: normal(d.chain, d.address) }), {
          next: batch => {
            if (!current(s)) return;
            const rows = sanitize(batch, d);
            if (!rows) { fail(s, 'stream', 'malformed_stream'); return; }
            if (!rows.length) return; // An empty observable seed is not streaming evidence.
            s.live = true; s.streamError = '';
            if (s.pending) s.buffer = merge(s.buffer, rows);
            else s.rows = merge(s.rows, rows);
            emit(s);
          }, error: error => fail(s, 'stream', 'native_stream_error', error),
          complete: () => fail(s, 'stream', 'native_stream_closed')
        });
      } catch (error) { fail(s, 'stream', 'native_stream_unavailable', error); }
      if (!current(s)) return;
      s.deadline = setTimeout(() => {
        if (!current(s) || !s.pending) return;
        fail(s, 'rest', 'snapshot_timeout');
      }, DEADLINE);
      try {
        s.restSub = own(s, native.api.get({ url: '/pf/api/v1/fomo/thesis/token', data: { chain: d.chain, token: normal(d.chain, d.address), limit: 50 } }), {
          next: value => {
            if (!current(s) || !s.pending) return;
            if (authError(value)) { stop('native_auth_failure', 'error'); return; }
            if (value?.code !== undefined && value.code !== 0) { fail(s, 'rest', 'snapshot_failed'); return; }
            const rows = sanitize(value?.items, d);
            if (!rows) { fail(s, 'rest', 'malformed_snapshot'); return; }
            clearTimeout(s.deadline); s.pending = false; failures = 0;
            unsubscribe(s.restSub);
            s.rows = merge(rows, s.buffer); s.buffer = []; emit(s);
          }, error: error => { if (s.pending) fail(s, 'rest', 'snapshot_failed', error); },
          complete: () => { if (s.pending) fail(s, 'rest', 'snapshot_missing'); }
        });
        if (!s.pending) unsubscribe(s.restSub);
      } catch (error) { fail(s, 'rest', 'snapshot_failed', error); }
    } catch { if (active === s) stop('native_unavailable', 'error'); }
  }
  function reconcile() {
    const d = demand();
    if (active && (!same(active.d, d) || !eligible(d))) stop('scope_changed');
    if (!eligible(d) || active) return;
    if (d.requestId === lastRequest) return;
    lastRequest = d.requestId;
    const now = Date.now();
    for (const [id, at] of recent) if (now - at > 60000) recent.delete(id);
    if (recent.has(d.requestId) || now - lastStart < MIN_INTERVAL || now < blockedUntil || recent.size >= 32) {
      publish(d, 'error', [], 'rate_limited'); return;
    }
    recent.set(d.requestId, now); lastStart = now;
    start(d);
  }
  document.addEventListener('gdh-thesis-demand', reconcile);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') stop('hidden'); });
  window.addEventListener('pagehide', () => { pageGone = true; stop('pagehide'); });
  window.addEventListener('pageshow', () => { pageGone = false; });
  window.addEventListener('popstate', () => { if (active && !eligible(active.d)) stop('route_changed'); });
  const observer = new MutationObserver(() => { if (active && (!same(active.d, demand()) || !eligible(active.d))) stop('scope_changed'); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: [DEMAND, 'data-active', 'class', 'style', 'hidden', 'aria-hidden'] });
  // Native tgInfo writes are account boundaries, including same-document writes (storage events omit these).
  // Observe only the key, never read/copy storage values, IDs, tokens or native account objects.
  const boundary = () => stop('account_changed');
  window.addEventListener('storage', event => { if (event.key === 'tgInfo' || event.key === null) boundary(); });
  try {
    const proto = window.Storage.prototype;
    for (const method of ['setItem', 'removeItem', 'clear']) {
      const original = proto[method];
      proto[method] = function (...args) {
        if (this === window.localStorage && (method === 'clear' || args[0] === 'tgInfo')) boundary();
        return Reflect.apply(original, this, args);
      };
    }
  } catch { /* Locked native storage prototype: fail closed rather than miss same-document account boundaries. */
    pageGone = true;
  }
  reconcile();
})();
