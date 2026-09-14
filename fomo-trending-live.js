/* Owned Trending transport. Classic worker script; no storage, REST or Following I/O. */
(() => {
  'use strict';
  if (Object.prototype.hasOwnProperty.call(globalThis, 'gdhCreateTrendingLive')) return;
  const URL = 'wss://prod-api.fomo.family/ws';
  const TOPIC = '56,143,4663,8453,1399811149';
  const NETWORKS = Object.freeze({56:'bsc',143:'monad',4663:'robinhood',8453:'base',1399811149:'sol'});
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const metric = (v, signed = false) => {
    if (!['string','number'].includes(typeof v) || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER && (signed || n >= 0) ? n : null;
  };
  const text = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120) : '';
  function identity(address, network) {
    if (!['string','number'].includes(typeof network) || !/^(56|143|4663|8453|1399811149)$/.test(String(network))) return null;
    const networkId = Number(network), sol = networkId === 1399811149;
    if (typeof address !== 'string' || !(sol ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(address)) return null;
    return {networkId, address:sol ? address : address.toLowerCase()};
  }
  function key(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split(':');
    const id = parts.length === 2 && identity(parts[0],parts[1]);
    return id ? `${id.address}:${id.networkId}` : null;
  }
  function row(raw) {
    if (!object(raw) || !object(raw.token)) return null;
    const id = identity(raw.token.address,raw.token.networkId);
    if (!id) return null;
    const k = `${id.address}:${id.networkId}`;
    if (raw.tokenKey !== undefined && key(raw.tokenKey) !== k) return null;
    const price = metric(raw.priceUSD), supply = metric(raw.token.info?.totalSupply), ratio = metric(raw.change24,true);
    return {key:k,dto:{...id,chain:NETWORKS[id.networkId],symbol:text(raw.token.symbol),name:text(raw.token.name),price,
      marketCap:price !== null && supply !== null ? metric(price*supply) : null,
      change24Percent:ratio !== null ? metric(ratio*100,true) : null,source:'fomo-trending'}};
  }
  function create(options) {
    if (!options || typeof options.getSession !== 'function' || typeof options.onUpdate !== 'function') throw new TypeError('Trending callbacks required');
    const WS = options.WebSocket || globalThis.WebSocket;
    const now = options.now || Date.now, later = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    const cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis), random = options.random || Math.random;
    let active = false, generation = 0, socket = null, status = 'not-connected';
    let rows = [], fetchedAt = null, baseline = false, sessionKey = null, expiresAt = 0;
    let authenticated = false, authSent = false, authPending = false, authRequest = 0, challenges = 0, failures = 0;
    let updateTimer = null, deadline = null, expiryTimer = null, staleTimer = null;
    const timers = new Set();
    const current = g => active && g === generation;
    function timer(fn, ms, g = generation) {
      const id = later(() => { timers.delete(id); if (current(g)) fn(); }, ms);
      timers.add(id); return id;
    }
    function clear(id) { if (id !== null) { cancel(id); timers.delete(id); } }
    function snapshot() {
      const age = now()-fetchedAt;
      const live = active && authenticated && baseline && status === 'live' && now() < expiresAt;
      const fresh = live || (fetchedAt !== null && age >= 0 && age < 300000);
      return Object.freeze({ok:live,source:'fomo-trending',provenance:'owned-stream',status:live ? 'live' : status === 'live' ? 'not-connected' : status,
        items:Object.freeze((fresh ? rows.slice(0,100) : []).map((r,i) => Object.freeze({...r.dto,rank:i+1}))),fetchedAt:fresh ? fetchedAt : 0});
    }
    function publish(immediate = false) {
      if (immediate) {
        clear(updateTimer); updateTimer = null;
        try { options.onUpdate(snapshot()); } catch (_) { /* Consumer cannot break transport. */ }
      } else if (updateTimer === null) {
        updateTimer = timer(() => { updateTimer = null; publish(true); },250);
      }
    }
    function wipe() { rows = []; fetchedAt = null; baseline = false; }
    function invalidate() {
      generation++;
      for (const id of timers) cancel(id);
      timers.clear(); updateTimer = deadline = expiryTimer = staleTimer = null;
      const old = socket; socket = null;
      authenticated = authSent = authPending = baseline = false;
      authRequest++; challenges = 0; expiresAt = 0;
      if (old) { try { old.close(); } catch (_) {} }
    }
    function halt(next = 'not-connected') {
      invalidate(); active = false; sessionKey = null; wipe(); status = next; publish(true);
    }
    function retainDeadline() {
      clear(staleTimer);
      if (fetchedAt !== null) staleTimer = timer(() => { wipe(); publish(); },Math.max(0,300000-(now()-fetchedAt)));
    }
    function retry(invalid = false) {
      if (!active) return;
      invalidate(); if (invalid) wipe();
      failures++;
      status = failures >= 8 ? 'error' : 'reconnecting';
      retainDeadline(); publish();
      if (failures < 8) {
        const jitter = Math.min(1,Math.max(0,Number(random()) || 0));
        timer(connect,Math.min(30000,1000*2**(failures-1)*(1+0.2*jitter)));
      }
    }
    function validSession(s) {
      return object(s) && typeof s.token === 'string' && s.token.length > 0 &&
        typeof s.sessionKey === 'string' && s.sessionKey.length > 0 && Number.isFinite(s.expiresAt) && s.expiresAt > now();
    }
    function adopt(s,g) {
      if (!current(g)) return false;
      if (!validSession(s)) { halt(); return false; }
      if (sessionKey !== null && sessionKey !== s.sessionKey) {
        invalidate(); wipe(); sessionKey = null; failures = 0; status = 'connecting'; publish(true); void connect(); return false;
      }
      sessionKey = s.sessionKey; expiresAt = s.expiresAt;
      clear(expiryTimer);
      // JWT expiry is an auth boundary, never a transport retry or heartbeat.
      expiryTimer = timer(() => halt(),Math.min(2147483647,expiresAt-now()),g);
      return true;
    }
    function send(value,g) {
      if (!current(g)) return false;
      if (now() >= expiresAt) { halt(); return false; }
      if (!socket || socket.readyState !== 1) { retry(); return false; }
      try { socket.send(JSON.stringify(value)); return true; } catch (_) { retry(); return false; }
    }
    async function respond(g) {
      const request = ++authRequest; authPending = true;
      let s;
      try { s = await options.getSession(); } catch (_) { if (current(g) && request === authRequest) halt('error'); return; }
      if (!current(g) || request !== authRequest) return;
      authPending = false;
      if (!adopt(s,g)) return;
      authSent = send({type:'challengeResponse',jwt:s.token},g);
    }
    function apply(payload) {
      if (!object(payload)) return false;
      if (payload.kind === 'snapshot') {
        if (!Array.isArray(payload.tokens) || payload.tokens.length > 1000) return false;
        const next = payload.tokens.map(row);
        if (next.some(r => !r) || new Set(next.map(r => r.key)).size !== next.length) return false;
        rows = next; baseline = true;
      } else {
        if (!baseline) return false;
        const k = key(payload.tokenKey);
        if (!k) return false;
        const old = rows.findIndex(r => r.key === k);
        if (payload.kind === 'remove') { if (old >= 0) rows.splice(old,1); }
        else if (payload.kind === 'new' || payload.kind === 'update') {
          const next = row(payload.update);
          if (!next || next.key !== k || !Number.isSafeInteger(payload.index) || (old < 0 && rows.length >= 1000)) return false;
          if (old >= 0) rows.splice(old,1);
          rows.splice(Math.max(0,Math.min(rows.length,payload.index)),0,next);
        } else return false;
      }
      fetchedAt = now(); status = 'live'; failures = 0;
      clear(deadline); deadline = null; clear(staleTimer); staleTimer = null;
      publish(); return true;
    }
    function message(event,g) {
      if (!current(g)) return;
      if (now() >= expiresAt) { halt(); return; }
      let m;
      try { if (typeof event.data !== 'string' || event.data.length > 4000000) throw new Error(); m = JSON.parse(event.data); }
      catch (_) { retry(true); return; }
      if (!object(m) || typeof m.type !== 'string') { retry(true); return; }
      if (m.type === 'challenge') {
        if (++challenges > 3) { halt('error'); return; }
        if (authenticated) {
          authenticated = authSent = baseline = false;
          status = 'connecting'; retainDeadline(); publish();
          clear(deadline); deadline = timer(() => retry(),15000,g);
        }
        void respond(g); return;
      }
      if (m.type === 'challengeAccepted') {
        if (authenticated) return;
        if (!authSent || authPending) { halt('error'); return; }
        authenticated = true;
        clear(deadline);
        deadline = timer(() => retry(true),15000,g);
        send({type:'subscribe',topicType:'trending_tokens',topicId:TOPIC},g); return;
      }
      if (['challengeRejected','authenticationError','authError','unauthorized'].includes(m.type) || m.type === 'error') { halt('error'); return; }
      if (m.topicType !== 'trending_tokens') {
        if (['data','subscribed','unsubscribed'].includes(m.type) && m.topicType === undefined) retry(true);
        return;
      }
      if (m.topicId !== TOPIC) { retry(true); return; }
      if (!authenticated) { retry(true); return; }
      if (m.type === 'subscribed') return;
      if (m.type === 'unsubscribed') { retry(true); return; }
      if (m.type !== 'data' || !apply(m.payload)) retry(true);
    }
    async function connect() {
      if (!active) return;
      invalidate(); const g = generation;
      status = failures ? 'reconnecting' : 'connecting'; retainDeadline(); publish();
      deadline = timer(() => retry(),15000,g);
      let s;
      try { s = await options.getSession(); } catch (_) { if (current(g)) halt('error'); return; }
      if (!adopt(s,g)) return;
      try {
        const ws = new WS(URL); socket = ws;
        ws.addEventListener('open',() => { if (current(g)) void respond(g); });
        ws.addEventListener('message',e => message(e,g));
        ws.addEventListener('error',() => { if (current(g)) retry(); });
        ws.addEventListener('close',e => {
          if (!current(g)) return;
          if ([1008,4001,4003,4401,4403].includes(e.code)) halt('error'); else retry();
        });
      } catch (_) { if (current(g)) retry(); }
    }
    return Object.freeze({
      start() { if (!active) { active = true; failures = 0; void connect(); } return snapshot(); },
      stop() { halt(); return snapshot(); },
      refresh() { if (active) { failures = 0; void connect(); } return snapshot(); },
      getSnapshot: snapshot
    });
  }
  Object.freeze(create);
  Object.defineProperty(globalThis,'gdhCreateTrendingLive',{value:create,writable:false,configurable:false,enumerable:false});
})();
