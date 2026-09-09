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
    const allowed = new Set(['sol', 'bsc', 'base']);
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
        if (message.action === 'unsubscribe') chains.delete(address);
        else if (message.action === 'subscribe' && chain) chains.set(address, chain);
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
      const chain = String(raw?.c || raw?.chain || chains?.get(address) || '').trim().toLowerCase();
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


  function readTrackerRecord(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    const pick = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return null;
      const address = value.token_address || value.base_address || value.base_token?.address;
      const maker = value.maker || value.maker_info_address || value.maker_info?.address;
      const side = String(value.side || '').trim().toLowerCase();
      const timestamp = Number(value.timestamp);
      if (typeof address === 'string' && address && typeof maker === 'string' && maker
        && (side === 'buy' || side === 'sell') && timestamp > 0) return value;
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
      }
      fiber = fiber.return;
    }
    return null;
  }

  // Export only an observed, ordered native index; never synthesize native trades.
  function publishTrackerIndex(element, data) {
    let wrap = element.parentElement;
    for (let n = 0; wrap && n < 4; n++, wrap = wrap.parentElement) {
      if (wrap.style.position !== 'absolute') continue;
      const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
      let fiber = key && element[key];
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
            && value.some((v, i) => stamps[i] === data.ts && (v.token_address || v.base_address || v.base_token?.address) === data.address)) return stamps;
        }
        for (const k of Object.keys(value).slice(0, 50)) {
          if (['_owner','return','child','sibling','alternate','stateNode'].includes(k)) continue;
          const hit = inspect(value[k], depth + 1);
          if (hit) return hit;
        }
        return null;
      };
      for (let n = 0; fiber && n < 18; n++, fiber = fiber.return) {
        const stamps = inspect(fiber.memoizedProps, 0);
        if (stamps) {
          setAttribute(wrap.parentElement, 'data-gdh-native-index', JSON.stringify(stamps));
          return;
        }
      }
      return;
    }
  }

  function scanTrackerCard(element, suppliedData = null) {
    const data = suppliedData || readTrackerRecord(element);
    if (data?.ts) publishTrackerIndex(element, data);
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


  function scanUnmarkedTrackerRows(trackerSeen, trackerData) {
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
        data = readTrackerRecord(candidate);
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
    if (!trackerSeen.size) scanUnmarkedTrackerRows(trackerSeen, trackerData);
    trackerSeen.forEach((element) => scanTrackerCard(element, trackerData.get(element)));
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
      attributeFilter: ['href', 'data-gmgn-fee-mode-card'],
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
