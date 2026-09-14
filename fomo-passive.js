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
    clearTrending();
    accountId = ''; epoch++; pending.length = 0; pendingFollowing = null; roster = null; accountProof = '';
    emit('logout', { reason });
  };
  function account(value, proof) {
    const next = id(value?.id);
    if (!next) return;
    if (next !== accountId) {
      const initial = !accountId && epoch === 0;
      accountId = next; epoch++; roster = null;
      if (!initial) clearTrending();
      if (!initial) { pending.length = 0; pendingFollowing = null; }
    }
    accountProof = proof;
    emit('account', { proof });
    if (trendingDirty || trending) scheduleTrending();
    if (pendingFollowing) { following(pendingFollowing); pendingFollowing = null; }
    for (const entry of pending.splice(0)) activity(entry.items, entry.transport, entry.topicId);
  }
  // One native topic/socket, bounded full list so removals beyond top100 remain correct.
  // No native wire sequence exists: ordered trusted socket delivery plus fail-closed parsing.
  let trending = null, trendingTimer = null, trendingDirty = false, trendingSnapshot = false;
  const networks = {1:'eth',56:'bsc',8453:'base',143:'monad',4663:'robinhood',1399811149:'sol'};
  function clearTrending() {
    trending = null; trendingSnapshot = false; scheduleTrending();
  }
  function scheduleTrending() {
    trendingDirty = true;
    if (trendingTimer !== null) return;
    trendingTimer = setTimeout(() => {
      trendingTimer = null;
      if (!accountId || !trendingDirty) return;
      trendingDirty = false;
      const fresh = trending && Date.now() - trending.at >= 0 && Date.now() - trending.at < 300000;
      const view = fresh ? nativeTrendingView() : null;
      emit('trending', {available:!!fresh, viewMode:view ? 'native-view' : 'stream',
        items:fresh ? (view || trending.rows.slice(0,100).map(r => r.dto)).map((r,i) => ({...r,rank:i+1})) : [],
        nativeSnapshot:trendingSnapshot, observedAt:fresh ? trending.at : Date.now()});
      trendingSnapshot = false;
    }, 250);
  }
  function trendingRow(raw) {
    const t = raw?.token, n = t?.networkId;
    if (!['string','number'].includes(typeof n) || !/^[0-9]+$/.test(String(n)) || !networks[Number(n)]) return null;
    const networkId = Number(n), address = t.address;
    if (typeof address !== 'string' || !(networkId === 1399811149 ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(address)) return null;
    const text = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120) : '';
    const number = (v,signed=false) => {
      if (!['string','number'].includes(typeof v) || String(v).trim() === '') return null;
      const x=Number(v); return Number.isFinite(x) && Math.abs(x)<=Number.MAX_SAFE_INTEGER && (signed || x>=0) ? x : null;
    };
    const price=number(raw.priceUSD), supply=number(t.info?.totalSupply), ratio=number(raw.change24,true);
    return {key:`${address}:${networkId}`, dto:{chain:networks[networkId],networkId,address,symbol:text(t.symbol),name:text(t.name),price,
      marketCap:price !== null && supply !== null ? number(price*supply) : null,
      change24Percent:ratio !== null ? number(ratio*100,true) : null}};
  }
  function trendingFrame(message, socket, socketEpoch) {
    if (socketEpoch !== epoch && !(socketEpoch === 0 && epoch === 1)) return;
    const topic = message.topicId;
    // Only a validated full snapshot may replace the current topic/socket owner.
    if (trending && (trending.socket !== socket || trending.topic !== topic) &&
        !(message.type === 'data' && message.payload?.kind === 'snapshot')) return;
    if (typeof topic !== 'string' || topic.length > 100 || !/^[0-9]+(,[0-9]+)*$/.test(topic) ||
        topic.split(',').some(n => !networks[n]) || new Set(topic.split(',')).size !== topic.split(',').length) { clearTrending(); return; }
    // Native FOMO suspends Trending after 3s hidden but retains its token list.
    // Keep the original observation time; acknowledgment is not fresh data.
    if (message.type === 'unsubscribed') { if (trending) trending.paused = true; return; }
    if (message.type === 'error') { clearTrending(); return; }
    if (message.type !== 'data') return;
    const p = message.payload;
    if (trending?.paused && p?.kind !== 'snapshot') return;
    if (!object(p)) { clearTrending(); return; }
    if (p.kind === 'snapshot') {
      if (!Array.isArray(p.tokens) || p.tokens.length > 1000) { clearTrending(); return; }
      const rows = p.tokens.map(trendingRow);
      if (rows.some(r => !r || !topic.split(',').includes(String(r.dto.networkId))) || new Set(rows.map(r => r.key)).size !== rows.length) { clearTrending(); return; }
      trending = {socket,topic,rows,at:Date.now()}; trendingSnapshot = true;
    } else {
      if (!trending || trending.socket !== socket || trending.topic !== topic || Date.now()-trending.at >= 300000 || Date.now()<trending.at) { clearTrending(); return; }
      const rows = trending.rows, index = rows.findIndex(r => r.key === p.tokenKey);
      if (p.kind === 'remove') {
        if (index < 0) { clearTrending(); return; }
        rows.splice(index,1);
      } else if (p.kind === 'new' || p.kind === 'update') {
        const row = trendingRow(p.update);
        if (!row || row.key !== p.tokenKey || !topic.split(',').includes(String(row.dto.networkId)) || !Number.isInteger(p.index) || p.index < 0 || p.index > rows.length - (index >= 0 ? 1 : 0) || (index < 0 && rows.length >= 1000)) { clearTrending(); return; }
        if (index >= 0) rows.splice(index,1);
        rows.splice(p.index,0,row);
      } else { clearTrending(); return; }
      trending.at = Date.now();
    }
    scheduleTrending();
  }
  // The committed view supplies native filtering/freeze membership. Stream data
  // remains the fallback; never guess missing descriptors or retain old overlays.
  function nativeTrendingView() {
    try {
      const view = window.__gdhFomoNativeView?.read();
      if (!view || view.hiddenFilters !== true || view.hoverFreeze !== true ||
          !Array.isArray(view.items) || view.items.length > 100 || !Array.isArray(view.prices) || view.prices.length > 100) return null;
      const identity = r => {
        if (!Number.isSafeInteger(r?.networkId) || !networks[r.networkId] || typeof r.address !== 'string' ||
            !(r.networkId === 1399811149 ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(r.address) ||
            r.key !== `${r.address}:${r.networkId}`) return null;
        return `${r.networkId}:${r.networkId === 1399811149 ? r.address : r.address.toLowerCase()}`;
      };
      const number = (n,signed=false) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n)<=Number.MAX_SAFE_INTEGER && (signed || n>=0) ? n : null;
      const text = s => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120) : '';
      const metrics = r => {
        const price=number(r.price), supply=number(r.totalSupply);
        return {price,marketCap:price !== null && supply !== null ? number(price*supply) : null,change24Percent:number(r.change24Percent,true)};
      };
      const live = new Map(trending.rows.map(r => [identity({...r.dto,key:r.key}),r.dto]));
      const rows=[], keys=new Set(), overlays=new Map();
      for (const item of view.items) {
        const key=identity(item);
        if (!key || keys.has(key)) return null;
        keys.add(key);
        const base = item.snapshot ? {chain:networks[item.networkId],networkId:item.networkId,address:item.address,
          symbol:text(item.snapshot.symbol),name:text(item.snapshot.name),...metrics(item.snapshot),priceSource:'native-frozen'} : live.get(key);
        if (!base) return null;
        rows.push({...base,priceSource:base.priceSource || 'stream'});
      }
      for (const price of view.prices) {
        const key=identity(price);
        if (!key || !keys.has(key) || overlays.has(key) || typeof price.chartOverride !== 'boolean') return null;
        overlays.set(key,price);
      }
      return rows.map(row => {
        const price=overlays.get(identity({...row,key:`${row.address}:${row.networkId}`}));
        return price ? {...row,...metrics(price),priceSource:price.chartOverride ? 'native-chart' : 'native-row'} : row;
      });
    } catch { return null; }
  }
  let stopNativeView = null;
  function observeNativeView() {
    try { if (!stopNativeView) stopNativeView = window.__gdhFomoNativeView?.observe(() => { if (trending && !suspended) scheduleTrending(); }) || null; } catch { /* Optional adapter must not affect native traffic. */ }
  }
  observeNativeView();
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
        const socketEpoch = epoch;
        sockets.add(socket);
        socket.addEventListener('open', () => { lastTransportAt = Date.now(); connection('native-open'); });
        socket.addEventListener('close', () => { sockets.delete(socket); if (trending?.socket === socket) { if (trending.paused) trending.socket = null; else clearTrending(); } connection('native-close'); });
        socket.addEventListener('error', () => { if (trending?.socket === socket) clearTrending(); connection('native-error'); });
        socket.addEventListener('message', event => {
          try {
            if (!event.isTrusted) return;
            if (typeof event.data !== 'string' || event.data.length > 2000000) { if (trending?.socket === socket) clearTrending(); return; }
            const message = JSON.parse(event.data);
            if (!object(message)) return;
            lastTransportAt = Date.now();
            if (message.topicType === 'trending_tokens') trendingFrame(message, socket, socketEpoch);
            if (message.topicType === 'trading_activity' && id(message.topicId)) {
              if (message.type === 'subscribed' || message.type === 'data') subscribed.set(socket, message.topicId);
              if (message.type === 'unsubscribed') subscribed.delete(socket);
              if (message.type === 'data') { activity([message.payload], 'websocket', message.topicId); connection('native-activity'); }
            }
            if (['challengeAccepted', 'subscribed', 'unsubscribed'].includes(message.type)) connection(`native-${message.type}`);
          } catch { if (trending?.socket === socket) clearTrending(); }
        });
      } catch { /* Leave non-FOMO sockets untouched. */ }
      return socket;
    }
  });
  window.addEventListener('pagehide', () => { suspended = true; stopNativeView?.(); stopNativeView=null; clearTrending(); connection('pagehide'); });
  window.addEventListener('pageshow', () => { suspended = false; observeNativeView(); connection('pageshow'); });
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
  let readyReplayed = false;
  window.addEventListener('message', event => {
    if (readyReplayed || event.source !== window || event.origin !== location.origin || event.data?.source !== 'gdh-fomo-passive-ready-v1') return;
    readyReplayed = true;
    if (accountId) { emit('account', {proof:accountProof}); if (roster) emit('following',{followingIds:roster}); }
    if (trending) { trendingSnapshot = true; scheduleTrending(); }
  });
  connection('observer-ready');
})();
