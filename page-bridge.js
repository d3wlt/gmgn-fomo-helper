(() => {
  'use strict';

  if (window.__gdhPageBridgeStarted) return;
  window.__gdhPageBridgeStarted = true;

  const TOKEN_STAT_ATTRIBUTE = 'data-gdh-token-stat';
  const TOKEN_STAT_EVENT = 'gdh-token-stat';
  const HOLDING_CONFIG_REQUEST_EVENT = 'gdh-holding-config-request';
  const HOLDING_CONFIG_RESULT_EVENT = 'gdh-holding-config-result';
  const HOLDING_CONFIG_RESULT_ATTRIBUTE = 'data-gdh-holding-config-result';
  const HOLDING_CONFIG_URL = 'https://gmgn.ai/api/v1/notification/user_config_list';
  const nativeWebSocket = window.WebSocket;
  const tokenStatChains = new WeakMap();
  let holdingConfigInflight = null;

  function normalizeTokenStatAddress(value) {
    const raw = String(value || '');
    if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) ? raw : '';
  }

  function emitHoldingConfigResult(result) {
    if (!document.documentElement) return;
    document.documentElement.setAttribute(HOLDING_CONFIG_RESULT_ATTRIBUTE, JSON.stringify(result));
    document.dispatchEvent(new Event(HOLDING_CONFIG_RESULT_EVENT));
    document.documentElement.removeAttribute(HOLDING_CONFIG_RESULT_ATTRIBUTE);
  }

  function gmgnPageAccessToken() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('tgInfo') || 'null');
      const token = parsed?.token?.access_token;
      return typeof token === 'string' && token.length > 20 ? token : '';
    } catch {
      return '';
    }
  }

  function gmgnPageApiQuery() {
    try {
      const src = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('gmgn.ai/') && url.includes('device_id='));
      return src?.split('?')[1] || '';
    } catch {
      return '';
    }
  }

  function sanitizeHoldingConfig(payload) {
    const candidates = [payload, payload?.data, payload?.result];
    const rows = candidates.find((value) => Array.isArray(value));
    if (!rows) return null;
    const allowed = new Set(['sol', 'bsc', 'base', 'robinhood']);
    const sanitized = [];
    for (const row of rows) {
      const chain = String(row?.push_chain || '').trim().toLowerCase();
      const dict = row?.push_switch_dict;
      if (!allowed.has(chain) || !dict || typeof dict !== 'object'
        || !Object.prototype.hasOwnProperty.call(dict, 'holding_signal')) continue;
      sanitized.push({
        push_chain: chain,
        push_switch_dict: { holding_signal: dict.holding_signal },
      });
    }
    return sanitized.length ? sanitized : null;
  }

  async function fetchHoldingConfig() {
    const token = gmgnPageAccessToken();
    if (!token) return emitHoldingConfigResult({ ok: false, reason: 'login-required', stage: 'token' });
    let query = gmgnPageApiQuery();
    for (let attempt = 0; !query && attempt < 20; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      query = gmgnPageApiQuery();
    }
    if (!query) return emitHoldingConfigResult({ ok: false, reason: 'unavailable', stage: 'query' });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${HOLDING_CONFIG_URL}?${query}`, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const body = await response.json().catch(() => null);
      const data = response.ok && (body?.code === undefined || body?.code === 0)
        ? sanitizeHoldingConfig(body) : null;
      if (!data) {
        emitHoldingConfigResult({
          ok: false,
          reason: response.status === 401 || response.status === 403 ? 'login-required' : 'unavailable',
          stage: 'response',
          status: response.status,
        });
        return;
      }
      if (token !== gmgnPageAccessToken()) return emitHoldingConfigResult({ ok: false, reason: 'login-required', stage: 'account-changed' });
      emitHoldingConfigResult({ ok: true, data });
    } catch {
      emitHoldingConfigResult({ ok: false, reason: 'unavailable', stage: 'fetch' });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  document.addEventListener(HOLDING_CONFIG_REQUEST_EVENT, () => {
    if (holdingConfigInflight) return;
    holdingConfigInflight = fetchHoldingConfig()
      .finally(() => { holdingConfigInflight = null; });
  });

  // Request descriptors and credentials stay in MAIN. Never infer/union wallet groups.
  const nativeHoldingFetch = window.fetch;
  const holdingScopes = new Map();
  const holdingReads = new Map();
  const holdingCaptures = new Set();
  const holdingChains = new Set(['sol', 'bsc', 'base', 'robinhood']);
  let holdingAccount = '';
  let holdingSequence = 0;
  const HOLDING_SCOPE_MAX_AGE = 10 * 60 * 1000;

  function holdingAccountCurrent() {
    const token = gmgnPageAccessToken();
    if (token !== holdingAccount) {
      holdingAccount = token;
      holdingScopes.clear();
      // Keep old reads counted until their deadline; they cannot cross this account boundary.
    }
    return token;
  }

  function holdingDeadline(work, ms = 10000, controller = null) {
    let timer;
    return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = window.setTimeout(() => { controller?.abort(); reject(new Error('timeout')); }, ms);
    })]).finally(() => window.clearTimeout(timer));
  }

  function holdingRequestUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      return url.origin === location.origin && !url.username && !url.password && location.hostname === 'gmgn.ai'
        && ['/td/api/v1/wallets/holdings', '/td/api/v1/wallets/hybrid/holdings'].includes(url.pathname) ? url : null;
    } catch { return null; }
  }

  function rememberHoldingRequest(url, method, text, token, sequence, at) {
    if (!token || token !== holdingAccountCurrent()) return;
    let groups;
    let body;
    if (url.pathname.endsWith('/hybrid/holdings')) {
      if (method !== 'POST' || typeof text !== 'string' || text.length > 65536) return;
      try { body = JSON.parse(text); } catch { return; }
      groups = body?.chain_wallets;
    } else {
      if (method !== 'GET') return;
      groups = [{ chain: url.searchParams.get('chain'), wallet_addresses: url.searchParams.getAll('wallet_addresses') }];
    }
    if (!Array.isArray(groups) || !groups.length || groups.length > 8) return;
    const wallets = new Map();
    for (const group of groups) {
      const chain = group?.chain;
      if (!holdingChains.has(chain) || wallets.has(chain) || !Array.isArray(group.wallet_addresses)
        || !group.wallet_addresses.length || group.wallet_addresses.length > 100) return;
      const addresses = group.wallet_addresses.map(normalizeTokenStatAddress);
      if (addresses.some((address) => !address)) return;
      wallets.set(chain, new Set(addresses));
    }
    const descriptor = { url: url.href, method, body: body ? JSON.stringify(body) : undefined,
      wallets, token, sequence, at };
    for (const chain of wallets.keys()) {
      if ((holdingScopes.get(chain)?.sequence || 0) < sequence) holdingScopes.set(chain, descriptor);
    }
  }

  function captureHoldingRequest(input, init) {
    const url = holdingRequestUrl(typeof input === 'string' || input instanceof URL ? String(input) : input?.url);
    if (!url || holdingCaptures.size >= 8) return;
    const token = holdingAccountCurrent();
    const sequence = ++holdingSequence;
    const at = Date.now();
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    let body;
    try {
      body = () => init?.body;
      // Clone synchronously, before native fetch consumes a Request's stream.
      if (init?.body === undefined && typeof input?.clone === 'function') {
        const copy = input.clone();
        body = () => copy.text();
      }
    } catch { return; }
    const task = holdingDeadline(body).then((text) => rememberHoldingRequest(url, method, text, token, sequence, at))
      .catch(() => {}).finally(() => holdingCaptures.delete(task));
    holdingCaptures.add(task);
  }

  if (typeof nativeHoldingFetch === 'function') {
    window.fetch = function gdhObserveHoldingFetch(input, init) {
      try { captureHoldingRequest(input, init); } catch { /* preserve native request */ }
      return nativeHoldingFetch.call(this, input, init);
    };
  }
  if (window.XMLHttpRequest?.prototype) {
    const requests = new WeakMap();
    const proto = window.XMLHttpRequest.prototype;
    const open = proto.open;
    const send = proto.send;
    proto.open = function(method, url, ...rest) {
      requests.set(this, { method, url });
      return open.call(this, method, url, ...rest);
    };
    proto.send = function(body) {
      const request = requests.get(this);
      try { if (request) captureHoldingRequest(request.url, { method: request.method, body }); } catch { /* native */ }
      return send.call(this, body);
    };
  }

  function sanitizeHoldingRows(rows, wallets, chain) {
    if (!Array.isArray(rows) || rows.length > 1000) return null;
    return rows.flatMap((row) => {
      const wallet = normalizeTokenStatAddress(row?.wallet_address);
      const address = normalizeTokenStatAddress(row?.token_address || row?.token_basic_stats?.address);
      if (!wallets.has(wallet) || !address || (row?.chain && row.chain !== chain)) return [];
      const clean = { token_address: address, symbol: String(row?.token_basic_stats?.symbol || row?.symbol || '').slice(0, 24) };
      for (const field of ['balance', 'accu_amount', 'accu_cost', 'accu_fee']) {
        const value = Number(row?.[field]);
        clean[field] = Number.isFinite(value) && value >= 0 ? value : 0;
      }
      return [clean];
    });
  }

  async function readHoldingScope(descriptor) {
    if (descriptor.token !== holdingAccountCurrent()
      || ![...descriptor.wallets.keys()].some((chain) => holdingScopes.get(chain) === descriptor)) return [];
    if (holdingReads.has(descriptor)) return holdingReads.get(descriptor);
    if (holdingReads.size >= 4) return [];
    const controller = new AbortController();
    const task = holdingDeadline(async () => {
      const response = await nativeHoldingFetch.call(window, descriptor.url, {
        method: descriptor.method, body: descriptor.body, credentials: 'include', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      });
      const payload = await response.json();
      if (!response.ok || payload?.code !== 0 || descriptor.token !== holdingAccountCurrent()) return [];
      const hybrid = descriptor.method === 'POST';
      const list = hybrid ? payload?.data?.list : [{ chain: [...descriptor.wallets.keys()][0], holdings: payload?.data?.holdings }];
      if (!Array.isArray(list)) return [];
      const results = [];
      for (const [chain, wallets] of descriptor.wallets) {
        if (holdingScopes.get(chain) !== descriptor) continue;
        const groups = list.filter((group) => group?.chain === chain);
        if (groups.length !== 1) continue;
        const rows = sanitizeHoldingRows(groups[0].holdings, wallets, chain);
        if (rows) results.push({ chain, rows, sequence: descriptor.sequence });
      }
      return results;
    }, 10000, controller).catch(() => []).finally(() => {
      if (holdingReads.get(descriptor) === task) holdingReads.delete(descriptor);
    });
    holdingReads.set(descriptor, task);
    return task;
  }

  let holdingBridgeBusy = false;
  document.addEventListener('gdh-holdings-request', async () => {
    if (holdingBridgeBusy) return;
    let request;
    try { request = JSON.parse(document.documentElement?.getAttribute('data-gdh-holdings-request') || 'null'); } catch { return; }
    if (!request || !/^[a-z0-9-]{1,80}$/.test(request.id) || (request.chain && !holdingChains.has(request.chain))) return;
    holdingBridgeBusy = true;
    const token = holdingAccountCurrent();
    try {
      await Promise.all([...holdingCaptures]);
      const descriptors = [...new Set([...holdingScopes].filter(([chain, item]) =>
        (!request.chain || request.chain === chain) && Date.now() - item.at < HOLDING_SCOPE_MAX_AGE).map(([, item]) => item))];
      const results = token ? (await Promise.all(descriptors.map(readHoldingScope))).flat() : [];
      const data = token === holdingAccountCurrent() && !holdingCaptures.size ? results.filter((item) =>
        (!request.chain || item.chain === request.chain) && holdingScopes.get(item.chain)?.sequence === item.sequence)
        .map(({ chain, rows }) => ({ chain, rows })) : [];
      if (!document.documentElement) return;
      document.documentElement.setAttribute('data-gdh-holdings-result', JSON.stringify({ id: request.id, ok: data.length > 0, data }));
      document.dispatchEvent(new Event('gdh-holdings-result'));
      document.documentElement.removeAttribute('data-gdh-holdings-result');
    } finally { holdingBridgeBusy = false; }
  });

  function rememberTokenStatSubscription(socket, data) {
    if (typeof data !== 'string' || !data.includes('token_stat')) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.channel !== 'token_stat' || !Array.isArray(message.data)) return;
    const chains = tokenStatChains.get(socket) || new Map();
    for (const item of message.data) {
      const chain = String(item?.chain || item?.c || '').trim().toLowerCase();
      const addresses = Array.isArray(item?.addresses) ? item.addresses : [item?.addresses || item?.address || item?.a];
      for (const rawAddress of addresses) {
        const address = normalizeTokenStatAddress(rawAddress);
        if (!address) continue;
        const subscribed = chains.get(address) || new Set();
        if (message.action === 'unsubscribe') subscribed.delete(chain);
        else if (message.action === 'subscribe' && chain) subscribed.add(chain);
        if (subscribed.size) chains.set(address, subscribed);
        else chains.delete(address);
      }
    }
    tokenStatChains.set(socket, chains);
  }

  function forwardTokenStatMessage(socket, data) {
    if (typeof data !== 'string' || !data.includes('token_stat')) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.channel !== 'token_stat' || !Array.isArray(message.data)) return;
    const chains = tokenStatChains.get(socket);
    const items = message.data.slice(0, 200).map((raw) => {
      const address = normalizeTokenStatAddress(raw?.a || raw?.address);
      const subscribed = chains?.get(address);
      // A shared EVM address is not a chain identity. Ambiguous untagged ticks are ignored.
      const inferredChain = subscribed?.size === 1 ? [...subscribed][0] : '';
      const chain = String(raw?.c || raw?.chain || inferredChain).trim().toLowerCase();
      const price = Number(raw?.p ?? raw?.price);
      const price5m = Number(raw?.p5m ?? raw?.price_5m);
      const pct5m = Number(raw?.pcp5m ?? raw?.price_change_percent5m);
      if (!address || !chain || !(price > 0) || (!(price5m > 0) && !Number.isFinite(pct5m))) return null;
      return { chain, address, price, price5m: price5m > 0 ? price5m : 0, pct5m: Number.isFinite(pct5m) ? pct5m : null };
    }).filter(Boolean);
    if (!items.length || !document.documentElement) return;
    document.documentElement.setAttribute(TOKEN_STAT_ATTRIBUTE, JSON.stringify(items));
    document.dispatchEvent(new Event(TOKEN_STAT_EVENT));
    document.documentElement.removeAttribute(TOKEN_STAT_ATTRIBUTE);
  }

  if (typeof nativeWebSocket === 'function') {
    window.WebSocket = new Proxy(nativeWebSocket, {
      construct(Target, args) {
        const socket = new Target(...args);
        socket.addEventListener('message', (event) => forwardTokenStatMessage(socket, event.data));
        const nativeSend = socket.send;
        socket.send = function gdhTokenStatSend(data) {
          rememberTokenStatSubscription(socket, data);
          return nativeSend.call(socket, data);
        };
        return socket;
      },
    });
  }

  const CARD_SELECTOR =
    '[data-testid="trench-token-card"], [data-sentry-source-file="TokenItem.tsx"][href*="/token/"]';
  const CALLOUT_SELECTOR = '[data-sentry-component="CalloutItem"]';
  const MANIFESTO_SELECTOR = '[data-sentry-component="ManifestoChipInner"]';
  const HOLDING_ROW_SELECTOR = '[data-sentry-component="SmToken"]';
  const HOLDING_PANEL_SELECTOR = '[data-sentry-source-file^="PositionTable"], [data-sentry-source-file="Holding.tsx"]';
  const HOLDING_ROW_FALLBACK = 'a[href*="/token/"]';
  const TRACKER_ITEM_SELECTOR = '[data-sentry-component="TrackerListItem"]';
  const TRACKER_TABLE_ITEM_SELECTOR = '[data-sentry-component="TrackingBody"] [data-sentry-component="TableItem"][href*="/token/"]';
  const HOLDER_ROW_SELECTOR = '[data-testid="token-detail-holders-row"]';
  const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  let scanScheduled = false;

  function normalizeAddress(value) {
    return typeof value === 'string' && ADDRESS_RE.test(value)
      ? value.toLowerCase()
      : '';
  }

  function normalizeDevAddress(value, chain) {
    if (typeof value !== 'string') return '';
    if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : '';
    return normalizeAddress(value);
  }

  function getCardAddress(card) {
    const match = (card.getAttribute('href') || '').match(/^\/(bsc|robinhood|sol)\/token\/([^/?#]+)/);
    if (match) return normalizeDevAddress(match[2], match[1]);
    // Legacy BSC cards may expose only the native fee-mode token attribute.
    const direct = card.getAttribute('data-gmgn-fee-mode-card');
    return normalizeAddress(direct);
  }

  function toTokenData(value, expectedAddress) {
    if (!value || typeof value !== 'object') return null;

    const candidates = [
      value,
      value.data,
      value.item,
      value.token,
      value.base_token_info,
    ];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const chain = expectedAddress.startsWith('0x') ? 'evm' : 'sol';
      const address = normalizeDevAddress(candidate.address, chain);
      const creator = normalizeDevAddress(candidate.creator, chain);
      if (address !== expectedAddress || !creator) continue;

      return {
        address,
        creator,
        symbol: String(candidate.symbol || ''),
        migrated: candidate.creator_created_open_count,
        total: candidate.creator_created_count,
        ratio: candidate.creator_created_open_ratio,
      };
    }
    return null;
  }

  function searchProps(root, expectedAddress) {
    const seen = new WeakSet();
    const queue = [{ value: root, depth: 0 }];
    let budget = 900;

    while (queue.length && budget > 0) {
      const { value, depth } = queue.shift();
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      budget -= 1;

      const tokenData = toTokenData(value, expectedAddress);
      if (tokenData) return tokenData;
      if (depth >= 5 || value instanceof Node) continue;

      let keys;
      try {
        keys = Object.keys(value);
      } catch {
        continue;
      }

      for (const key of keys.slice(0, 120)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) {
          continue;
        }
        let child;
        try {
          child = value[key];
        } catch {
          continue;
        }
        if (child && (typeof child === 'object' || typeof child === 'function')) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  function readTokenData(card, expectedAddress) {
    const fiberKey = Object.keys(card).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;

    let fiber = card[fiberKey];
    for (let level = 0; fiber && level < 18; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const direct = toTokenData(props, expectedAddress);
          if (direct) return direct;
          const nested = searchProps(props, expectedAddress);
          if (nested) return nested;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function toCallerData(value, kind) {
    if (!value || typeof value !== 'object') return null;
    const item = value.item && typeof value.item === 'object' ? value.item : value;

    if (kind === 'manifesto') {
      const wallet = normalizeAddress(item.callerWallet);
      const handle = String(item.callerHandle || '').trim().replace(/^@/, '');
      if (!wallet && !handle) return null;
      return {
        wallet,
        handle,
        name: String(item.callerName || handle || '').trim(),
        ulid: String(item.ulid || '').trim(),
        tokenAddress: normalizeAddress(item.tokenAddress),
        tokenSymbol: String(item.tokenSymbol || '').trim().slice(0, 32),
        text: String(item.sourceContent || '').trim().slice(0, 200),
        amountUsd: String(item.amountUsd || '').trim().slice(0, 12),
        avatar: /^https:\/\//.test(String(item.callerAvatar || '')) ? String(item.callerAvatar).slice(0, 300) : '',
        verified: String(item.isBlueVerified) === 'true' ? '1' : '',
        multiplier: String(item.multiplier || '').trim().slice(0, 20),
        timeMs: String(item.declareCreateTime || (Number(item.createTime) ? Number(item.createTime) * 1000 : '')).trim(),
      };
    }

    const maker = item.maker_info && typeof item.maker_info === 'object'
      ? item.maker_info
      : item;
    const wallet = normalizeAddress(maker.address);
    const handle = String(
      item.twitter_username || maker.twitter_username || '',
    ).trim().replace(/^@/, '');
    if (!wallet && !handle) return null;
    return {
      wallet,
      handle,
      name: String(
        item.nick_name || maker.name || item.twitter_name || maker.twitter_name || handle || '',
      ).trim(),
    };
  }

  function readCallerData(element, kind) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (fiberKey) {
      let fiber = element[fiberKey];
      for (let level = 0; fiber && level < 18; level += 1) {
        for (const node of [fiber, fiber.alternate]) {
          if (!node) continue;
          for (const props of [node.memoizedProps, node.pendingProps]) {
            const data = toCallerData(props, kind);
            if (data) return data;
          }
        }
        fiber = fiber.return;
      }
    }

    if (kind === 'manifesto') {
      const match = (element.textContent || '').match(/@([A-Za-z0-9_]+)/);
      return match ? { wallet: '', handle: match[1], name: match[1] } : null;
    }

    const addressLink = element.querySelector('a[href*="/address/0x"]');
    const match = addressLink?.getAttribute('href')?.match(/\/address\/(0x[a-fA-F0-9]{40})/);
    if (!match) return null;
    return {
      wallet: match[1].toLowerCase(),
      handle: '',
      name: String(addressLink.textContent || '').trim(),
    };
  }

  function setAttribute(card, name, value) {
    if (value == null || value === '') {
      card.removeAttribute(name);
      return;
    }
    const text = String(value);
    if (card.getAttribute(name) !== text) card.setAttribute(name, text);
  }

  function clearTokenData(card) {
    for (const name of [
      'data-gdh-ready',
      'data-gdh-creator',
      'data-gdh-symbol',
      'data-gdh-migrated',
      'data-gdh-total',
      'data-gdh-ratio',
    ]) {
      card.removeAttribute(name);
    }
  }

  function scanCard(card) {
    if (!card.closest('[data-sentry-component="PumpSubX"]')
      && !card.matches('[data-testid="trench-token-card"]')) return;
    const address = getCardAddress(card);
    if (!address) { clearTokenData(card); return; }

    const data = readTokenData(card, address);
    if (!data) {
      clearTokenData(card);
      return;
    }

    setAttribute(card, 'data-gdh-ready', '1');
    setAttribute(card, 'data-gdh-creator', data.creator);
    setAttribute(card, 'data-gdh-symbol', data.symbol);
    setAttribute(card, 'data-gdh-migrated', data.migrated);
    setAttribute(card, 'data-gdh-total', data.total);
    setAttribute(card, 'data-gdh-ratio', data.ratio);
  }

  function clearCallerData(element) {
    for (const name of [
      'data-gdh-caller-ready',
      'data-gdh-caller-wallet',
      'data-gdh-caller-handle',
      'data-gdh-caller-name',
      'data-gdh-mani-ulid',
      'data-gdh-mani-token',
      'data-gdh-mani-symbol',
      'data-gdh-mani-text',
      'data-gdh-mani-usd',
      'data-gdh-mani-avatar',
      'data-gdh-mani-verified',
      'data-gdh-mani-mult',
      'data-gdh-mani-time',
    ]) {
      element.removeAttribute(name);
    }
  }

  function scanCallerElement(element, kind) {
    const data = readCallerData(element, kind);
    if (!data) {
      clearCallerData(element);
      return;
    }

    setAttribute(element, 'data-gdh-caller-ready', '1');
    setAttribute(element, 'data-gdh-caller-wallet', data.wallet);
    setAttribute(element, 'data-gdh-caller-handle', data.handle);
    setAttribute(element, 'data-gdh-caller-name', data.name);
    if (kind === 'manifesto') {
      setAttribute(element, 'data-gdh-mani-ulid', data.ulid);
      setAttribute(element, 'data-gdh-mani-token', data.tokenAddress);
      setAttribute(element, 'data-gdh-mani-symbol', data.tokenSymbol);
      setAttribute(element, 'data-gdh-mani-text', data.text);
      setAttribute(element, 'data-gdh-mani-usd', data.amountUsd);
      setAttribute(element, 'data-gdh-mani-avatar', data.avatar);
      setAttribute(element, 'data-gdh-mani-verified', data.verified);
      setAttribute(element, 'data-gdh-mani-mult', data.multiplier);
      setAttribute(element, 'data-gdh-mani-time', data.timeMs);
    }
  }



  function readHoldingCost(hit) {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const nonNegative = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const balance = num(hit.balance) || num(hit.amount_cur) || num(hit.amount);
    if (!balance) return 0;
    const accuAmount = num(hit.accu_amount);
    const accuCost = num(hit.accu_cost);
    if (accuAmount && accuCost) return (accuCost + nonNegative(hit.accu_fee)) / accuAmount;
    const direct = num(hit.avg_cost);
    if (direct) return direct;
    const total = num(hit.total_cost) || num(hit.cost) || num(hit.accu_cost);
    if (total) return total / balance;
    return num(hit.history_avg_cost);
  }

  function readHoldingToken(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    const pick = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return null;
      if (value.address && value.symbol && value.chain
        && (value.balance !== undefined || value.usd_value !== undefined
          || value.amount !== undefined || value.holding !== undefined
          || value.unrealized_profit !== undefined)) return value;
      let keys;
      try { keys = Object.keys(value); } catch { return null; }
      for (const key of keys.slice(0, 50)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === 'object') {
          const hit = pick(child, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    let fiber = element[fiberKey];
    for (let level = 0; fiber && level < 16; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const hit = pick(props, 0);
          if (hit) {
            return {
              chain: String(hit.chain || '').slice(0, 16),
              address: String(hit.address || '').slice(0, 64),
              symbol: String(hit.symbol || '').slice(0, 24),
              cost: readHoldingCost(hit),
            };
          }
        }
      }
      fiber = fiber.return;
    }
    return null;
  }


  // One committed host/ancestry index per root per scan. DOM expandos and
  // .return can still point at the previous tree, including shared bailout hosts.
  // Use them ONLY to locate the root; never read their props as a fallback.
  function trackerRoute(element, roots, maxDepth = 18) {
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    let top = key && element[key];
    const ancestors = new Set();
    for (let n = 0; top?.return && n < 200; n++) {
      if (ancestors.has(top)) return null;
      ancestors.add(top);
      top = top.return;
    }
    const root = !top?.return && top?.stateNode;
    if (!root?.current) return null;
    if (!roots.has(root)) {
      const hosts = new Map(), seen = new Set();
      const stack = [{ fiber: root.current, parent: null }];
      let valid = true;
      while (stack.length) {
        const node = stack.pop(), fiber = node.fiber;
        if (seen.has(fiber) || seen.size >= 100000) { valid = false; break; }
        seen.add(fiber);
        if (fiber.stateNode instanceof HTMLElement) hosts.set(fiber.stateNode, node);
        if (fiber.sibling) stack.push({ fiber: fiber.sibling, parent: node.parent });
        if (fiber.child) stack.push({ fiber: fiber.child, parent: node });
      }
      roots.set(root, valid ? hosts : null);
    }
    const route = [];
    for (let node = roots.get(root)?.get(element); node && route.length < maxDepth; node = node.parent) {
      route.push(node.fiber);
    }
    return route.length ? route : null;
  }

  let nativeChainPickerSeen = false;
  function publishNativeChainFilters(roots) {
    // Read final controlled picker props from the committed tree, not storage,
    // hooks, stale .return props, account data or a dropdown's mounted options.
    const nodes = [...document.querySelectorAll('[data-testid="chain-multi-select-trigger"]')];
    if (!nodes.length && !nativeChainPickerSeen) return;
    nativeChainPickerSeen = true;
    const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
    const slug = value => typeof value === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(value);
    const filters = { walletTracking: null, trending: null }, seen = new Set();
    for (const element of nodes.length <= 32 ? nodes : []) {
      const route = trackerRoute(element, roots, 64);
      if (!route) continue;
      let moduleId, selection;
      for (const fiber of route) {
        const props = own(fiber, 'memoizedProps');
        const id = own(props, 'moduleId');
        if (id === 'walletTracking' || id === 'trending') { moduleId = id; break; }
        if (selection !== undefined) continue;
        const value = own(props, 'value'), options = own(props, 'options');
        if (!Array.isArray(value) || !Array.isArray(options)) continue;
        selection = null;
        if (value.length > 32 || options.length > 32) continue;
        const supported = new Set();
        let valid = true;
        for (let i = 0; i < options.length; i++) {
          const option = own(options, String(i)), chain = own(option, 'value');
          if (!slug(chain)) { valid = false; break; }
          if (!own(option, 'disabled') && !own(option, 'checkboxDisabled')) supported.add(chain);
        }
        const chosen = [];
        for (let i = 0; valid && i < value.length; i++) {
          const chain = own(value, String(i));
          if (!slug(chain) || !supported.has(chain)) { valid = false; break; }
          chosen.push(chain);
        }
        if (valid) selection = [...new Set(own(props, 'mode') === 'single' ? chosen.slice(0, 1) : chosen)].sort();
      }
      if (!moduleId) continue;
      // Ambiguous duplicate mounts fail closed instead of unioning selections.
      const result = selection ?? null;
      if (seen.has(moduleId) && JSON.stringify(filters[moduleId]) !== JSON.stringify(result)) filters[moduleId] = null;
      else if (!seen.has(moduleId)) filters[moduleId] = result;
      seen.add(moduleId);
    }
    const value = JSON.stringify({ version: 1, ...filters });
    if (document.documentElement.getAttribute('data-gdh-chain-filters') === value) return;
    document.documentElement.setAttribute('data-gdh-chain-filters', value);
    document.dispatchEvent(new Event('gdh-chain-filters'));
  }

  function readTrackerRecord(element, roots) {
    const route = trackerRoute(element, roots);
    if (!route) return null;
    const pick = (value, depth) => {
      // A parent list is not a row identity (especially repeated-token trades).
      if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return null;
      const address = value.token_address || value.base_address || value.base_token?.address;
      const maker = value.maker || value.maker_info_address || value.maker_info?.address;
      const side = String(value.side || '').trim().toLowerCase();
      const timestamp = Number(value.timestamp);
      if (typeof address === 'string' && address && typeof maker === 'string' && maker
        && (side === 'buy' || side === 'sell' || side === 'add' || side === 'remove') && timestamp > 0) return value;
      let keys;
      try { keys = Object.keys(value); } catch { return null; }
      for (const key of keys.slice(0, 50)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === 'object') {
          const hit = pick(child, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    for (const fiber of route.slice(0, 16)) {
          const hit = pick(fiber.memoizedProps, 0);
          if (hit) {
            return {
              trackerRoute: route,
              address: String(hit.token_address || hit.base_address || hit.base_token?.address || '').slice(0, 64),
              symbol: String(hit.base_symbol || hit.base_token?.symbol || '').slice(0, 24),
              chain: String(hit.chain || '').slice(0, 16),
              maker: String(hit.maker || hit.maker_info_address || hit.maker_info?.address || '').slice(0, 64),
              nick: String(hit.nick_name || hit.maker_info?.name || '').slice(0, 32),
              side: String(hit.side || '').trim().toLowerCase().slice(0, 12),
              tx: String(hit.transaction_hash || hit.tx_hash || '').trim().slice(0, 180),
              usd: (() => {
                const amount = Number(hit.amount_usd);
                if (Number.isFinite(amount) && amount > 0) return amount;
                const cost = Number(hit.cost_usd);
                return Number.isFinite(cost) && cost > 0 ? cost : 0;
              })(),
              ts: (() => {
                const n = Number(hit.timestamp);
                if (n > 1.4e9 && n < 4.1e9) return Math.round(n * 1000);
                if (n > 1.4e12 && n < 4.1e12) return Math.round(n);
                return 0;
              })(),
            };
          }
    }
    return null;
  }

  // Export only an observed, ordered native index; never synthesize native trades.
  function publishTrackerIndex(element, data, published) {
    let wrap = element.parentElement;
    for (let n = 0; wrap && n < 4; n++, wrap = wrap.parentElement) {
      if (wrap.style.position !== 'absolute') continue;
      const route = data.trackerRoute || [];
      const seen = new Set();
      const inspect = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return null;
        seen.add(value);
        if (Array.isArray(value) && value.length && value.length <= 10000) {
          const stamps = value.map(v => {
            const t = Number(v?.timestamp);
            return t > 1.4e12 && t < 4.1e12 ? Math.round(t) : t > 1.4e9 && t < 4.1e9 ? Math.round(t * 1000) : 0;
          });
          if (stamps.every((t, i) => t && (!i || stamps[i - 1] >= t))
            && value.some((v, i) => stamps[i] === data.ts && (v.token_address || v.base_address || v.base_token?.address) === data.address)) return { stamps, rows:value.map((v,i) => ({
              ts:stamps[i], tx:String(v.transaction_hash || v.tx_hash || '').trim().slice(0,180),
              addr:String(v.token_address || v.base_address || v.base_token?.address || '').slice(0,64),
              chain:String(v.chain || '').slice(0,16), side:String(v.side || '').slice(0,12),
            })) };
        }
        for (const k of Object.keys(value).slice(0, 50)) {
          if (['_owner','return','child','sibling','alternate','stateNode'].includes(k)) continue;
          const hit = inspect(value[k], depth + 1);
          if (hit) return hit;
        }
        return null;
      };
      for (const fiber of route) {
        const index = inspect(fiber.memoizedProps, 0);
        if (index) {
          published.add(wrap.parentElement);
          setAttribute(wrap.parentElement, 'data-gdh-native-index', JSON.stringify(index.stamps));
          // Dedup must cover native history, not whichever recycled rows happen
          // to be mounted. Publish the matching bounded identity snapshot.
          setAttribute(wrap.parentElement, 'data-gdh-native-rows', JSON.stringify(index.rows));
          return;
        }
      }
      return;
    }
  }

  function scanTrackerCard(element, roots, published, suppliedData = null) {
    const data = suppliedData || readTrackerRecord(element, roots);
    if (data?.ts) publishTrackerIndex(element, data, published);
    if (data && data.address) {
        setAttribute(element, 'data-gdh-track-addr', data.address);
      if (data.symbol) setAttribute(element, 'data-gdh-track-symbol', data.symbol);
      else element.removeAttribute('data-gdh-track-symbol');
      if (data.maker) setAttribute(element, 'data-gdh-track-maker', data.maker);
      else element.removeAttribute('data-gdh-track-maker');
      if (data.nick) setAttribute(element, 'data-gdh-track-nick', data.nick);
      else element.removeAttribute('data-gdh-track-nick');
      if (data.chain) setAttribute(element, 'data-gdh-track-chain', data.chain);
      else element.removeAttribute('data-gdh-track-chain');
      if (data.side) setAttribute(element, 'data-gdh-track-side', data.side);
      else element.removeAttribute('data-gdh-track-side');
      if (data.tx) setAttribute(element, 'data-gdh-track-tx', data.tx);
      else element.removeAttribute('data-gdh-track-tx');
      if (data.usd) setAttribute(element, 'data-gdh-track-usd', String(data.usd));
      else element.removeAttribute('data-gdh-track-usd');
      if (data.ts) setAttribute(element, 'data-gdh-track-ts', String(data.ts));
      else element.removeAttribute('data-gdh-track-ts');
      return;
    }
    const href = element.getAttribute('href') || '';
    const match = href.match(/\/([a-z0-9]+)\/token\/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (match) setAttribute(element, 'data-gdh-track-addr', match[2]);
    else element.removeAttribute('data-gdh-track-addr');
    for (const attr of [
      'data-gdh-track-symbol', 'data-gdh-track-maker', 'data-gdh-track-nick',
      'data-gdh-track-chain', 'data-gdh-track-side', 'data-gdh-track-tx',
      'data-gdh-track-usd', 'data-gdh-track-ts',
    ]) element.removeAttribute(attr);
  }


  function scanUnmarkedTrackerRows(trackerSeen, trackerData, roots) {
    const scoped = document.querySelectorAll(
      '.virtual-list-container [data-index], .virtual-list-container [data-item-index]',
    );
    const wrappers = scoped.length
      ? scoped : document.querySelectorAll('[data-index], [data-item-index]');
    let examined = 0;
    for (const wrap of wrappers) {
      if (!(wrap instanceof HTMLElement) || examined >= 240) break;
      if ((wrap.style.position || '') !== 'absolute') continue;
      const root = wrap.firstElementChild;
      if (!(root instanceof HTMLElement)) continue;
      examined += 1;
      const candidates = [
        root,
        root.firstElementChild,
        root.querySelector('[data-testid="follow-tracking-row-symbol"]')?.parentElement,
        root.querySelector('a[href*="/token/"]'),
      ].filter((item, index, list) => item instanceof HTMLElement && list.indexOf(item) === index);
      let data = null;
      for (const candidate of candidates) {
        data = readTrackerRecord(candidate, roots);
        if (data) break;
      }
      if (!data) continue;
      trackerSeen.add(root);
      trackerData.set(root, data);
    }
  }

  function scanHoldingRow(element) {
    const data = readHoldingToken(element);
    if (!data || !data.chain || !data.address) {
      element.removeAttribute('data-gdh-hold-chain');
      element.removeAttribute('data-gdh-hold-addr');
      element.removeAttribute('data-gdh-hold-symbol');
      element.removeAttribute('data-gdh-hold-cost');
      return;
    }
    setAttribute(element, 'data-gdh-hold-chain', data.chain);
    setAttribute(element, 'data-gdh-hold-addr', data.address);
    setAttribute(element, 'data-gdh-hold-symbol', data.symbol);
    if (data.cost > 0) setAttribute(element, 'data-gdh-hold-cost', String(data.cost));
  }


  function scanHolderRow(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return;
    const pick = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return null;
      if (typeof value.address === 'string' && value.address && value.balance !== undefined) return value;
      let keys;
      try { keys = Object.keys(value); } catch { return null; }
      for (const key of keys.slice(0, 50)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === 'object') {
          const hit = pick(child, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    let fiber = element[fiberKey];
    for (let level = 0; fiber && level < 12; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const hit = pick(props, 0);
          if (hit) {
            setAttribute(element, 'data-gdh-holder-addr', String(hit.address).slice(0, 64));
            setAttribute(element, 'data-gdh-holder-balance', String(hit.balance ?? ''));
            if (hit.amount_percentage !== undefined) setAttribute(element, 'data-gdh-holder-pct', String(hit.amount_percentage));
            return;
          }
        }
      }
      fiber = fiber.return;
    }
  }

  let scanRafId = 0;
  let scanDelayTimer = 0;
  let lastScanAt = 0;
  let scrollingUntil = 0;

  function scanCards() {
    scanScheduled = false;
    scanRafId = 0;
    const holdingRows = new Set(document.querySelectorAll(HOLDING_ROW_SELECTOR));
    const panels = new Set();
    document.querySelectorAll(HOLDING_PANEL_SELECTOR).forEach((anchor) => {
      panels.add(anchor.closest('table, [data-testid="virtuoso-scroller"]') || anchor);
    });
    panels.forEach((panel) => {
      panel.querySelectorAll(HOLDING_ROW_FALLBACK).forEach((link) => {
        if (link.closest(HOLDING_ROW_SELECTOR)) return;
        let el = link;
        for (let level = 0; level < 4 && el instanceof HTMLElement; level += 1) {
          if (readHoldingToken(el)) { holdingRows.add(el); return; }
          el = el.parentElement;
        }
      });
    });
    holdingRows.forEach(scanHoldingRow);
    const trackerSeen = new Set();
    const trackerData = new Map();
    document.querySelectorAll(TRACKER_ITEM_SELECTOR).forEach((el) => trackerSeen.add(el));
    document.querySelectorAll(TRACKER_TABLE_ITEM_SELECTOR).forEach((row) => {
      const candidate = row.querySelector('[data-testid="follow-tracking-row-symbol"]')?.parentElement
        || row.firstElementChild;
      if (candidate instanceof HTMLElement) trackerSeen.add(candidate);
    });
    document.querySelectorAll('[data-testid="follow-tracking-row-symbol"]').forEach((cell) => {
      const tagged = cell.closest(TRACKER_ITEM_SELECTOR);
      if (tagged) return void trackerSeen.add(tagged);
      let el = cell.parentElement;
      for (let level = 0; level < 6 && el; level += 1) {
        if (el.querySelector('[data-testid="follow-tracking-row-maker"]')) { trackerSeen.add(el); return; }
        el = el.parentElement;
      }
    });
    const trackerRoots = new Map();
    publishNativeChainFilters(trackerRoots);
    const published = new Set();
    if (!trackerSeen.size) scanUnmarkedTrackerRows(trackerSeen, trackerData, trackerRoots);
    document.querySelectorAll('[data-gdh-track-addr], [data-gdh-track-ts]').forEach(el => trackerSeen.add(el));
    trackerSeen.forEach((element) => scanTrackerCard(element, trackerRoots, published, trackerData.get(element)));
    // Clear only snapshots no committed row established this scan. Keep unchanged
    // attributes stable and do not let an unresolved pool row erase a valid index.
    document.querySelectorAll('[data-gdh-native-index], [data-gdh-native-rows]').forEach(el => {
      if (published.has(el)) return;
      el.removeAttribute('data-gdh-native-index');
      el.removeAttribute('data-gdh-native-rows');
    });
    document.querySelectorAll(HOLDER_ROW_SELECTOR).forEach(scanHolderRow);
    document.querySelectorAll(CARD_SELECTOR).forEach(scanCard);
    document.querySelectorAll(CALLOUT_SELECTOR).forEach((element) => {
      scanCallerElement(element, 'callout');
    });
    document.querySelectorAll(MANIFESTO_SELECTOR).forEach((element) => {
      scanCallerElement(element, 'manifesto');
    });
  }

  function runScheduledScan() {
    scanRafId = 0;
    const now = Date.now();
    if (now < scrollingUntil && now - lastScanAt < 150) {
      if (!scanDelayTimer) {
        const wait = Math.max(1, 150 - (now - lastScanAt));
        scanDelayTimer = window.setTimeout(() => {
          scanDelayTimer = 0;
          scanScheduled = false;
          scheduleScan();
        }, wait);
      }
      return;
    }
    lastScanAt = now;
    scanCards();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    if (document.visibilityState === 'hidden') return;
    scanScheduled = true;
    if (scanRafId || scanDelayTimer) return;
    scanRafId = window.requestAnimationFrame(runScheduledScan);
  }

  document.addEventListener('scroll', () => { scrollingUntil = Date.now() + 200; }, true);
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[data-testid^="chain-multi-select-"]')) scheduleScan();
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') scheduleScan();
  });

  function startDomScanner() {
    if (!document.documentElement) return;
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-gmgn-fee-mode-card', 'data-selected'],
    });
    scheduleScan();
    window.setInterval(scheduleScan, 1200);
  }
  if (document.documentElement) startDomScanner();
  else document.addEventListener('DOMContentLoaded', startDomScanner, { once: true });

  const GDH_NAV_RE = /^\/(sol|bsc|eth|base|tron|blast|monad|megaeth|hyperevm|xlayer|robinhood|arc|stable|arbitrum)\/token\/[a-zA-Z0-9]{20,64}$/;
  document.addEventListener('gdh-navigate', () => {
    const url = document.documentElement.getAttribute('data-gdh-nav') || '';
    document.documentElement.removeAttribute('data-gdh-nav');
    if (!GDH_NAV_RE.test(url)) return;
    try {
      const router = window.next && window.next.router;
      if (router && typeof router.push === 'function') {
        Promise.resolve(router.push(url)).catch(() => window.location.assign(url));
        return;
      }
    } catch {
    }
    window.location.assign(url);
  });
})();
