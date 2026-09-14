/* Owned Trending authentication only. No timers that keep pages/workers alive.
 * importScripts('fomo-trending-session.js');
 * const auth = gdhCreateTrendingSession({chrome, fetch, onInvalidate(reason) { ... }});
 * Options: chrome (Promise storage.local/session, tabs.get, webNavigation.getFrame,
 * runtime.id), fetch, now=Date.now, onInvalidate=()=>{}, verificationTtlMs=60000,
 * verificationTimeoutMs=8000. Optional setTimeout/clearTimeout for offline tests.
 * Worker-only API: getSession() -> {token, expiresAt, sessionKey}|null;
 * revoke() -> Promise (immediately invalidates; await durable logout);
 * observeAccount(id) -> Promise: ONLY after validated native account ingestion.
 * Empty id means logout. After logout ONLY a new validated native account event
 * rearms admission; a fresh authoritative mirror is also required.
 * handleMirror(message,sender) -> Promise<{ok:boolean}>; forward only the exact
 * fomo-auth-mirror-v1 runtime type. Never forward getSession results to UI/pages.
 * Hook native logout/account BEFORE any asynchronous downstream work. Do not hook
 * arbitrary page messages or storage changes as native account observations.
 * Default session key is extension-only gdhTrendingAuthV1. Do not expose session
 * storage to content scripts. Legacy fomoToken shape/refresh value is preserved;
 * this module never uses refresh credentials. Mirror replies contain no identity.
 */
