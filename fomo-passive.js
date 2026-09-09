(() => {
  'use strict';
  // MAIN-world, receive-only observer. No credentials, sends, subscriptions or I/O timers.
  // Public transport: token-v2-Bx0fYhry.js handleMessage/dispatchPayload:
  // {type:'data',topicType:'trading_activity',topicId:<account>,payload:<item>}.
  if (location.origin !== 'https://fomo.family' || window.top !== window || window.__gdhFomoPassive) return;
  Object.defineProperty(window, '__gdhFomoPassive', { value: true });
  const post = window.postMessage.bind(window);
  let accountId = '', epoch = 0, seq = 0, lastActivityAt = 0, lastTransportAt = 0;
  let suspended = false, pendingFollowing = null, roster = null, accountProof = '';
  const subscribed = new WeakMap();
  const sockets = new Set(), pending = [];
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,160}$/.test(value) ? value : '';
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const emit = (kind, fields = {}) => post({ source: 'gdh-fomo-passive-v1', kind, accountId,
    epoch, seq: ++seq, observedAt: Date.now(), ...fields }, location.origin);
  const connection = reason => emit('connection', { connected: !suspended && [...sockets].some(s => s.readyState === 1 && accountId && subscribed.get(s) === accountId),
    reason, visibility: document.visibilityState, lastActivityAt, lastTransportAt,
    alertsRequired: 'unknown' });
  const logout = reason => {
    accountId = ''; epoch++; pending.length = 0; pendingFollowing = null; roster = null; accountProof = '';
    emit('logout', { reason });
  };
  function account(value, proof) {
    const next = id(value?.id);
    if (!next) return;
    if (next !== accountId) {
      const initial = !accountId && epoch === 0;
      accountId = next; epoch++; roster = null;
      if (!initial) { pending.length = 0; pendingFollowing = null; }
    }
    accountProof = proof;
    emit('account', { proof });
    if (pendingFollowing) { following(pendingFollowing); pendingFollowing = null; }
    for (const entry of pending.splice(0)) activity(entry.items, entry.transport, entry.topicId);
  }
  function following(values) {
    if (!Array.isArray(values) || values.length > 10000 || values.some(v => !id(v))) return;
    const followingIds = [...new Set(values)];
    if (!accountId) { if (epoch === 0) pendingFollowing = followingIds; return; }
    roster = followingIds;
    emit('following', { followingIds });
  }
  function item(raw) {
    if (!object(raw) || !id(raw.id) || !['swap_buy', 'swap_sell', 'transfer_in', 'transfer_out',
      'multi_user_buy', 'multi_user_sell', 'thesis', 'user_trade_profit_milestone'].includes(raw.type)) return null;
    const out = { id: raw.id, type: raw.type };
    // Deliberate flat allowlist; never raw nested objects, auth, headers, wallet keys, or HTML.
    for (const key of ['userId', 'tradeId', 'swapId', 'txHash', 'tokenAddress', 'networkId']) if (id(raw[key])) out[key] = raw[key];
    for (const key of ['userHandle', 'displayName', 'ticker', 'createdAt']) {
      if (typeof raw[key] === 'string' && raw[key].length <= 256) out[key] = raw[key];
    }
    for (const key of ['usdAmount', 'marketCap', 'fdv']) {
      if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) out[key] = raw[key];
    }
    if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) out.createdAt = raw.createdAt;
    if (Number.isSafeInteger(raw.networkId) && raw.networkId >= 0) out.networkId = raw.networkId;
    for (const key of ['profilePictureLink', 'tokenImageUrl']) {
      try { if (typeof raw[key] === 'string' && raw[key].length <= 2048) {
        const u = new URL(raw[key]);
        if (u.protocol === 'https:' && !u.username && !u.password) out[key] = raw[key];
      } } catch {}
    }
    if (raw.type === 'thesis' && object(raw.comment)) {
      out.comment = {};
      if (id(raw.comment.id)) out.comment.id = raw.comment.id;
      if (typeof raw.comment.comment === 'string' && raw.comment.comment.length <= 4000) out.comment.comment = raw.comment.comment;
    }
    if (raw.type === 'thesis' && object(raw.authorTrade)) {
      out.authorTrade = {};
      for (const key of ['usdValue', 'percentageRealizedPnl', 'percentageUnrealizedPnl'])
        if (typeof raw.authorTrade[key] === 'number' && Number.isFinite(raw.authorTrade[key])) out.authorTrade[key] = raw.authorTrade[key];
      if (typeof raw.authorTrade.closedAt === 'string' && raw.authorTrade.closedAt.length <= 64) out.authorTrade.closedAt = raw.authorTrade.closedAt;
    }
    if (typeof raw.verified === 'boolean') out.verified = raw.verified;
    return out;
  }
  function activity(rawItems, transport, topicId = '') {
    if (!Array.isArray(rawItems)) return;
    const items = rawItems.slice(0, 1000).map(item).filter(Boolean);
    if (!items.length) return;
    if (!accountId) {
      if (epoch === 0 && pending.length < 10) pending.push({ items, transport, topicId });
      return;
    }
    if (transport === 'websocket' && topicId !== accountId) return;
    lastActivityAt = Date.now();
    for (let i = 0; i < items.length; i += 100) emit('activity', { items: items.slice(i, i + 100), transport });
  }
  function endpoint(raw, method = 'GET') {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== 'https://prod-api.fomo.family') return '';
      if (method === 'POST' && url.pathname === '/v2/users') return 'registration';
      if (method !== 'GET') return '';
      return ({ '/v2/users/current': 'account', '/v2/users/current/followingIds': 'following',
        '/feed/tradingActivity': 'activity' })[url.pathname] || '';
    } catch { return ''; }
  }
  function received(kind, body, status, startedEpoch) {
    // Concurrent first-load roster/feed may finish after initial identity binds.
    // Never permit this exception for account responses or after logout/switch.
    if (startedEpoch !== epoch && !(startedEpoch === 0 && epoch === 1 && ['following', 'activity'].includes(kind))) return;
    if (status === 401 && ['account', 'registration', 'following'].includes(kind)) { logout('native-unauthorized'); return; }
    if (status < 200 || status >= 300 || !object(body) || body.success === false ||
      (body.statusCode != null && body.statusCode !== 200) || !object(body.responseObject)) return;
    lastTransportAt = Date.now();
    const value = body.responseObject;
    if (kind === 'account' || kind === 'registration') account(value, kind === 'account' ? 'native-current-user' : 'native-registration');
    else if (kind === 'following') following(value.followingIds);
    else if (kind === 'activity') activity(value.items, 'rest');
    connection('native-rest');
  }
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const startedEpoch = epoch;
    const response = Reflect.apply(nativeFetch, this, args);
    try {
      const kind = endpoint(typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url,
        String(args[1]?.method || args[0]?.method || 'GET').toUpperCase());
      if (kind) response.then(res => {
        // Clone never consumes/modifies the page's response body.
        if (res.status === 401) { received(kind, null, res.status, startedEpoch); return; }
        if (res.url && !endpoint(res.url, kind === 'registration' ? 'POST' : 'GET')) return;
        if (Number(res.headers.get('content-length')) > 2000000) return;
        res.clone().text().then(text => { if (text.length <= 2000000) received(kind, JSON.parse(text), res.status, startedEpoch); }).catch(() => {});
      }).catch(() => {});
    } catch { /* Observation must not affect native execution. */ }
    return response;
  };
  const nativeOpen = XMLHttpRequest.prototype.open, nativeSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const result = Reflect.apply(nativeOpen, this, [method, url, ...rest]);
    requests.set(this, endpoint(url, String(method).toUpperCase()));
    return result;
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const kind = requests.get(this), startedEpoch = epoch;
    if (kind) this.addEventListener('load', () => {
      try {
        if (this.responseURL && !endpoint(this.responseURL, kind === 'registration' ? 'POST' : 'GET')) return;
        if (this.status === 401) { received(kind, null, this.status, startedEpoch); return; }
        const body = this.responseType === 'json' ? this.response :
          ((!this.responseType || this.responseType === 'text') && this.responseText.length <= 2000000 ? JSON.parse(this.responseText) : null);
        received(kind, body, this.status, startedEpoch);
      } catch { /* Unsupported response types are ignored. */ }
    }, { once: true });
    return Reflect.apply(nativeSend, this, args);
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      try {
        const url = new URL(socket.url);
        if (url.origin !== 'wss://prod-api.fomo.family' || url.pathname !== '/ws') return socket;
        sockets.add(socket);
        socket.addEventListener('open', () => { lastTransportAt = Date.now(); connection('native-open'); });
        socket.addEventListener('close', () => { sockets.delete(socket); connection('native-close'); });
        socket.addEventListener('error', () => connection('native-error'));
        socket.addEventListener('message', event => {
          try {
            if (!event.isTrusted || typeof event.data !== 'string' || event.data.length > 2000000) return;
            const message = JSON.parse(event.data);
            if (!object(message)) return;
            lastTransportAt = Date.now();
            if (message.topicType === 'trading_activity' && id(message.topicId)) {
              if (message.type === 'subscribed' || message.type === 'data') subscribed.set(socket, message.topicId);
              if (message.type === 'unsubscribed') subscribed.delete(socket);
              if (message.type === 'data') { activity([message.payload], 'websocket', message.topicId); connection('native-activity'); }
            }
            if (['challengeAccepted', 'subscribed', 'unsubscribed'].includes(message.type)) connection(`native-${message.type}`);
          } catch { /* Not a supported FOMO frame. */ }
        });
      } catch { /* Leave non-FOMO sockets untouched. */ }
      return socket;
    }
  });
  window.addEventListener('pagehide', () => { suspended = true; connection('pagehide'); });
  window.addEventListener('pageshow', () => { suspended = false; connection('pageshow'); });
  document.addEventListener('visibilitychange', () => connection('visibilitychange'));
  window.addEventListener('offline', () => connection('offline'));
  window.addEventListener('online', () => connection('online'));
  // Local liveness only. Never a provider heartbeat; no network call in this timer.
  setInterval(() => {
    if (accountId && !suspended) {
      emit('account', { proof: accountProof });
      if (roster) emit('following', { followingIds: roster });
    }
    connection('observer-alive');
  }, 20000);
  connection('observer-ready');
})();