(() => {
  'use strict';
  const STORE = 'gdhTrendingAuthV1';
  const TYPE = 'fomo-auth-mirror-v1';
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(id);
  const fomoUrl = raw => {
    try { const u = new URL(raw); return u.protocol === 'https:' && !u.port && !u.username && !u.password && (u.hostname === 'fomo.family' || u.hostname.endsWith('.fomo.family')); }
    catch { return false; }
  };
  function jwt(token, now) {
    try {
      if (typeof token !== 'string' || token.length > 20000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const p = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4)));
      const exp = p.exp * 1000;
      return validId(p.sub) && typeof p.exp === 'number' && Number.isFinite(exp) && exp > now ? {sub:p.sub, exp} : null;
    } catch { return null; }
  }
  function create(options = {}) {
    const c = options.chrome || globalThis.chrome;
    const fetcher = options.fetch || globalThis.fetch;
    const now = options.now || Date.now;
    const later = options.setTimeout || globalThis.setTimeout;
    const cancel = options.clearTimeout || globalThis.clearTimeout;
    const ttl = Math.max(1000, Math.min(60000, options.verificationTtlMs || 60000));
    const timeout = Math.max(100, Math.min(15000, options.verificationTimeoutMs || 8000));
    let state = {revoked:false, accountId:'', owner:null, requireMirror:false};
    let generation = 0, failed = false, cache = null, inflight = null, queue = Promise.resolve();
    const invalidate = reason => {
      generation++; cache = null;
      if (inflight) inflight.controller.abort();
      inflight = null;
      try { options.onInvalidate?.(reason); } catch { /* never log provider/credential errors */ }
    };
    const enqueue = fn => {
      const p = queue.catch(() => {}).then(fn);
      queue = p.catch(() => { failed = true; invalidate('storage-unavailable'); });
      return p;
    };
    const ready = (async () => {
      const g = generation;
      try {
        const saved = (await c.storage.session.get(STORE))?.[STORE];
        if (g !== generation) {
          // Retain document replay barriers even when a native event beats hydration.
          if (saved?.version === 1) {
            state.owner = saved.owner || null;
            if (saved.revoked || saved.requireMirror) state.requireMirror = true;
          }
          return;
        }
        if (saved) {
          if (saved.version !== 1 || typeof saved.revoked !== 'boolean') { failed = true; return; }
          state = {revoked:saved.revoked, accountId:validId(saved.accountId) ? saved.accountId : '', owner:saved.owner || null, requireMirror: saved.requireMirror === true};
        }
      } catch { failed = true; }
    })();
    const persist = () => c.storage.session.set({[STORE]:{version:1, ...state}});
    function revoke() {
      state.revoked = true; state.requireMirror = true;
      invalidate('logout');
      return enqueue(async () => { await ready; await persist(); await c.storage.local.remove('fomoToken'); });
    }
    function observeAccount(id) {
      if (!validId(id)) return revoke();
      // Invalidate synchronously, including while hydration/fetch/body is pending.
      const previous = state.accountId;
      const rearming = state.revoked;
      if (previous !== id || rearming) invalidate('account');
      state.accountId = id;
      state.revoked = false;
      if (rearming) state.requireMirror = true;
      const g = generation;
      return enqueue(async () => {
        await ready;
        if (g !== generation) return;
        state.accountId = id; state.revoked = false;
        await persist();
      });
    }
    async function current(sender) {
      if (sender?.id !== c.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 || typeof sender.documentId !== 'string' || !sender.documentId || !fomoUrl(sender.url) || sender.tab.url !== sender.url) return false;
      try {
        const tab = await c.tabs.get(sender.tab.id);
        const frame = await c.webNavigation.getFrame({tabId:sender.tab.id, frameId:0});
        return tab.url === sender.url && frame?.url === sender.url && frame.documentId === sender.documentId && (!frame.documentLifecycle || frame.documentLifecycle === 'active');
      } catch { return false; }
    }
    async function ownerAlive(owner) {
      try { const f = await c.webNavigation.getFrame({tabId:owner.tabId,frameId:0}); return f?.documentId === owner.documentId && f.url === owner.url; }
      catch { return false; }
    }
    function handleMirror(message, sender) {
      // Capture at receipt, not after storage/sender awaits.
      const g = generation;
      if (!message || message.type !== TYPE || !Number.isSafeInteger(message.seq) || message.seq < 1 || !Number.isSafeInteger(message.epoch) || message.epoch < 0 || !['token','absent','ambiguous','invalid'].includes(message.status)) return Promise.resolve({ok:false});
      const m = {seq:message.seq, epoch:message.epoch, status:message.status, token:message.token, refresh:message.refresh};
      return enqueue(async () => {
        await ready;
        if (failed || g !== generation || !await current(sender) || g !== generation) return {ok:false};
        const owner = state.owner;
        const same = owner && owner.tabId === sender.tab.id && owner.documentId === sender.documentId;
        if (owner && !same && await ownerAlive(owner)) return {ok:false};
        if (g !== generation || (same && (m.seq <= owner.seq || m.epoch < owner.epoch))) return {ok:false};
        const nextOwner = {tabId:sender.tab.id, documentId:sender.documentId, url:sender.url, seq:m.seq, epoch:m.epoch};
        if (m.status !== 'token') {
          state.owner = nextOwner; state.revoked = true; state.requireMirror = true;
          invalidate('mirror-unavailable');
          await persist(); await c.storage.local.remove('fomoToken');
          return {ok:true};
        }
        const parsed = jwt(m.token, now());
        if (!parsed || typeof m.refresh !== 'string' || m.refresh.length > 20000 || state.revoked || (state.requireMirror && same && m.epoch <= owner.epoch)) return {ok:false};
        const old = (await c.storage.local.get('fomoToken'))?.fomoToken;
        if (g !== generation || !await current(sender) || g !== generation || !jwt(m.token, now())) return {ok:false};
        const oldJwt = jwt(old?.token, now());
        state.owner = nextOwner;
        // Never rank expiries across subject/account namespaces.
        if (oldJwt?.sub === parsed.sub && oldJwt.exp > parsed.exp && !state.requireMirror) { await persist(); return {ok:true}; }
        if (oldJwt && oldJwt.sub !== parsed.sub) invalidate('token-account');
        else if (old?.token !== m.token) { generation++; cache = null; if (inflight) inflight.controller.abort(); inflight = null; }
        const writeGeneration = generation;
        state.requireMirror = false;
        await persist();
        if (writeGeneration !== generation || state.revoked) return {ok:false};
        if (old?.token !== m.token || old?.refresh !== m.refresh) await c.storage.local.set({fomoToken:{token:m.token, refresh:m.refresh, at:now(), exp:parsed.exp}});
        // A revoke queued during set removes it before resolving its durable promise.
        return {ok:writeGeneration === generation && !state.revoked};
      }).catch(() => ({ok:false}));
    }
    async function verify(token, parsed, g) {
      if (cache?.token === token && cache.g === g && cache.until > now()) return cache.id;
      if (inflight?.token === token && inflight.g === g) return inflight.promise;
      if (inflight) inflight.controller.abort();
      const controller = new AbortController();
      let timer;
      const entry = {token,g,controller,promise:null};
      entry.promise = (async () => {
        let id = null;
        try {
          const deadline = new Promise(resolve => { timer = later(() => { controller.abort(); resolve(null); }, timeout); });
          const request = (async () => {
            const r = await fetcher('https://prod-api.fomo.family/v2/users/current', {method:'GET', credentials:'omit', cache:'no-store', redirect:'error', headers:{Authorization:`Bearer ${token}`}, signal:controller.signal});
            if (!r.ok || r.status === 401 || r.status === 403 || g !== generation || parsed.exp <= now()) return null;
            const body = await r.json();
            if (body?.success === false || (body?.statusCode != null && body.statusCode !== 200)) return null;
            const user = body?.responseObject;
            return g === generation && parsed.exp > now() && !controller.signal.aborted && user?.isRestricted === false && validId(user.id) && (!state.accountId || state.accountId === user.id) ? user.id : null;
          })().catch(() => null);
          id = await Promise.race([request, deadline]);
          if (g === generation && parsed.exp > now()) cache = {token,g,id,until:Math.min(parsed.exp, now() + ttl)};
          return id;
        } finally { cancel(timer); if (inflight === entry) inflight = null; }
      })();
      inflight = entry;
      return entry.promise;
    }
    async function getSession() {
      const g = generation;
      await ready;
      await queue;
      if (g !== generation || failed || state.revoked || state.requireMirror) return null;
      let stored;
      try { stored = (await c.storage.local.get('fomoToken'))?.fomoToken; } catch { return null; }
      if (g !== generation || state.revoked) return null;
      const parsed = jwt(stored?.token, now());
      if (!parsed) return null;
      const id = await verify(stored.token, parsed, g);
      if (!id || g !== generation || state.revoked || parsed.exp <= now()) return null;
      // Legacy refresh writers are outside this broker; guard their rotation too.
      try { if ((await c.storage.local.get('fomoToken'))?.fomoToken?.token !== stored.token) return null; } catch { return null; }
      if (g !== generation || state.revoked || parsed.exp <= now()) return null;
      return {token:stored.token, expiresAt:parsed.exp, sessionKey:id};
    }
    return Object.freeze({getSession, revoke, observeAccount, handleMirror});
  }
  Object.defineProperty(globalThis, 'gdhCreateTrendingSession', {value:create, writable:false, configurable:false});
})();
