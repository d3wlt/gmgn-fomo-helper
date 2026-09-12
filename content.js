(() => {
  'use strict';

  if (window.__gdhContentStarted) return;
  window.__gdhContentStarted = true;

  if (location.hostname === 'fomo.family' || location.hostname.endsWith('.fomo.family')) {
    const unwrap = (raw) => {
      if (!raw) return '';
      let value = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') value = parsed;
      } catch {
      }
      value = String(value || '').trim();
      return value.length > 20 ? value : '';
    };
    const jwtExpMs = (token) => {
      try {
        const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
      } catch {
        return 0;
      }
    };
    const readPrivy = () => {
      const pairs = [];
      try {
        for (const tokenKey of Object.keys(window.localStorage).filter((key) => /^privy:(.+:)?token$/.test(key))) {
          const prefix = tokenKey.slice(0, -'token'.length);
          const token = unwrap(window.localStorage.getItem(tokenKey));
          if (!token) continue;
          pairs.push({
            token,
            refresh: unwrap(window.localStorage.getItem(`${prefix}refresh_token`)),
            exp: jwtExpMs(token),
          });
        }
      } catch {
      }
      pairs.sort((a, b) => (b.exp || 0) - (a.exp || 0));
      return pairs[0] || { token: '', refresh: '', exp: 0 };
    };
    let lastSent = '';
    const syncFomoToken = () => {
      const { token, refresh } = readPrivy();
      if (!token) return;
      const stamp = `${token}|${refresh}`;
      if (stamp === lastSent) return;
      const pageExp = jwtExpMs(token);
      try {
        chrome.storage.local.get('fomoToken', (stored) => {
          const cur = stored?.fomoToken;
          if (cur?.token === token && (cur.refresh || '') === (refresh || '')) {
            lastSent = stamp;
            return;
          }
          if (cur?.token && cur.token !== token && cur.exp && pageExp && cur.exp >= pageExp) return;
          lastSent = stamp;
          try {
            chrome.storage.local.set({ fomoToken: { token, refresh, at: Date.now(), exp: pageExp } });
          } catch {
          }
        });
      } catch {
      }
    };
    syncFomoToken();
    window.setInterval(syncFomoToken, 5000);
    window.addEventListener('focus', syncFomoToken);
    window.addEventListener('visibilitychange', syncFomoToken);

    const beat = () => {
      try {
        chrome.runtime.sendMessage({
          type: 'fomo-page-heartbeat',
          visible: document.visibilityState === 'visible',
          keeper: new URLSearchParams(location.search).has('gdh_keeper'),
        }, () => void chrome.runtime.lastError);
      } catch {
      }
    };
    beat();
    window.setInterval(beat, 15000);
    document.addEventListener('visibilitychange', beat);
    return;
  }

  const CARD_SELECTOR =
    '[data-testid="trench-token-card"], [data-sentry-source-file="TokenItem.tsx"][href*="/token/"]';
  const CALLOUT_SELECTOR = '[data-sentry-component="CalloutItem"]';
  const MANIFESTO_SELECTOR = '[data-sentry-component="ManifestoChipInner"]';
  const DEFAULTS = {
    debugLogging: false,
    enabled: true,
    showDevPerformance: true,
    showDevTooltip: true,
    enableDevBookmark: true,
    enableCalloutBlacklist: true,
    enableSpecialWallet: true,
    enableRemindAlert: true,
    enableFomoPanel: true,
    fomoPanelFolded: false,
    fomoPanelPos: null,
    fomoTranslate: true,
    fomoPanelOpen: false,
    enableHoldingSurge: true,
    holdingSurgeThreshold: 20,
    holdingSurgeCooldown: 60,
    holdingWatchList: [],
    addWalletStarPref: { on: false, color: '#f5b83d', pin: false },
    hideLightningTrade: true,
    watchedDevs: [],
    blockedCallers: [],
    blockedTokens: [],
    mergeFomoHolders: true,
    markedHolders: [
      { address: '0x38e47fece3ea323e864c65410f6458c820eaa897', name: 'Cow' },
      { address: '0xbf004bff64725914ee36d03b87d6965b0ced4903', name: 'Afeng Main 1' },
      { address: '0xbd28edf53231cd121a963b4b119d3cc4cb3a368a', name: 'Afeng Main 2' },
      { address: '0x92deb73329794a517f1a8be4925446300f159400', name: 'Afeng Alt 1' },
      { address: '0xb9c970411d72584649c2a41c9d5996df582fcc06', name: 'Afeng Alt 2' },
      { address: '0x2ce9d43d1cba6ae31d7f07bfe0098dfa2d833373', name: 'Kuzuo' },
    ],
    enableMarkedHolders: true,
    enableFomoFeed: true,
    fomoFeedChainOnly: false,
    fomoFeedTypes: { buy: true, sell: true, thesis: true },
    specialWallets: [],
    highlightColor: '#f5b83d',
  };

  let settings = { ...DEFAULTS };
  let watchedMap = new Map();
  let blockedWallets = new Set();
  let blockedHandles = new Set();
  const SPECIAL_COLOR_PALETTE = [
    '#f5b83d',
    '#ef5350',
    '#43c07a',
    '#4c9ffe',
    '#b48ae0',
    '#ed6ba4',
    '#3ec6c6',
  ];
  let specialWalletMap = new Map();
  let scanScheduled = false;
  let scrollScanTimer = 0;
  let calloutToastTimer = 0;
  let blacklistModalOpen = false;
  let activeCard = null;
  let tooltip = null;
  let suppressedTooltipCard = null;

  function setBoundedMap(map, key, value, max) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  function rememberBoundedSet(set, value, max) {
    if (set.has(value)) set.delete(value);
    set.add(value);
    while (set.size > max) set.delete(set.values().next().value);
  }

  const DEV_ATH_TTL_MS = 5 * 60 * 1000;
  const DEV_ATH_ERROR_RETRY_MS = 60 * 1000;
  const DEV_ATH_CACHE_MAX = 400;
  const DEV_ATH_GAP_MS = 250;
  const DEV_ATH_QS =
    'device_id=&client_id=gmgn_web&from_app=gmgn&app_ver=&tz_name=Asia%2FShanghai&tz_offset=28800&app_lang=zh-CN&os=web';
  const devAthCache = new Map();
  const devAthQueue = [];
  const devAthQueued = new Set();
  let devAthTimer = 0;

  function devIdentity(creator, chain) {
    if (!['bsc', 'robinhood', 'sol'].includes(chain) || typeof creator !== 'string') return null;
    const valid = chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(creator) : /^0x[a-fA-F0-9]{40}$/.test(creator);
    if (!valid) return null;
    const address = chain === 'sol' ? creator : creator.toLowerCase();
    return { chain, creator: address, key: `${chain}:${address}` };
  }

  function getDevAth(creator, chain = 'bsc') {
    const identity = devIdentity(creator, chain);
    if (!identity) return null;
    const key = identity.key;
    const hit = devAthCache.get(key);
    const fresh = hit
      && Date.now() - hit.at < (hit.ok ? DEV_ATH_TTL_MS : DEV_ATH_ERROR_RETRY_MS);
    if (!fresh && !devAthQueued.has(key)) {
      devAthQueued.add(key);
      devAthQueue.push(identity);
      if (!devAthTimer) devAthTimer = window.setTimeout(processDevAthQueue, 50);
    }
    return hit && hit.ok && hit.mc > 0 ? hit : null;
  }

  async function processDevAthQueue() {
    devAthTimer = 0;
    if (settings.showDevPerformance === false) {
      devAthQueue.length = 0;
      devAthQueued.clear();
      return;
    }
    const identity = devAthQueue.shift();
    if (!identity) return;
    const { creator, chain, key } = identity;
    let entry = { at: Date.now(), ok: false, mc: 0, symbol: '' };
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://gmgn.ai/api/v1/dev_created_tokens/${chain}/${creator}?${DEV_ATH_QS}`,
        { credentials: 'include', signal: controller.signal },
      );
      window.clearTimeout(timeout);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.code === 0) {
        const info = body.data?.creator_ath_info;
        entry = {
          at: Date.now(),
          ok: true,
          mc: Number(info?.ath_mc) || 0,
          symbol: String(info?.token_symbol || '').slice(0, 24),
        };
      }
    } catch {
    }
    setBoundedMap(devAthCache, key, entry, DEV_ATH_CACHE_MAX);
    devAthQueued.delete(key);
    if (entry.ok && entry.mc > 0) scheduleScan();
    if (devAthQueue.length) devAthTimer = window.setTimeout(processDevAthQueue, DEV_ATH_GAP_MS);
  }

  function formatAthMc(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const fmt = (v) => (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v)));
    if (n >= 1e9) return `$${fmt(n / 1e9)}B`;
    if (n >= 1e6) return `$${fmt(n / 1e6)}M`;
    if (n >= 1e3) return `$${fmt(n / 1e3)}K`;
    return `$${Math.round(n)}`;
  }

  function athTierClass(value) {
    const n = Number(value) || 0;
    if (n >= 1e7) return 'gdh-mc-t4';
    if (n >= 1e6) return 'gdh-mc-t3';
    if (n >= 1e5) return 'gdh-mc-t2';
    return 'gdh-mc-t1';
  }

  function normalizeAddress(value) {
    return typeof value === 'string' ? value.toLowerCase() : '';
  }

  const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
  const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  function isWalletAddress(value) {
    const v = String(value || '').trim();
    return EVM_ADDR_RE.test(v) || SOL_ADDR_RE.test(v);
  }

  function normalizeWalletAddress(value) {
    if (typeof value !== 'string') return '';
    const v = value.trim();
    if (SOL_ADDR_RE.test(v)) return v;
    return EVM_ADDR_RE.test(v) ? v.toLowerCase() : '';
  }

  function walletAddressFromHref(href) {
    const seg = String(href || '').match(/\/address\/([^/?#]+)/)?.[1] || '';
    return normalizeWalletAddress(seg);
  }

  function normalizeHandle(value) {
    return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
  }

  function rebuildWatchedMap() {
    watchedMap = new Map(
      (Array.isArray(settings.watchedDevs) ? settings.watchedDevs : [])
        .filter((item) => item && typeof item.address === 'string')
        .map((item) => [
          normalizeAddress(item.address),
          { address: normalizeAddress(item.address), label: String(item.label || '') },
        ]),
    );
  }

  function normalizeBlockedCaller(item) {
    if (!item || typeof item !== 'object') return null;
    const wallet = normalizeAddress(item.wallet);
    const handle = normalizeHandle(item.handle);
    if (!wallet && !handle) return null;
    return {
      wallet,
      handle,
      name: String(item.name || item.handle || item.wallet || '').trim(),
    };
  }

  function getBlockedCallers() {
    return (Array.isArray(settings.blockedCallers) ? settings.blockedCallers : [])
      .map(normalizeBlockedCaller)
      .filter(Boolean);
  }

  function rebuildBlockedCallerIndex() {
    const callers = getBlockedCallers();
    blockedWallets = new Set(callers.map((item) => item.wallet).filter(Boolean));
    blockedHandles = new Set(callers.map((item) => item.handle).filter(Boolean));
  }

  function normalizeSpecialColor(color) {
    if (color === 'rainbow') return 'rainbow';
    if (/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return String(color).toLowerCase();
    return SPECIAL_COLOR_PALETTE[0];
  }

  function rebuildSpecialWalletSet() {
    specialWalletMap = new Map(
      (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
        .map((item) => {
          const address = normalizeWalletAddress(item?.address);
          if (!address) return null;
          return [address, {
            label: String(item?.label || ''),
            color: normalizeSpecialColor(item?.color),
            pin: item?.pin === true,
          }];
        })
        .filter(Boolean),
    );
  }

  function formatCount(value) {
    if (value == null || value === '') return '--';
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number).toLocaleString('zh-CN') : '--';
  }

  function getRatioPercent(card) {
    const migrated = card.dataset.gdhMigrated === undefined
      ? Number.NaN
      : Number(card.dataset.gdhMigrated);
    const total = card.dataset.gdhTotal === undefined
      ? Number.NaN
      : Number(card.dataset.gdhTotal);
    if (Number.isFinite(migrated) && Number.isFinite(total) && total > 0) {
      return (migrated / total) * 100;
    }

    const rawRatio = card.dataset.gdhRatio === undefined
      ? Number.NaN
      : Number(card.dataset.gdhRatio);
    if (!Number.isFinite(rawRatio)) return Number.NaN;
    return rawRatio <= 1 ? rawRatio * 100 : rawRatio;
  }

  function formatRatio(card) {
    const percent = getRatioPercent(card);
    if (!Number.isFinite(percent)) return '--';
    if (percent === 0) return '0%';
    if (percent < 0.1) return '<0.1%';
    if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
    return `${Math.round(percent)}%`;
  }

  function applyRateColor(performance, percent) {
    const rateKey = Number.isFinite(percent) ? percent.toFixed(6) : 'unknown';
    if (performance.dataset.gdhRateKey === rateKey) return;
    performance.dataset.gdhRateKey = rateKey;

    if (!Number.isFinite(percent)) {
      performance.style.setProperty('--gdh-rate-color', '#8b93a1');
      performance.style.setProperty('--gdh-rate-border', 'rgba(139, 147, 161, 0.38)');
      performance.style.setProperty('--gdh-rate-bg', 'rgba(139, 147, 161, 0.07)');
      performance.style.setProperty('--gdh-rate-glow', 'transparent');
      return;
    }

    const strength = Math.min(1, Math.log1p(Math.max(0, percent)) / Math.log1p(20));
    const saturation = Math.round(18 + (82 * strength));
    const lightness = Math.round(44 + (24 * strength));
    const borderAlpha = (0.34 + (0.56 * strength)).toFixed(2);
    const backgroundAlpha = (0.06 + (0.13 * strength)).toFixed(2);
    const glowAlpha = (0.28 * strength).toFixed(2);
    const color = `hsl(42 ${saturation}% ${lightness}%)`;

    performance.style.setProperty('--gdh-rate-color', color);
    performance.style.setProperty(
      '--gdh-rate-border',
      `hsl(42 ${saturation}% ${lightness}% / ${borderAlpha})`,
    );
    performance.style.setProperty(
      '--gdh-rate-bg',
      `hsl(42 ${saturation}% ${lightness}% / ${backgroundAlpha})`,
    );
    performance.style.setProperty(
      '--gdh-rate-glow',
      `hsl(42 ${saturation}% ${lightness}% / ${glowAlpha})`,
    );
  }

  function clearWatchState(card) {
    delete card.dataset.gdhWatched;
    delete card.dataset.gdhHighlighted;
    delete card.dataset.gdhBadge;
    delete card.dataset.gdhWatchLabel;
    if (card === activeCard) {
      activeCard = null;
      tooltip?.classList.remove('gdh-tooltip--visible');
    }
  }

  function applyDevPerformance(card) {
    const details = card.children[1]?.firstElementChild;
    const metricsRow = details
      ? [...details.children].find((element) => {
        const className = String(element.className);
        return className.includes('h-[24px]')
          && className.includes('font-medium')
          && className.includes('overflow-hidden');
      })
      : null;

    let performance = card.querySelector('.gdh-dev-performance');
    const cardChain = (card.getAttribute('href') || '').match(/^\/([^/]+)\/token\//)?.[1];
    if (settings.showDevPerformance === false || (cardChain && !['bsc', 'robinhood', 'sol'].includes(cardChain)) || !metricsRow || card.dataset.gdhReady !== '1') {
      performance?.remove();
      return;
    }

    if (!performance) {
      performance = document.createElement('span');
      performance.className = 'gdh-dev-performance';
      metricsRow.prepend(performance);
    }

    const migrated = formatCount(card.dataset.gdhMigrated);
    const total = formatCount(card.dataset.gdhTotal);
    const ratio = formatRatio(card);
    applyRateColor(performance, getRatioPercent(card));

    const chain = (card.getAttribute('href') || '').match(/^\/([^/]+)\/token\//)?.[1]
      || (card.hasAttribute('data-gmgn-fee-mode-card') ? 'bsc' : '');
    const ath = getDevAth(card.dataset.gdhCreator, chain);
    const rateText = `M${migrated} L${total} · ${ratio}`;
    const mcText = ath ? `ATH ${formatAthMc(ath.mc)}` : '';
    const tier = ath ? athTierClass(ath.mc) : '';
    const signature = `${rateText}|${mcText}|${tier}`;
    if (performance.dataset.gdhSig !== signature) {
      performance.dataset.gdhSig = signature;
      performance.textContent = '';
      const rateEl = document.createElement('span');
      rateEl.textContent = rateText;
      performance.appendChild(rateEl);
      if (mcText) {
        const sep = document.createElement('span');
        sep.className = 'gdh-dev-performance__sep';
        sep.textContent = '·';
        const mcEl = document.createElement('span');
        mcEl.className = `gdh-dev-performance__mc ${tier}`;
        mcEl.textContent = mcText;
        performance.append(sep, mcEl);
      }
    }
    performance.title = `Developer migrated tokens: ${migrated}\nDeveloper launches: ${total}\nMigration rate: ${ratio}${
      ath ? `\nHighest-market-cap token: ${ath.symbol || 'Unknown'} ${formatAthMc(ath.mc)}` : ''
    }`;
  }

  function getDeveloperPanelContexts() {
    return [...document.querySelectorAll('div')]
      .filter((element) => (
        element.children.length === 0
        && element.textContent?.trim() === '\u4ee3\u5e01\u7edf\u8ba1'
        && element.getClientRects().length > 0
      ))
      .map((heading) => {
        const container = heading.parentElement;
        const creatorLink = [...container.querySelectorAll('a[href^="/bsc/address/"]')]
          .find((link) => /^\/bsc\/address\/0x[a-fA-F0-9]{40}$/.test(link.getAttribute('href') || ''));
        const match = creatorLink?.getAttribute('href')?.match(/\/bsc\/address\/(0x[a-fA-F0-9]{40})$/);
        const symbolElement = document.querySelector('#token-base-symbol[data-symbol]');
        const symbol = String(symbolElement?.dataset.symbol || symbolElement?.textContent || '').trim();
        if (!container || !match || !symbol) return null;
        return {
          container,
          creator: match[1].toLowerCase(),
          label: `${symbol}dev`,
          insertAfter: container.querySelector('[data-sentry-component="DevFundsSource"]'),
        };
      })
      .filter(Boolean);
  }

  function updateDeveloperButton(button) {
    const address = normalizeAddress(button.dataset.gdhDevAddress);
    const saved = watchedMap.get(address);
    const nextText = saved
      ? `✓ Saved · ${saved.label || address}`
      : '☆ Save developer';
    button.classList.toggle('is-saved', Boolean(saved));
    if (button.textContent !== nextText) button.textContent = nextText;
    button.title = saved
      ? `Saved ${address}`
      : `Save GMGN developer ${address}`;
  }

  function saveDeveloper(button) {
    const address = normalizeAddress(button.dataset.gdhDevAddress);
    const label = String(button.dataset.gdhDevLabel || '').trim();
    if (!address || !label) return;

    const current = Array.isArray(settings.watchedDevs) ? settings.watchedDevs : [];
    const next = [
      ...current.filter((item) => normalizeAddress(item?.address) !== address),
      { address, label },
    ];

    button.disabled = true;
    button.textContent = 'Saving…';
    chrome.storage.local.set({ watchedDevs: next }, () => {
      button.disabled = false;
      const error = chrome.runtime?.lastError;
      if (error) {
        button.textContent = 'Could not save. Try again.';
        button.title = error.message;
        return;
      }
      settings.watchedDevs = next;
      rebuildWatchedMap();
      updateDeveloperButton(button);
      scheduleScan();
    });
  }

  function ensureDeveloperBookmarkButtons() {
    if (settings.enableDevBookmark === false) {
      document.querySelectorAll('.gdh-dev-save-button').forEach((button) => button.remove());
      return;
    }

    for (const context of getDeveloperPanelContexts()) {
      let button = context.container.querySelector(':scope > .gdh-dev-save-button');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'gdh-dev-save-button';
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          saveDeveloper(button);
        });
        if (context.insertAfter) context.insertAfter.insertAdjacentElement('afterend', button);
        else context.container.appendChild(button);
      }
      button.dataset.gdhDevAddress = context.creator;
      button.dataset.gdhDevLabel = context.label;
      updateDeveloperButton(button);
    }
  }

  function applyCardState(card) {
    if (!card.closest('[data-sentry-component="PumpSubX"]')
      && !card.matches('[data-testid="trench-token-card"]')) return;

    applyDevPerformance(card);

    const creator = normalizeAddress(card.dataset.gdhCreator);
    const watched = watchedMap.get(creator);
    const highlightEnabled = settings.enabled !== false;
    const tooltipEnabled = settings.showDevTooltip !== false;
    if (!watched || (!highlightEnabled && !tooltipEnabled)) {
      clearWatchState(card);
      return;
    }

    card.dataset.gdhWatched = '1';
    card.dataset.gdhWatchLabel = watched.label;
    if (highlightEnabled) {
      card.dataset.gdhHighlighted = '1';
      card.dataset.gdhBadge = watched.label ? `★ ${watched.label}` : '★ WATCHED DEV';
    } else {
      delete card.dataset.gdhHighlighted;
      delete card.dataset.gdhBadge;
    }
  }

  function getCallerFromElement(element) {
    return normalizeBlockedCaller({
      wallet: element.dataset.gdhCallerWallet,
      handle: element.dataset.gdhCallerHandle,
      name: element.dataset.gdhCallerName,
    });
  }

  function callersMatch(left, right) {
    return Boolean(
      (left.wallet && right.wallet && left.wallet === right.wallet)
      || (left.handle && right.handle && left.handle === right.handle),
    );
  }

  function isCallerBlocked(caller) {
    return Boolean(
      settings.enableCalloutBlacklist !== false
      &&
      caller
      && ((caller.wallet && blockedWallets.has(caller.wallet))
        || (caller.handle && blockedHandles.has(caller.handle))),
    );
  }

  function findCalloutHeading(scope) {
    return [...scope.querySelectorAll('span')].find((element) => (
      element.children.length === 0 && element.textContent?.trim() === '\u558a\u5355'
    ));
  }

  function getCalloutPanelContext() {
    const panel = document.querySelector('[data-sentry-component="GlobalCalloutPanel"]');
    if (panel) {
      const heading = findCalloutHeading(panel);
      const header = heading?.parentElement?.parentElement;
      const controls = header?.children[1];
      if (!heading || !header || !controls) return null;
      return { panel, header, controls };
    }

    for (const tab of document.querySelectorAll('button[data-sentry-component="renderTab"]')) {
      const tabsRow = tab.parentElement?.parentElement;
      const headerBlock = tabsRow?.parentElement;
      const header = headerBlock?.children[0];
      const root = headerBlock?.parentElement;
      if (!header || !root || header === tabsRow) continue;
      const heading = findCalloutHeading(header);
      const controls = heading ? header.children[1] : null;
      if (!heading || !controls) continue;
      return { panel: root, header, controls };
    }
    return null;
  }

  function showCalloutToast(text) {
    const context = getCalloutPanelContext();
    if (!context) return;
    let toast = context.panel.querySelector(':scope > .gdh-callout-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'gdh-callout-toast';
      context.panel.appendChild(toast);
    }
    toast.textContent = text;
    window.clearTimeout(calloutToastTimer);
    calloutToastTimer = window.setTimeout(() => toast.remove(), 1800);
  }

  function persistBlockedCallers(next, successMessage) {
    const previous = getBlockedCallers();
    settings.blockedCallers = next;
    rebuildBlockedCallerIndex();
    scanCalloutBlacklist();

    chrome.storage.local.set({ blockedCallers: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.blockedCallers = previous;
        rebuildBlockedCallerIndex();
        scanCalloutBlacklist();
        showCalloutToast('Could not save the blocklist');
        return;
      }
      showCalloutToast(successMessage);
    });
  }

  function blockCaller(caller) {
    if (!caller) return;
    const next = [
      ...getBlockedCallers().filter((item) => !callersMatch(item, caller)),
      caller,
    ];
    const label = caller.handle ? `@${caller.handle}` : caller.name || caller.wallet;
    persistBlockedCallers(next, `Blocked ${label}`);
  }

  function unblockCaller(caller) {
    const next = getBlockedCallers().filter((item) => !callersMatch(item, caller));
    const label = caller.handle ? `@${caller.handle}` : caller.name || caller.wallet;
    persistBlockedCallers(next, `Unblocked ${label}`);
  }

  function renderBlacklistModal(modal) {
    const callers = getBlockedCallers();
    const key = JSON.stringify(callers);
    if (modal.dataset.gdhBlacklistKey === key) return;
    modal.dataset.gdhBlacklistKey = key;

    const list = modal.querySelector('.gdh-callout-blacklist-list');
    list.replaceChildren();
    if (!callers.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-callout-blacklist-empty';
      empty.textContent = 'No callout accounts are blocked';
      list.appendChild(empty);
      return;
    }

    for (const caller of callers) {
      const item = document.createElement('div');
      item.className = 'gdh-callout-blacklist-item';

      const identity = document.createElement('div');
      identity.className = 'gdh-callout-blacklist-identity';
      const name = document.createElement('strong');
      name.textContent = caller.name || (caller.handle ? `@${caller.handle}` : caller.wallet);
      const details = document.createElement('span');
      const wallet = caller.wallet
        ? `${caller.wallet.slice(0, 8)}…${caller.wallet.slice(-6)}`
        : '';
      details.textContent = [caller.handle ? `@${caller.handle}` : '', wallet]
        .filter(Boolean)
        .join(' · ');
      identity.append(name, details);

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'gdh-callout-unblock-button';
      removeButton.textContent = 'Unblock';
      removeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
      removeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        unblockCaller(caller);
      });

      item.append(identity, removeButton);
      list.appendChild(item);
    }
  }

  function ensureBlacklistModal(panel) {
    let modal = panel.querySelector(':scope > .gdh-callout-blacklist-modal');
    if (!blacklistModalOpen) {
      modal?.remove();
      return;
    }

    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-callout-blacklist-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const header = document.createElement('div');
      header.className = 'gdh-callout-blacklist-header';
      const title = document.createElement('strong');
      title.textContent = 'Callout blocklist';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-callout-blacklist-close';
      close.textContent = '×';
      close.title = 'Close blocklist';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blacklistModalOpen = false;
        modal.remove();
        scheduleScan();
      });
      header.append(title, close);

      const list = document.createElement('div');
      list.className = 'gdh-callout-blacklist-list';
      modal.append(header, list);
      panel.appendChild(modal);
    }
    renderBlacklistModal(modal);
  }

  function ensureCalloutControls() {
    const context = getCalloutPanelContext();
    if (!context) return;
    context.panel.classList.add('gdh-callout-panel-host');

    let button = context.controls.querySelector(':scope > .gdh-callout-blacklist-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-callout-blacklist-button';
      button.title = 'Manage callout blocklist';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blacklistModalOpen = !blacklistModalOpen;
        scheduleScan();
      });
      context.controls.prepend(button);
    }

    const count = getBlockedCallers().length;
    const text = count ? `Blocklist ${count}` : 'Blocklist';
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-active', blacklistModalOpen);
    ensureBlacklistModal(context.panel);
  }

  function ensureCalloutBlockButton(card) {
    const addressView = card.querySelector('[data-sentry-component="WalletAddressView"]');
    const addressLink = addressView?.closest('a[href*="/address/"]');
    const titleRow = addressLink?.parentElement;
    if (!titleRow) return;

    let button = titleRow.querySelector(':scope > .gdh-callout-block-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-callout-block-button';
      button.textContent = 'Block';
      button.title = 'Block this callout account';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blockCaller(getCallerFromElement(card));
      });
      titleRow.appendChild(button);
    }
  }

  function applyCalloutCardState(card) {
    const host = card.closest('.gmgn-vlist-item') || card;
    if (host.dataset.gdhCalloutHost !== '1') host.dataset.gdhCalloutHost = '1';
    const caller = getCallerFromElement(card);
    const blocked = isCallerBlocked(caller);
    if (blocked) host.dataset.gdhCallerBlocked = '1';
    else delete host.dataset.gdhCallerBlocked;
    if (caller) ensureCalloutBlockButton(card);
  }

  function applyManifestoState(chip) {
    const blocked = isCallerBlocked(getCallerFromElement(chip));
    if (blocked) chip.dataset.gdhCallerBlocked = '1';
    else delete chip.dataset.gdhCallerBlocked;
  }

  const MARKED_TTL = 120000;
  let markedMap = new Map();
  const markedByChain = new Map();
  let markedLoading = false;
  const FOMO_FOLLOWED_HOLDERS_TTL = 60000;
  const FOMO_FOLLOWED_HOLDERS_RETRY_MIN = 15000;
  const FOMO_FOLLOWED_HOLDERS_RETRY_MAX = 120000;
  const fomoFollowedHoldersByChain = new Map();
  const fomoFollowedHoldersInflight = new Map();
  const fomoFollowedHoldersFailures = new Map();
  let fomoFollowedHoldersGeneration = 0;

  function normalizeFomoTokenAddress(value) {
    const source = String(value || '').trim();
    return /^0x[a-fA-F0-9]{40}$/.test(source) ? source.toLowerCase()
      : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(source) ? source : '';
  }

  function visibleFomoTokenRefs() {
    const route = currentTokenRoute();
    if (!route || settings.enableFomoPanel === false || settings.enableMarkedHolders === false
      || document.visibilityState !== 'visible') return [];
    const address = normalizeFomoTokenAddress(route.address);
    const networkId = FOMO_NETWORK_ID[route.chain];
    return address && networkId ? [{ address, networkId }] : [];
  }

  let fomoFollowedHoldersContextInvalidated = false;
  async function loadFomoFollowedHoldings() {
    if (fomoFollowedHoldersContextInvalidated) return;
    const route = currentTokenRoute();
    if (!route || settings.enableFomoPanel === false || settings.enableMarkedHolders === false
      || document.visibilityState !== 'visible') return;
    const chain = route.chain;
    if (!FOMO_NETWORK_ID[chain]) return;
    const failure = fomoFollowedHoldersFailures.get(chain);
    if (failure && Date.now() < failure.retryAt) return;
    const tokens = visibleFomoTokenRefs();
    if (!tokens.length) return;
    const requested = new Set(tokens.map((item) => item.address));
    const cached = fomoFollowedHoldersByChain.get(chain);
    const cacheCoversVisible = cached
      && [...requested].every((address) => cached.requested.has(address));
    if (cacheCoversVisible && Date.now() - cached.at < FOMO_FOLLOWED_HOLDERS_TTL) return;
    if (fomoFollowedHoldersInflight.has(chain)) return fomoFollowedHoldersInflight.get(chain);

    const generation = fomoFollowedHoldersGeneration;
    // sendMessage can THROW synchronously after an extension reload. Start the
    // call inside the promise chain so both throws and rejections are handled.
    const inflight = Promise.resolve().then(() => chrome.runtime.sendMessage({
      type: 'fomo-followed-holders',
      payload: { tokens },
    })).then((res) => {
      if (generation !== fomoFollowedHoldersGeneration) return;
      if (!res?.ok) {
        const count = (fomoFollowedHoldersFailures.get(chain)?.count || 0) + 1;
        const delay = Math.min(
          FOMO_FOLLOWED_HOLDERS_RETRY_MAX,
          FOMO_FOLLOWED_HOLDERS_RETRY_MIN * (2 ** Math.min(count - 1, 3)),
        );
        fomoFollowedHoldersFailures.set(chain, { count, retryAt: Date.now() + delay });
        if (res?.reason === 'not-connected') {
          fomoFollowedHoldersByChain.delete(chain);
          scheduleScan();
        }
        return;
      }
      fomoFollowedHoldersFailures.delete(chain);
      const map = new Map();
      for (const holding of (Array.isArray(res.holdings) ? res.holdings : [])) {
        const address = normalizeFomoTokenAddress(holding?.address);
        const count = Number(holding?.count);
        if (!address || !requested.has(address) || Number(holding.networkId) !== FOMO_NETWORK_ID[chain] || !(count > 0)) continue;
        const names = (Array.isArray(holding?.users) ? holding.users : [])
          .map((user) => String(user?.handle || user?.name || '').trim().replace(/^@/, ''))
          .filter(Boolean);
        map.set(address, { count, names: [...new Set(names)] });
      }
      fomoFollowedHoldersByChain.set(chain, { at: Date.now(), requested, map });
      scheduleScan();
    }).catch((error) => {
      if (/extension context invalidated/i.test(String(error?.message || error))) {
        fomoFollowedHoldersContextInvalidated = true;
        fomoFollowedHoldersGeneration += 1;
        fomoFollowedHoldersByChain.clear();
        fomoFollowedHoldersFailures.clear();
        fomoFollowedHoldersInflight.clear();
        return;
      }
      if (generation !== fomoFollowedHoldersGeneration) return;
      const count = (fomoFollowedHoldersFailures.get(chain)?.count || 0) + 1;
      const delay = Math.min(
        FOMO_FOLLOWED_HOLDERS_RETRY_MAX,
        FOMO_FOLLOWED_HOLDERS_RETRY_MIN * (2 ** Math.min(count - 1, 3)),
      );
      fomoFollowedHoldersFailures.set(chain, { count, retryAt: Date.now() + delay });
    }).finally(() => {
      if (fomoFollowedHoldersInflight.get(chain) === inflight) {
        fomoFollowedHoldersInflight.delete(chain);
      }
    });
    fomoFollowedHoldersInflight.set(chain, inflight);
    return inflight;
  }

  function getMarkedHolders() {
    return (Array.isArray(settings.markedHolders) ? settings.markedHolders : [])
      .filter((x) => x && typeof x.address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(x.address));
  }

  function currentChain() {
    const m = location.pathname.match(/^\/([a-z0-9]+)\//);
    if (m && m[1] in FOMO_NETWORK_ID) return m[1];
    const q = new URLSearchParams(location.search).get('chain');
    const chain = String(q || '').toLowerCase();
    return chain in FOMO_NETWORK_ID ? chain : '';
  }

  let markedApiQuery = '';

  function gmgnAccessToken() {
    try {
      const raw = window.localStorage.getItem('tgInfo');
      if (!raw) return '';
      const token = JSON.parse(raw)?.token?.access_token;
      return typeof token === 'string' && token.length > 20 ? token : '';
    } catch {
      return '';
    }
  }

  function gmgnApiQuery() {
    if (markedApiQuery) return markedApiQuery;
    try {
      const src = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((u) => u.includes('gmgn.ai/') && u.includes('device_id='));
      if (src) markedApiQuery = src.split('?')[1] || '';
    } catch {
    }
    return markedApiQuery;
  }

  async function loadMarkedHoldings() {
    const chain = currentChain();
    if (!chain) return;
    if (settings.enableMarkedHolders === false) return void (markedMap = new Map());
    const people = getMarkedHolders();
    if (!people.length) return void (markedMap = new Map());
    const cached = markedByChain.get(chain);
    if (cached && Date.now() - cached.at < MARKED_TTL) {
      if (markedMap !== cached.map) markedMap = cached.map;
      return;
    }
    if (markedLoading) return;
    markedLoading = true;
    const next = new Map();
    const MARKED_MIN_USD = 30;
    const put = (token, label) => {
      const key = String(token).toLowerCase();
      if (!next.has(key)) next.set(key, []);
      const list = next.get(key);
      if (!list.includes(label)) list.push(label);
    };
    const rest = people;
    const apiQuery = rest.length ? gmgnApiQuery() : '';
    const accessToken = rest.length ? gmgnAccessToken() : '';
    try {
      let first = true;
      for (const person of rest) {
        if (apiQuery === '' || !accessToken) break;
        if (!first) await new Promise((resolve) => setTimeout(resolve, 250));
        first = false;
        try {
          const addr = chain === 'eth' ? person.address.toLowerCase() : person.address;
          const params = new URLSearchParams(apiQuery);
          params.set('chain', chain);
          params.delete('wallet_addresses');
          params.append('wallet_addresses', addr);
          params.set('hide_abnormal', 'true');
          params.set('limit', '100');
          params.set('orderby', 'last_active_timestamp');
          params.set('direction', 'desc');
          params.set('show_small', 'true');
          params.set('sellout', 'false');
          const res = await fetch(`https://gmgn.ai/td/api/v1/wallets/holdings?${params}`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${accessToken}`, 'Cache-Control': 'no-cache' },
          });
          const body = await res.json().catch(() => null);
          const holdings = res.ok && body?.code === 0 && Array.isArray(body?.data?.holdings)
            ? body.data.holdings : [];
          for (const h of holdings) {
            const token = String(h?.token_address || h?.token_basic_stats?.address || '').toLowerCase();
            if (!token) continue;
            const usd = Number(h?.usd_value);
            if (Number.isFinite(usd) && usd < MARKED_MIN_USD) continue;
            put(token, Number.isFinite(usd) ? `${person.name}(${fomoUsd(usd)})` : person.name);
          }
        } catch {
        }
      }
      markedMap = next;
      markedByChain.set(chain, { map: next, at: Date.now() });
    } finally {
      markedLoading = false;
    }
  }

  function ensureMarkedBadge(host, tokenAddress) {
    const route = currentTokenRoute();
    if (!route || !host.matches('.gdh-fomo-launcher')) return;
    const token = normalizeFomoTokenAddress(tokenAddress);
    const cached = fomoFollowedHoldersByChain.get(route.chain);
    const covered = cached?.requested.has(token);
    const failure = fomoFollowedHoldersFailures.get(route.chain);
    const fresh = covered && Date.now() - cached.at < FOMO_FOLLOWED_HOLDERS_TTL;
    const followed = fresh ? cached.map.get(token) : null;
    let badge = host.querySelector(':scope > .gdh-marked');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'gdh-marked is-followed';
      host.appendChild(badge);
    }
    const text = fresh ? `👥${Number(followed?.count) || 0}` : failure ? '👥?' : '👥…';
    const title = fresh
      ? `People you follow on FOMO currently holding this token: ${Number(followed?.count) || 0}${followed?.names?.length ? ` · ${followed.names.join(', ')}` : ''}`
      : failure ? 'Followed holders unavailable. Sign in to FOMO; retries are rate-limited.' : 'Checking followed holders for this token only';
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.title !== title) badge.title = title;
    if (host.title !== title) host.title = title;
  }

  function scanMarkedBadges() {
    // No tracker/trenches scans or arbitrary-wallet requests: token detail only.
    document.querySelectorAll('.gdh-marked').forEach((el) => {
      if (!el.closest('.gdh-fomo-launcher')) el.remove();
    });
    const launcher = document.querySelector('.gdh-fomo-launcher');
    if (!currentTokenRoute() || settings.enableFomoPanel === false || settings.enableMarkedHolders === false) {
      launcher?.querySelector('.gdh-marked')?.remove();
      return;
    }
    loadFomoFollowedHoldings();
    if (launcher) ensureMarkedBadge(launcher, currentTokenRoute().address);
  }

  const HOLDER_ROW_SELECTOR = '[data-testid="token-detail-holders-row"]';
  let onchainBalances = { key: '', list: [], loaded: 0 };

  function refreshOnchainBalances() {
    const route = currentTokenRoute();
    if (!route) return;
    const rows = [...document.querySelectorAll(HOLDER_ROW_SELECTOR)];
    if (!rows.length) return;
    const list = rows
      .map((r) => Number(r.dataset.gdhHolderBalance))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a);
    if (!list.length) return;
    const key = `${route.chain}|${route.address}`;
    const merged = key === onchainBalances.key
      ? [...new Set([...onchainBalances.list, ...list])].sort((a, b) => b - a)
      : list;
    onchainBalances = { key, list: merged, loaded: merged.length };
  }

  function onchainRank(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const route = currentTokenRoute();
    if (!route || onchainBalances.key !== `${route.chain}|${route.address}`) return null;
    const list = onchainBalances.list;
    if (!list.length) return null;
    let above = 0;
    for (const b of list) { if (b > amount) above += 1; else break; }
    const smallest = list[list.length - 1];
    return { rank: above + 1, exact: amount >= smallest, loaded: list.length };
  }

  function buildRankBadge(amount) {
    const info = onchainRank(amount);
    if (!info) return null;
    const el = document.createElement('span');
    el.className = 'gdh-fomo-rank';
    if (info.exact) {
      el.textContent = `On-chain #${info.rank}`;
      el.classList.toggle('is-top', info.rank <= 10);
      el.title = `Ranked #${info.rank} by balance in GMGN holders (${info.loaded} rows loaded)`;
    } else {
      el.textContent = `#${info.loaded}+`;
      el.classList.add('is-out');
      el.title = `Balance is below the ${info.loaded} loaded rows. Scroll further through GMGN holders for a more accurate rank.`;
    }
    return el;
  }

  let blockedTokenSet = new Set();

  function getBlockedTokens() {
    return (Array.isArray(settings.blockedTokens) ? settings.blockedTokens : [])
      .filter((item) => item && typeof item.address === 'string');
  }

  function rebuildBlockedTokenIndex() {
    blockedTokenSet = new Set(getBlockedTokens().map((item) => item.address.toLowerCase()));
  }

  function isTokenBlocked(address) {
    return Boolean(address && blockedTokenSet.has(String(address).toLowerCase()));
  }

  function persistBlockedTokens(next, message) {
    const previous = getBlockedTokens();
    settings.blockedTokens = next;
    rebuildBlockedTokenIndex();
    scanSpecialWallets();

    chrome.storage.local.set({ blockedTokens: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.blockedTokens = previous;
        rebuildBlockedTokenIndex();
        scanSpecialWallets();
        return;
      }
      showTrackToast(message);
    });
  }

  function toggleBlockedToken(address, symbol) {
    if (!address) return;
    const key = String(address).toLowerCase();
    const list = getBlockedTokens();
    if (blockedTokenSet.has(key)) {
      persistBlockedTokens(
        list.filter((item) => item.address.toLowerCase() !== key),
        `Restored tracking activity for ${symbol || 'this token'}`,
      );
      return;
    }
    persistBlockedTokens(
      [{ address: key, symbol: String(symbol || '').slice(0, 24), at: Date.now() }, ...list].slice(0, 300),
      `Blocked ${symbol || 'this token'}; restore it from the 🚫 list`,
    );
  }

  let trackToastTimer = 0;
  function showTrackToast(text) {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    if (!panel || !text) return;
    let toast = panel.querySelector(':scope > .gdh-track-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'gdh-track-toast';
      panel.appendChild(toast);
    }
    toast.textContent = text;
    window.clearTimeout(trackToastTimer);
    trackToastTimer = window.setTimeout(() => toast.remove(), 2000);
  }

  function findTrackerSymbolNode(card, symbol) {
    if (!symbol) return null;
    const target = symbol.trim();
    if (!target) return null;
    const nodes = card.querySelectorAll('span, div, p');
    for (const node of nodes) {
      if (node.querySelector('span, div, p')) continue;
      if (node.closest('a[href*="/address/"]')) continue;
      if ((node.textContent || '').trim() === target) return node;
    }
    return null;
  }

  function markBlockedHosts(card, blocked) {
    let el = card;
    for (let level = 0; level < 6 && el instanceof HTMLElement; level += 1) {
      if (blocked) el.dataset.gdhTokenBlocked = '1';
      else delete el.dataset.gdhTokenBlocked;
      if ((el.style.position || '') === 'absolute') break;
      const parent = el.parentElement;
      if (!parent) break;
      if (parent.querySelectorAll(TRACKER_ITEM_SELECTOR).length > 1) break;
      el = parent;
    }
  }

  function ensureTokenBlockButton(card, address, symbol) {
    let button = card.querySelector('.gdh-tokenblock');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-tokenblock';
      let holdTimer = 0;
      const cancelHold = () => {
        window.clearTimeout(holdTimer);
        holdTimer = 0;
        button.classList.remove('is-holding');
      };
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isTokenBlocked(button.dataset.gdhTbAddr || '')) return;
        button.classList.add('is-holding');
        holdTimer = window.setTimeout(() => {
          cancelHold();
          button.dataset.gdhTbFiredAt = String(Date.now());
          toggleBlockedToken(button.dataset.gdhTbAddr || '', button.dataset.gdhTbSymbol || '');
        }, 1000);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => {
        button.addEventListener(type, cancelHold);
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() - Number(button.dataset.gdhTbFiredAt || 0) < 500) return;
        if (isTokenBlocked(button.dataset.gdhTbAddr || '')) {
          toggleBlockedToken(button.dataset.gdhTbAddr || '', button.dataset.gdhTbSymbol || '');
        }
      });
      const symbolRow = card.querySelector(TRACKER_SYMBOL_CELL);
      const nameNode = symbolRow ? null : findTrackerSymbolNode(card, symbol);
      if (symbolRow) symbolRow.appendChild(button);
      else if (nameNode) nameNode.insertAdjacentElement('afterend', button);
      else {
        const fallback = findCardActionContainer(card);
        if (fallback) fallback.appendChild(button);
        else card.appendChild(button);
      }
    }
    button.dataset.gdhTbAddr = address;
    button.dataset.gdhTbSymbol = symbol || '';
    const blocked = isTokenBlocked(address);
    button.textContent = blocked ? '🔔' : '🚫';
    button.title = blocked
      ? `Select to restore ${symbol || 'this token'} in tracking`
      : `Hold for one second to hide ${symbol || 'this token'} from tracking`;
    button.classList.toggle('is-blocked', blocked);
  }

  const TRACKER_ITEM_SELECTOR = '[data-sentry-component="TrackerListItem"]';
  const TRACKER_TABLE_ITEM_SELECTOR = '[data-sentry-component="TrackingBody"] [data-sentry-component="TableItem"][href*="/token/"]';
  const TRACKER_DATA_SELECTOR = '[data-gdh-track-addr][data-gdh-track-ts]';
  const TRACKER_SYMBOL_CELL = '[data-testid="follow-tracking-row-symbol"]';
  const TRACKER_MAKER_CELL = '[data-testid="follow-tracking-row-maker"]';
  const TRACKER_TABLE_HEADER = '[data-testid="follow-tracking-table-header"]';
  function isTrackerTableMode() {
    if (document.querySelector(`${TRACKER_TABLE_HEADER}, ${TRACKER_TABLE_ITEM_SELECTOR}`)) return true;
    const first = trackerCards()[0];
    const fixed = first ? fomoFeedFixedRow(first) : null;
    return !!(fixed && fixed.h > 0 && fixed.h <= 50);
  }

  function trackerCards() {
    const found = new Set();
    document.querySelectorAll(TRACKER_ITEM_SELECTOR).forEach((el) => found.add(el));
    document.querySelectorAll(TRACKER_DATA_SELECTOR).forEach((el) => found.add(el));
    document.querySelectorAll(TRACKER_SYMBOL_CELL).forEach((cell) => {
      const tagged = cell.closest(TRACKER_ITEM_SELECTOR);
      if (tagged) return void found.add(tagged);
      let el = cell.parentElement;
      for (let level = 0; level < 6 && el instanceof HTMLElement; level += 1) {
        if (el.querySelector(TRACKER_MAKER_CELL)) return void found.add(el);
        el = el.parentElement;
      }
    });
    return [...found];
  }
  const WALLET_TABLE_SELECTOR = '[data-sentry-component="WalletTable"]';
  const TRACK_TAB_CELL = '[data-testid="follow-tracking-wallet-tab"], [data-testid="follow-tracking-tab"]';

  function walletTableScopes() {
    const scopes = new Set();
    document.querySelectorAll(WALLET_TABLE_SELECTOR).forEach((el) => scopes.add(el));
    document.querySelectorAll(TRACK_TAB_CELL).forEach((tab) => {
      let el = tab.parentElement;
      for (let level = 0; level < 8 && el instanceof HTMLElement; level += 1) {
        if (el.querySelector('a[href*="/address/"]')) return void scopes.add(el);
        el = el.parentElement;
      }
    });
    return [...scopes];
  }

  function extractRowWalletAddress(scope) {
    const link = scope.querySelector('a[href*="/address/"]');
    const fromHref = walletAddressFromHref(link?.getAttribute('href'));
    if (fromHref) return fromHref;
    return normalizeWalletAddress(scope.dataset?.gdhTrackMaker || '');
  }

  function extractRowWalletLabel(scope) {
    const link = scope.querySelector('a[href*="/address/"]');
    const text = String(link?.textContent || '').trim();
    return (text || scope.dataset?.gdhTrackNick || '').slice(0, 32);
  }

  function isSpecialWallet(address) {
    return Boolean(address && specialWalletMap.has(address));
  }

  function specialWalletColor(address) {
    return specialWalletMap.get(address)?.color || SPECIAL_COLOR_PALETTE[0];
  }

  function hexToRgba(hex, alpha) {
    const m = String(hex).match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return `rgba(245, 184, 61, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function persistSpecialWallets(next) {
    const previous = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    settings.specialWallets = next;
    rebuildSpecialWalletSet();
    scanSpecialWallets();
    chrome.storage.local.set({ specialWallets: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.specialWallets = previous;
        rebuildSpecialWalletSet();
        scanSpecialWallets();
      }
    });
  }

  function toggleSpecialWallet(address, label) {
    if (!address) return;
    const current = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    const exists = current.some((item) => normalizeWalletAddress(item?.address) === address);
    const next = exists
      ? current.filter((item) => normalizeWalletAddress(item?.address) !== address)
      : [...current, { address, label: label || '', color: SPECIAL_COLOR_PALETTE[0] }];
    persistSpecialWallets(next);
  }

  function setSpecialWalletColor(address, color) {
    if (!address || !specialWalletMap.has(address)) return;
    if (color !== 'rainbow' && !/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return;
    const next = (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
      .map((item) => (
        normalizeWalletAddress(item?.address) === address
          ? { ...item, color: normalizeSpecialColor(color) }
          : item
      ));
    persistSpecialWallets(next);
  }

  function setSpecialWalletPin(address, pin) {
    if (!address || !specialWalletMap.has(address)) return;
    const next = (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
      .map((item) => (
        normalizeWalletAddress(item?.address) === address ? { ...item, pin: pin === true } : item
      ));
    persistSpecialWallets(next);
  }

  function addSpecialWallet(address, label, color, pin) {
    const normalized = normalizeWalletAddress(address);
    if (!normalized || specialWalletMap.has(normalized)) return false;
    const current = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    persistSpecialWallets([
      ...current,
      {
        address: normalized,
        label: String(label || '').trim().slice(0, 32),
        color: normalizeSpecialColor(color),
        pin: pin === true,
      },
    ]);
    return true;
  }

  let colorPaletteEl = null;

  function closeColorPalette() {
    colorPaletteEl?.remove();
    colorPaletteEl = null;
  }

  function openColorPalette(address, anchorRect) {
    closeColorPalette();
    const palette = document.createElement('div');
    palette.className = 'gdh-color-palette';
    palette.addEventListener('pointerdown', (event) => event.stopPropagation());
    const current = specialWalletColor(address);

    const colorsRow = document.createElement('div');
    colorsRow.className = 'gdh-color-palette__row';
    for (const color of SPECIAL_COLOR_PALETTE) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'gdh-color-palette__dot';
      dot.style.background = color;
      dot.classList.toggle('is-current', color === current);
      dot.title = color;
      dot.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setSpecialWalletColor(address, color);
        closeColorPalette();
      });
      colorsRow.appendChild(dot);
    }
    const rainbow = document.createElement('button');
    rainbow.type = 'button';
    rainbow.className = 'gdh-color-palette__dot gdh-color-palette__dot--rainbow';
    rainbow.classList.toggle('is-current', current === 'rainbow');
    rainbow.title = 'Rainbow highlight';
    rainbow.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSpecialWalletColor(address, 'rainbow');
      closeColorPalette();
    });
    colorsRow.appendChild(rainbow);
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'gdh-color-palette__custom';
    custom.value = current === 'rainbow' ? SPECIAL_COLOR_PALETTE[0] : current;
    custom.title = 'Custom color';
    custom.addEventListener('change', () => {
      setSpecialWalletColor(address, custom.value);
      closeColorPalette();
    });
    colorsRow.appendChild(custom);
    palette.appendChild(colorsRow);

    const pinRow = document.createElement('label');
    pinRow.className = 'gdh-color-palette__pin';
    const pinBox = document.createElement('input');
    pinBox.type = 'checkbox';
    pinBox.checked = specialWalletMap.get(address)?.pin === true;
    pinBox.addEventListener('change', () => {
      setSpecialWalletPin(address, pinBox.checked);
    });
    const pinText = document.createElement('span');
    pinText.textContent = '📌 Pin new activity for 10 seconds';
    pinRow.append(pinBox, pinText);
    palette.appendChild(pinRow);

    document.body.appendChild(palette);
    const width = palette.offsetWidth || 220;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left - width / 2));
    let top = anchorRect.bottom + 6;
    const height = palette.offsetHeight || 60;
    if (top + height + 8 > window.innerHeight) top = anchorRect.top - height - 6;
    palette.style.left = `${Math.round(left)}px`;
    palette.style.top = `${Math.round(top)}px`;
    colorPaletteEl = palette;
  }

  document.addEventListener('pointerdown', (event) => {
    if (!colorPaletteEl) return;
    if (event.target instanceof Node && colorPaletteEl.contains(event.target)) return;
    closeColorPalette();
  }, true);
  document.addEventListener('scroll', () => closeColorPalette(), true);

  function findCardActionContainer(card) {
    const span = [...card.querySelectorAll('span')].find((el) => (
      el.children.length <= 1
      && /^(\u5efa\u4ed3|\u52a0\u4ed3|\u51cf\u4ed3|\u6e05\u4ed3)/.test((el.textContent || '').trim())
    ));
    return span?.parentElement instanceof HTMLElement ? span.parentElement : null;
  }

  function ensureStarButton(host, address, label, anchor, insertMode) {
    let button = host.querySelector('.gdh-star-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-star-button';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSpecialWallet(
          button.dataset.gdhStarAddr || '',
          button.dataset.gdhStarLabel || '',
        );
      });
      if (anchor instanceof HTMLElement && insertMode === 'after') {
        button.classList.add('gdh-star-button--inline');
        anchor.insertAdjacentElement('afterend', button);
      } else if (anchor instanceof HTMLElement && insertMode === 'append') {
        button.classList.add('gdh-star-button--inline');
        anchor.appendChild(button);
      } else {
        host.appendChild(button);
      }
    }
    button.dataset.gdhStarAddr = address;
    button.dataset.gdhStarLabel = label;
    const starred = isSpecialWallet(address);
    const starColor = starred ? specialWalletColor(address) : '';
    const text = starred ? '★' : '☆';
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-starred', starred);
    button.classList.toggle('gdh-rainbow-text', starColor === 'rainbow');
    button.style.color = starred && starColor !== 'rainbow' ? starColor : '';
    button.title = starred ? 'Remove from special watch' : 'Add to special watch';

    let swatch = host.querySelector('.gdh-color-button');
    if (starred && button.classList.contains('gdh-star-button--inline')) {
      if (!swatch) {
        swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'gdh-color-button';
        swatch.addEventListener('pointerdown', (event) => event.stopPropagation());
        swatch.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openColorPalette(
            swatch.dataset.gdhStarAddr || '',
            swatch.getBoundingClientRect(),
          );
        });
        button.insertAdjacentElement('afterend', swatch);
      }
      swatch.dataset.gdhStarAddr = address;
      applySwatchColor(swatch, specialWalletColor(address));
      swatch.title = 'Choose highlight color / pin';
    } else {
      swatch?.remove();
    }
    return button;
  }

  function applySwatchColor(el, color) {
    if (color === 'rainbow') {
      el.style.background = 'conic-gradient(#ef5350, #f5b83d, #43c07a, #4c9ffe, #b48ae0, #ed6ba4, #ef5350)';
    } else {
      el.style.background = color;
    }
  }

  function applySpecialState(host, address) {
    if (isSpecialWallet(address)) {
      const color = specialWalletColor(address);
      host.dataset.gdhSpecial = '1';
      if (color === 'rainbow') {
        host.dataset.gdhSpRainbow = '1';
        host.style.removeProperty('--gdh-sp-bg');
        host.style.removeProperty('--gdh-sp-border');
      } else {
        delete host.dataset.gdhSpRainbow;
        host.style.setProperty('--gdh-sp-bg', hexToRgba(color, 0.1));
        host.style.setProperty('--gdh-sp-border', color);
      }
    } else {
      delete host.dataset.gdhSpecial;
      delete host.dataset.gdhSpRainbow;
      host.style.removeProperty('--gdh-sp-bg');
      host.style.removeProperty('--gdh-sp-border');
    }
  }

  function findWalletTableRow(link) {
    let row = link;
    for (let depth = 0; depth < 8 && row.parentElement; depth += 1) {
      row = row.parentElement;
      if (row.matches?.(WALLET_TABLE_SELECTOR)) return null;
      const cls = String(row.className || '');
      if (cls.includes('h-[44px]') || cls.includes('h-[64')) return row;
      const rect = row.getBoundingClientRect();
      if (rect.width > 200 && rect.height >= 36 && rect.height <= 130) return row;
    }
    return null;
  }

  function scanSpecialWallets() {
    if (settings.enableSpecialWallet === false) {
      closeColorPalette();
      specialManageOpen = false;
      document
        .querySelectorAll('.gdh-star-button, .gdh-color-button, .gdh-sp-manage-button, .gdh-sp-manage-modal, .gdh-pin-strip, .gdh-addw-row')
        .forEach((node) => node.remove());
      document.querySelectorAll('[data-gdh-special="1"]').forEach((node) => {
        delete node.dataset.gdhSpecial;
        delete node.dataset.gdhSpRainbow;
        node.style.removeProperty('--gdh-sp-bg');
        node.style.removeProperty('--gdh-sp-border');
      });
      document.querySelectorAll('[data-gdh-star-host="1"]').forEach((node) => {
        delete node.dataset.gdhStarHost;
      });
      return;
    }

    trackerCards().forEach((card) => {
      const address = extractRowWalletAddress(card);
      if (!address) return;
      if (card.dataset.gdhStarHost !== '1') card.dataset.gdhStarHost = '1';
      applySpecialState(card, address);
      const tokenAddr = card.dataset.gdhTrackAddr || '';
      if (tokenAddr) {
        ensureTokenBlockButton(card, tokenAddr, card.dataset.gdhTrackSymbol || '');
        markBlockedHosts(card, isTokenBlocked(tokenAddr));
      }
      ensureStarButton(
        card,
        address,
        extractRowWalletLabel(card),
        findCardActionContainer(card),
        'append',
      );
    });

    walletTableScopes().forEach((table) => {
      table.querySelectorAll('a[href*="/address/"]').forEach((link) => {
        const row = findWalletTableRow(link);
        if (!(row instanceof HTMLElement)) return;
        const address = extractRowWalletAddress(row);
        if (!address) return;
        if (row.dataset.gdhStarHost !== '1') row.dataset.gdhStarHost = '1';
        applySpecialState(row, address);
        ensureStarButton(row, address, extractRowWalletLabel(row), link, 'after');
      });
    });

    refreshOnchainBalances();
    ensureAddressPageStar();
    ensureAddWalletStarRow();
    ensureSpecialManageUI();
    scanPinnedPush();
  }

  function ensureAddressPageStar() {
    const pageAddress = walletAddressFromHref(location.pathname);
    const follow = document.querySelector('[data-sentry-component="UserFollow"]');
    const existing = document.querySelector('.gdh-star-button--address');
    if (!pageAddress || !(follow instanceof HTMLElement) || !follow.parentElement) {
      existing?.remove();
      document.querySelector('.gdh-color-button--address')?.remove();
      return;
    }
    const address = pageAddress;
    const host = follow.parentElement;
    if (host.dataset.gdhStarHost !== '1') host.dataset.gdhStarHost = '1';
    const label = String(document.title || '').split(' ')[0].trim().slice(0, 32);
    const button = ensureStarButton(host, address, label, follow, 'after');
    if (button) {
      button.classList.add('gdh-star-button--address');
      const swatch = host.querySelector('.gdh-color-button');
      swatch?.classList.add('gdh-color-button--address');
    }
  }

  const ADDR_PLACEHOLDER_RE = /\u94b1\u5305\u5730\u5740|wallet\s*address/i;
  const NAME_PLACEHOLDER_RE = /\u94b1\u5305\u540d\u79f0|wallet\s*name|\u5907\u6ce8/i;
  const ADD_SUBMIT_RE = /^(\u6dfb\u52a0\u94b1\u5305|add\s*wallet)$/i;

  function findAddWalletDialog() {
    const addrInput = [...document.querySelectorAll('input')].find((el) => (
      ADDR_PLACEHOLDER_RE.test(el.getAttribute('placeholder') || '')
      && el.getClientRects().length > 0
    ));
    if (!addrInput) return null;
    let node = addrInput.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1) {
      const submit = [...node.querySelectorAll('button, div[role="button"]')].find((el) => (
        ADD_SUBMIT_RE.test((el.textContent || '').trim())
      ));
      if (submit) {
        const nameInput = [...node.querySelectorAll('input')].find((el) => (
          el !== addrInput && NAME_PLACEHOLDER_RE.test(el.getAttribute('placeholder') || '')
        ));
        return { dialog: node, addrInput, nameInput: nameInput || null, submit };
      }
      node = node.parentElement;
    }
    return null;
  }

  function readAddWalletPref() {
    const p = settings.addWalletStarPref;
    return {
      on: p?.on === true,
      color: normalizeSpecialColor(p?.color),
      pin: p?.pin === true,
    };
  }

  function saveAddWalletPref(pref) {
    settings.addWalletStarPref = pref;
    try {
      chrome.storage.local.set({ addWalletStarPref: pref });
    } catch {
      // context invalidated
    }
  }

  async function followWalletOnChain(chain, address, name) {
    const apiQuery = gmgnApiQuery();
    if (!apiQuery) return { ok: false, reason: 'Page parameters are not ready; try again shortly' };
    const token = gmgnAccessToken();
    if (!token) return { ok: false, reason: 'Sign in to GMGN first' };
    try {
      const res = await fetch(`https://gmgn.ai/api/v1/follow/follow_wallet?${apiQuery}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // The request requires FollowWalletsRequest.WalletAddresses.
        body: JSON.stringify({
          chain,
          wallet_addresses: [address],
          remark_addresses: name ? [[address, String(name).slice(0, 32), '']] : [],
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      if (body && body.code !== undefined && body.code !== 0) {
        return { ok: false, reason: String(body.msg || body.message || `code ${body.code}`).slice(0, 40) };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message || 'Network error').slice(0, 40) };
    }
  }

  function detectAddressChain(value) {
    const v = String(value || '').trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) return 'evm';
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return 'sol';
    return '';
  }

  function ensureAddWalletStarRow() {
    const ctx = findAddWalletDialog();
    if (!ctx) return;
    if (settings.enableSpecialWallet === false) {
      ctx.dialog.querySelector(':scope .gdh-addw-row')?.remove();
      return;
    }
    let row = ctx.dialog.querySelector(':scope .gdh-addw-row');
    if (row) return;

    const pref = readAddWalletPref();
    row = document.createElement('div');
    row.className = 'gdh-addw-row';
    row.addEventListener('pointerdown', (event) => event.stopPropagation());

    const toggle = document.createElement('label');
    toggle.className = 'gdh-addw-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = pref.on;
    const star = document.createElement('span');
    star.className = 'gdh-addw-star';
    star.textContent = '★';
    const text = document.createElement('span');
    text.textContent = 'Add to special watch too';
    toggle.append(box, star, text);
    row.appendChild(toggle);

    const opts = document.createElement('div');
    opts.className = 'gdh-addw-opts';
    const dots = document.createElement('div');
    dots.className = 'gdh-addw-dots';
    let chosen = pref.color;
    const renderDots = () => {
      [...dots.querySelectorAll('.gdh-addw-dot')].forEach((d) => {
        d.classList.toggle('is-current', d.dataset.color === chosen);
      });
      star.style.color = chosen === 'rainbow' ? '' : chosen;
      star.classList.toggle('gdh-rainbow-text', chosen === 'rainbow');
    };
    [...SPECIAL_COLOR_PALETTE, 'rainbow'].forEach((color) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'gdh-addw-dot';
      dot.dataset.color = color;
      applySwatchColor(dot, color);
      dot.title = color === 'rainbow' ? 'Rainbow' : color;
      dot.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chosen = color;
        renderDots();
      });
      dots.appendChild(dot);
    });
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'gdh-addw-custom';
    custom.value = chosen === 'rainbow' ? SPECIAL_COLOR_PALETTE[0] : chosen;
    custom.title = 'Custom color';
    custom.addEventListener('input', () => {
      chosen = custom.value;
      renderDots();
    });
    dots.appendChild(custom);
    opts.appendChild(dots);

    const pinLabel = document.createElement('label');
    pinLabel.className = 'gdh-addw-pin';
    const pinBox = document.createElement('input');
    pinBox.type = 'checkbox';
    pinBox.checked = pref.pin;
    const pinText = document.createElement('span');
    pinText.textContent = '📌 Pin activity';
    pinLabel.append(pinBox, pinText);
    opts.appendChild(pinLabel);
    row.appendChild(opts);

    const syncEnabled = () => {
      row.classList.toggle('is-on', box.checked);
      opts.querySelectorAll('button, input').forEach((el) => { el.disabled = !box.checked; });
    };
    box.addEventListener('change', syncEnabled);
    syncEnabled();
    renderDots();

    const hint = document.createElement('div');
    hint.className = 'gdh-addw-cross';
    row.appendChild(hint);

    const syncCrossChain = () => {
      const value = String(ctx.addrInput.value || '').trim();
      const target = detectAddressChain(value);
      const current = currentChain() || currentChainSlug();
      const currentIsSol = current === 'sol';
      const mismatch = target === 'sol' ? !currentIsSol : currentIsSol;
      if (!value || !target || !current || !mismatch) {
        hint.replaceChildren();
        hint.classList.remove('is-on');
        return;
      }
      hint.classList.add('is-on');
      const targetChain = target === 'sol' ? 'sol' : 'bsc';
      const label = target === 'sol' ? 'Solana' : 'EVM';
      const tip = document.createElement('span');
      tip.textContent = `${label} address (current ${current.toUpperCase()} page)`;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'gdh-addw-cross__go';
      go.textContent = `Add directly to ${targetChain.toUpperCase()}`;
      go.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        go.disabled = true;
        go.textContent = 'Adding…';
        const name = String(ctx.nameInput?.value || '').trim();
        const res = await followWalletOnChain(targetChain, value, name);
        if (res.ok) {
          go.textContent = 'Added ✓';
          if (box.checked) addSpecialWallet(value, name, chosen, pinBox.checked);
          window.setTimeout(() => { syncCrossChain(); }, 1500);
        } else {
          go.disabled = false;
          go.textContent = 'Retry';
          tip.textContent = `Could not add: ${res.reason || 'Unknown error'}`;
        }
      });
      hint.replaceChildren(tip, go);
    };
    ctx.addrInput.addEventListener('input', syncCrossChain);
    ctx.addrInput.addEventListener('paste', () => setTimeout(syncCrossChain, 0));
    syncCrossChain();

    ctx.submit.addEventListener('click', () => {
      if (!box.checked) {
        saveAddWalletPref({ on: false, color: chosen, pin: pinBox.checked });
        return;
      }
      const address = String(ctx.addrInput.value || '').trim();
      const label = String(ctx.nameInput?.value || '').trim();
      saveAddWalletPref({ on: true, color: chosen, pin: pinBox.checked });
      if (!addSpecialWallet(address, label, chosen, pinBox.checked)) {
        const normalized = normalizeAddress(address);
        if (specialWalletMap.has(normalized)) {
          setSpecialWalletColor(normalized, chosen);
          setSpecialWalletPin(normalized, pinBox.checked);
        }
      }
    }, true);

    ctx.submit.parentElement?.insertBefore(row, ctx.submit);
  }

  let specialManageOpen = false;

  function specialEntries() {
    return [...specialWalletMap.entries()].map(([address, meta]) => ({ address, ...meta }));
  }

  function ensureSpecialManageUI() {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    const header = panel?.querySelector('[data-sentry-component="TrackingHeader"]');
    if (!(header instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      if (specialManageOpen) specialManageOpen = false;
      document.querySelector('.gdh-sp-manage-modal')?.remove();
      return;
    }
    let button = header.querySelector(':scope .gdh-sp-manage-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-sp-manage-button';
      button.title = 'Manage special watch';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        specialManageOpen = !specialManageOpen;
        scheduleScan();
      });
      header.appendChild(button);
    }
    const text = `★${specialWalletMap.size}`;
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-active', specialManageOpen);
    ensureSpecialManageModal(panel);
  }

  function ensureSpecialManageModal(panel) {
    let modal = panel.querySelector(':scope > .gdh-sp-manage-modal');
    if (!specialManageOpen) {
      modal?.remove();
      return;
    }
    panel.classList.add('gdh-callout-panel-host');
    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-sp-manage-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const head = document.createElement('div');
      head.className = 'gdh-sp-manage__head';
      const title = document.createElement('strong');
      title.className = 'gdh-sp-manage__title';
      title.textContent = 'Special watch / blocked tokens';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-sp-manage__close';
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        specialManageOpen = false;
        modal.remove();
        scheduleScan();
      });
      head.append(title, close);

      const addRow = document.createElement('div');
      addRow.className = 'gdh-sp-manage__add';
      const addrInput = document.createElement('input');
      addrInput.className = 'gdh-sp-manage__input gdh-sp-manage__input--addr';
      addrInput.placeholder = '0x wallet address';
      addrInput.spellcheck = false;
      const labelInput = document.createElement('input');
      labelInput.className = 'gdh-sp-manage__input gdh-sp-manage__input--label';
      labelInput.placeholder = 'Note (optional)';
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'gdh-sp-manage__addbtn';
      addButton.textContent = 'Add';
      addButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (addSpecialWallet(addrInput.value, labelInput.value)) {
          addrInput.value = '';
          labelInput.value = '';
        } else {
          addrInput.classList.add('is-error');
          window.setTimeout(() => addrInput.classList.remove('is-error'), 900);
        }
      });
      addRow.append(addrInput, labelInput, addButton);

      const list = document.createElement('div');
      list.className = 'gdh-sp-manage__list';
      const blocked = document.createElement('div');
      blocked.className = 'gdh-sp-manage__blocked';
      modal.append(head, addRow, list, blocked);
      panel.appendChild(modal);
    }

    try {
      const headerRect = panel
        .querySelector('[data-sentry-component="TrackingHeader"]')
        .getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      modal.style.top = `${Math.max(30, Math.round(headerRect.bottom - panelRect.top) + 4)}px`;
    } catch {
      modal.style.top = '34px';
    }
    renderSpecialManageList(modal);
    renderBlockedTokenList(modal);
  }

  function renderBlockedTokenList(modal) {
    const box = modal.querySelector('.gdh-sp-manage__blocked');
    if (!box) return;
    const key = JSON.stringify(getBlockedTokens().map((x) => `${x.address}|${x.symbol || ''}`));
    if (box.dataset.gdhBlockedKey === key) return;
    box.dataset.gdhBlockedKey = key;
    box.replaceChildren();

    const head = document.createElement('div');
    head.className = 'gdh-sp-manage__subhead';
    const list = getBlockedTokens();
    head.textContent = `Tokens blocked in tracking (${list.length})`;
    box.appendChild(head);

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-sp-manage__empty';
      empty.textContent = 'No tokens are blocked. Hover over a tracking card and select 🚫 beside the token name.';
      box.appendChild(empty);
      return;
    }

    for (const item of list) {
      const row = document.createElement('div');
      row.className = 'gdh-sp-manage__brow';
      const name = document.createElement('span');
      name.className = 'gdh-sp-manage__bname';
      name.textContent = item.symbol || '(Unknown token)';
      const addr = document.createElement('span');
      addr.className = 'gdh-sp-manage__baddr';
      addr.textContent = `${item.address.slice(0, 6)}…${item.address.slice(-4)}`;
      addr.title = item.address;
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'gdh-sp-manage__undo';
      undo.textContent = 'Restore';
      undo.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleBlockedToken(item.address, item.symbol);
        delete box.dataset.gdhBlockedKey;
        renderBlockedTokenList(modal);
      });
      row.append(name, addr, undo);
      box.appendChild(row);
    }
  }

  function renderSpecialManageList(modal) {
    const entries = specialEntries();
    const key = JSON.stringify(entries);
    if (modal.dataset.gdhSpKey === key) return;
    modal.dataset.gdhSpKey = key;
    const title = modal.querySelector('.gdh-sp-manage__title');
    if (title) title.textContent = `Special watch · ${entries.length}`;
    const list = modal.querySelector('.gdh-sp-manage__list');
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-sp-manage__empty';
      empty.textContent = 'No wallets are on special watch';
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'gdh-sp-manage__row';

      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'gdh-sp-manage__swatch';
      applySwatchColor(swatch, entry.color);
      swatch.title = 'Choose highlight color / pin';
      swatch.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openColorPalette(entry.address, swatch.getBoundingClientRect());
      });

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'gdh-sp-manage__pin';
      pin.textContent = '📌';
      pin.classList.toggle('is-on', entry.pin);
      pin.title = entry.pin ? 'Pinned: new activity stays on top for 10 seconds' : 'Not pinned';
      pin.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setSpecialWalletPin(entry.address, !entry.pin);
      });

      const name = document.createElement('span');
      name.className = 'gdh-sp-manage__name';
      name.textContent = entry.label || '(No note)';
      const addr = document.createElement('span');
      addr.className = 'gdh-sp-manage__addr';
      addr.textContent = `${entry.address.slice(0, 6)}…${entry.address.slice(-4)}`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'gdh-sp-manage__remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSpecialWallet(entry.address, entry.label);
      });

      row.append(swatch, pin, name, addr, remove);
      list.appendChild(row);
    }
  }

  const SPECIAL_PIN_MS = 10000;
  const SPECIAL_PIN_MAX = 3;
  const SPECIAL_PIN_SEEN_MAX = 400;
  const specialPinSeen = new Set();
  let specialPinBaselineDone = false;
  let specialPinStrip = null;

  function hasPinnedWallets() {
    for (const meta of specialWalletMap.values()) if (meta.pin) return true;
    return false;
  }

  function trackerCardSignature(card, address) {
    const action = findCardActionContainer(card);
    const actionText = action
      ? [...action.children].filter((el) => el.tagName === 'SPAN').map((el) => (el.textContent || '').trim()).join('')
      : '';
    const amount = (card.querySelector('[data-sentry-component="LiteTrackerAmount"]')?.textContent || '').trim();
    return `${address}|${card.getAttribute('href') || ''}|${actionText}|${amount}`;
  }

  function rememberPinSeen(sig) {
    specialPinSeen.add(sig);
    if (specialPinSeen.size > SPECIAL_PIN_SEEN_MAX) {
      const iterator = specialPinSeen.values();
      for (let extra = specialPinSeen.size - SPECIAL_PIN_SEEN_MAX; extra > 0; extra -= 1) {
        specialPinSeen.delete(iterator.next().value);
      }
    }
  }

  function ensurePinStrip(panel) {
    if (specialPinStrip && specialPinStrip.isConnected) return specialPinStrip;
    specialPinStrip = document.createElement('div');
    specialPinStrip.className = 'gdh-pin-strip';
    panel.classList.add('gdh-callout-panel-host');
    panel.appendChild(specialPinStrip);
    return specialPinStrip;
  }

  function pinTrackerCard(card, panel) {
    const strip = ensurePinStrip(panel);
    try {
      const body = panel.querySelector('[data-sentry-component="TrackingBody"]');
      const panelRect = panel.getBoundingClientRect();
      const bodyRect = (body || panel).getBoundingClientRect();
      strip.style.top = `${Math.max(0, Math.round(bodyRect.top - panelRect.top))}px`;
    } catch {
      strip.style.top = '60px';
    }
    while (strip.children.length >= SPECIAL_PIN_MAX) strip.lastElementChild.remove();

    const item = document.createElement('div');
    item.className = 'gdh-pin-item';
    const clone = card.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('.gdh-star-button, .gdh-color-button').forEach((n) => n.remove());
    const badge = document.createElement('span');
    badge.className = 'gdh-pin-item__badge';
    badge.textContent = '📌';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-pin-item__close';
    close.textContent = '×';
    item.append(badge, clone, close);

    const href = card.getAttribute('href') || '';
    const dismiss = () => {
      item.remove();
      if (specialPinStrip && !specialPinStrip.children.length) {
        specialPinStrip.remove();
        specialPinStrip = null;
      }
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    item.addEventListener('click', () => {
      dismiss();
      if (card.isConnected) card.click();
      else if (href) gdhSpaNavigate(href);
    });
    strip.prepend(item);
    window.setTimeout(dismiss, SPECIAL_PIN_MS);
  }

  function scanPinnedPush() {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    if (!(panel instanceof HTMLElement)) return;
    const cards = [...panel.querySelectorAll(TRACKER_ITEM_SELECTOR)];
    if (!cards.length) return;

    if (!specialPinBaselineDone) {
      cards.forEach((card) => {
        const address = extractRowWalletAddress(card);
        if (address) rememberPinSeen(trackerCardSignature(card, address));
      });
      specialPinBaselineDone = true;
      return;
    }

    const pinnedActive = hasPinnedWallets();
    cards.forEach((card) => {
      const address = extractRowWalletAddress(card);
      if (!address) return;
      const sig = trackerCardSignature(card, address);
      if (specialPinSeen.has(sig)) return;
      rememberPinSeen(sig);
      if (pinnedActive && specialWalletMap.get(address)?.pin === true) {
        pinTrackerCard(card, panel);
      }
    });
  }

  const FRONTRUN_LIGHTNING_SELECTOR =
    '[data-frontrun-portal="instant-trade"], [data-frontrun-portal="instant-trade-tooltip"]';
  const FRONTRUN_HIDE_PROPS = [
    ['display', 'none'],
    ['visibility', 'hidden'],
    ['width', '0px'],
    ['height', '0px'],
    ['min-width', '0px'],
    ['min-height', '0px'],
    ['margin', '0px'],
    ['padding', '0px'],
    ['overflow', 'hidden'],
    ['pointer-events', 'none'],
  ];

  function hideFrontrunHost(host) {
    if (host.dataset.gdhHiddenLightning === '1') return;
    host.dataset.gdhHiddenLightning = '1';
    FRONTRUN_HIDE_PROPS.forEach(([prop, value]) => {
      host.style.setProperty(prop, value, 'important');
    });
  }

  function restoreFrontrunHost(host) {
    FRONTRUN_HIDE_PROPS.forEach(([prop]) => host.style.removeProperty(prop));
    delete host.dataset.gdhHiddenLightning;
  }

  const REMIND_TOAST_SELECTOR = '[data-sentry-component="RemindToast"]';
  const REMIND_CARD_MS = 15000;
  const REMIND_CARD_MAX = 3;
  const NOTIFICATION_HISTORY_KEY = 'notificationHistoryV1';
  const NOTIFICATION_HISTORY_READ_AT_KEY = 'notificationHistoryReadAtV1';
  let remindContainer = null;
  let notificationHistory = [];
  let notificationHistoryReadAt = 0;
  let notificationPanelOpen = false;
  let notificationPanelEl = null;

  function recordNotificationHistory(info) {
    try {
      chrome.runtime.sendMessage({
        type: 'notification-history-add',
        payload: {
          tag: info.tagText || (info.dir === 'down' ? 'Price drop alert' : 'Price alert'),
          symbol: info.symbol || 'Position token',
          label: info.label || '',
          value: info.value || String(info.raw || '').slice(0, 40),
          bell: info.bell || '🔔',
          dir: info.dir || '',
          href: info.href || '',
        },
      }, () => void chrome.runtime.lastError);
    } catch {
    }
  }

  function ensureRemindContainer() {
    if (remindContainer && document.contains(remindContainer)) return remindContainer;
    remindContainer = document.createElement('div');
    remindContainer.className = 'gdh-remind-container';
    document.body.appendChild(remindContainer);
    return remindContainer;
  }

  function remindInfoFromToast(node) {
    const link = node.matches('a[href]')
      ? node
      : node.querySelector('a[href]') || node.closest('a[href]');
    const href = link?.getAttribute('href') || '';
    let dir = '';
    if (node.querySelector('.text-increase-100')) dir = 'up';
    else if (node.querySelector('.text-decrease-100')) dir = 'down';

    const texts = [...node.querySelectorAll('*')]
      .filter((el) => el.children.length === 0)
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean);
    const labelIdx = texts.findIndex((t) => /\u4ef7\u683c|\u5e02\u503c|price|mc|market/i.test(t) && t.length <= 8);
    const label = labelIdx >= 0 ? texts[labelIdx] : '';
    const value = labelIdx >= 0
      ? (texts.slice(labelIdx + 1).find((t) => /[\d$]/.test(t)) || '')
      : (texts.find((t) => /^[$≈]/.test(t)) || '');
    const symbol = texts.find((t) => t && t !== label && t !== value && t.length <= 24) || '';
    return { href, dir, label, value, symbol, raw: (node.textContent || '').replace(/\s+/g, ' ').trim() };
  }

  function showRemindCard(info) {
    const container = ensureRemindContainer();
    while (container.children.length >= REMIND_CARD_MAX) container.firstElementChild.remove();

    const card = document.createElement('div');
    card.className = 'gdh-remind-card';
    if (info.dir) card.dataset.gdhDir = info.dir;

    const head = document.createElement('div');
    head.className = 'gdh-remind-card__head';
    const bell = document.createElement('span');
    bell.className = 'gdh-remind-card__bell';
    bell.textContent = info.bell || '🔔';
    const tag = document.createElement('span');
    tag.className = 'gdh-remind-card__tag';
    tag.textContent = info.tagText || (info.dir === 'down' ? 'Price drop alert' : 'Price alert');
    head.append(bell, tag);
    if (info.dir) {
      const arrow = document.createElement('span');
      arrow.className = 'gdh-remind-card__arrow';
      arrow.textContent = info.dir === 'down' ? '↓' : '↑';
      head.appendChild(arrow);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-remind-card__close';
    close.textContent = '×';
    close.title = 'Close';
    head.appendChild(close);
    card.appendChild(head);

    const symbolEl = document.createElement('div');
    symbolEl.className = 'gdh-remind-card__symbol';
    symbolEl.textContent = info.symbol || 'Position token';
    card.appendChild(symbolEl);

    const valueRow = document.createElement('div');
    valueRow.className = 'gdh-remind-card__value';
    if (info.label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'gdh-remind-card__label';
      labelEl.textContent = info.label;
      valueRow.appendChild(labelEl);
    }
    const numEl = document.createElement('strong');
    numEl.className = 'gdh-remind-card__num';
    numEl.textContent = info.value || info.raw.slice(0, 40);
    valueRow.appendChild(numEl);
    card.appendChild(valueRow);

    const foot = document.createElement('div');
    foot.className = 'gdh-remind-card__foot';
    foot.textContent = 'Open token page →';
    card.appendChild(foot);

    let timer = 0;
    const dismiss = () => {
      window.clearTimeout(timer);
      card.remove();
      if (remindContainer && !remindContainer.children.length) {
        remindContainer.remove();
        remindContainer = null;
      }
    };
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(dismiss, info.kind === 'position-surge' ? 5000 : REMIND_CARD_MS);
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    // Surge alerts have a fixed five-second lifetime, even under a stationary
    // pointer. Other native reminders keep their existing hover pause behavior.
    if (info.kind !== 'position-surge') {
      card.addEventListener('mouseenter', () => window.clearTimeout(timer));
      card.addEventListener('mouseleave', arm);
    }
    card.addEventListener('click', () => {
      dismiss();
      if (info.href) gdhSpaNavigate(info.href);
    });
    arm();
    container.appendChild(card);
    recordNotificationHistory(info);
  }

  const FOMO_NETWORK_ID = { bsc: 56, eth: 1, base: 8453, sol: 1399811149, robinhood: 4663, monad: 143 };
  const FOMO_CHAIN_SLUG = { bsc: 'bnb', eth: 'eth', base: 'base', sol: 'sol', robinhood: 'robinhood', monad: 'monad' };
  const FOMO_REFRESH_MS = 30000;
  let fomoPanelEl = null;
  let fomoTab = 'thesis';
  let fomoLoadedKey = '';
  let fomoErrKey = '';
  let fomoErrAt = 0;
  const FOMO_ERR_COOLDOWN = 20000;
  let fomoLastItems = [];
  let fomoTimer = 0;
  let fomoLoadGeneration = 0;
  let fomoLoadInflight = null;

  // Panel trust metadata is deliberately separate from trade/holder payloads.
  let fomoUi = { scope: '', meta: null, error: null, retryAt: 0, followingOnly: false };
  let fomoUiRetryTimer = 0;
  let fomoUiAuthGeneration = 0;

  function fomoUiTimestamp(value) {
    const number = Number(value);
    const time = Number.isFinite(number) && number > 0
      ? (number < 1e12 ? number * 1000 : number) : Date.parse(value || '');
    return Number.isFinite(time) && time > 0 && time < 8640000000000000 ? time : 0;
  }

  function fomoUiMeta(response) {
    const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    const sources = ['holder-history', 'token-feed', 'holders', 'thesis'];
    return {
      source: sources.includes(response?.source) ? response.source : 'unknown',
      fetchedAt: fomoUiTimestamp(response?.fetchedAt),
      updatedAt: fomoUiTimestamp(response?.updatedAt),
      partial: response?.partial === true,
      stale: response?.stale === true,
      followingKnown: response?.followingKnown === true,
      coverage: {
        attempted: count(response?.coverage?.attempted), succeeded: count(response?.coverage?.succeeded),
        limit: count(response?.coverage?.limit), truncated: response?.coverage?.truncated === true,
      },
    };
  }

  function fomoUiError(response) {
    const known = ['no-token', 'expired', 'blocked', 'network', 'runtime', 'rate-limited', 'auth-changed'];
    const status = typeof response?.status === 'number' && response.status >= 100 && response.status <= 599 ? Math.floor(response.status) : null;
    const reason = status === 429 ? 'rate-limited' : status === 401 ? 'expired'
      : known.includes(response?.reason) ? response.reason : 'unavailable';
    return { reason, status, retryAt: fomoUiTimestamp(response?.retryAt) || (reason === 'rate-limited' ? Date.now() + 30000 : 0) };
  }

  function fomoUiErrorText(error) {
    if (error.reason === 'no-token' || error.reason === 'expired' || error.reason === 'auth-changed') return 'Reconnect your FOMO session.';
    if (error.reason === 'rate-limited') return `Rate limited (429). Retry after ${new Date(error.retryAt).toLocaleTimeString()}.`;
    if (error.reason === 'runtime') return 'Extension connection unavailable. Retry, or reload this page if the extension was updated.';
    if (error.reason === 'blocked') return 'Request blocked. Wait briefly, then retry.';
    if (error.reason === 'network') return 'Network unavailable. Check your connection, then retry.';
    return 'Refresh failed. Please retry.';
  }

  function fomoUiTradeTime(item) {
    return fomoUiTimestamp(item?.createdAt || item?.timestamp || item?.createdTime || item?.time || item?.ts);
  }

  function fomoUiVisibleItems(items, tab, followingOnly = fomoUi.followingOnly, followingKnown = fomoUi.meta?.followingKnown) {
    let visible = Array.isArray(items) ? items.slice() : [];
    if (followingOnly && tab !== 'thesis') visible = followingKnown ? visible.filter((item) => item?.followed === true) : [];
    if (tab === 'swaps') visible.sort((a, b) => fomoUiTradeTime(b) - fomoUiTradeTime(a));
    return visible;
  }

  function fomoUiActivity(item) {
    const side = String(item?.side || item?.tradeSide || item?.tradeType || item?.type || item?.body?.type || item?.action || '').toLowerCase();
    const action = String(item?.positionAction || item?.positionType || item?.tradeAction || item?.activityLabel || '').toLowerCase();
    if (/(^|[ _-])(buy|bought)($|[ _-])/.test(side) || item?.isBuy === true) return 'Buy';
    if (/(^|[ _-])(sell|sold)($|[ _-])/.test(side) || item?.isSell === true || item?.isBuy === false) {
      if (/^(all|close|closed|exit|exited|full)$/.test(action) || item?.isFullExit === true) return 'Exit';
      if (/^(partial|trim|trimmed|reduce|reduced)$/.test(action)) return 'Trim';
      return 'Sell'; // An ordinary sell is not evidence of a trim or full exit.
    }
    return '';
  }

  function fomoUiPosition(item) {
    const action = String(item?.positionAction || item?.positionType || item?.tradeAction || item?.activityLabel || '').toLowerCase();
    if (/^(first|open|opened|new)$/.test(action) || item?.isFirstTrade === true) return 'First';
    if (/^(more|add|added|increase|increased)$/.test(action)) return 'More';
    if (/^(partial|trim|trimmed|reduce|reduced)$/.test(action)) return 'Partial';
    if (/^(all|close|closed|exit|exited|full)$/.test(action) || item?.isFullExit === true) return 'All';
    return '';
  }

  function fomoUiDiagnostics() {
    let version = 'unknown';
    try {
      const value = chrome.runtime.getManifest().version;
      if (/^\d+(\.\d+){1,3}$/.test(value)) version = value;
    } catch { /* Invalidated extension: diagnostics still work. */ }
    const meta = fomoUi.meta;
    const chain = fomoUiRoute()?.chain;
    return {
      version, source: meta?.source || 'unknown',
      timestamps: { fetchedAt: meta?.fetchedAt || null, updatedAt: meta?.updatedAt || null, retryAt: fomoUi.retryAt || null },
      status: fomoUi.error?.reason || (meta?.stale ? 'stale' : meta ? 'ok' : 'loading'),
      coverage: meta ? { ...meta.coverage, partial: meta.partial, holderHistoryLimited: meta.source === 'holder-history', followingKnown: meta.followingKnown } : null,
      tab: ['holders', 'swaps', 'thesis'].includes(fomoUiTab()) ? fomoUiTab() : 'unknown',
      chain: ['bsc', 'eth', 'base', 'sol', 'robinhood', 'monad'].includes(chain) ? chain : 'unknown',
    };
  }

  function resetFomoUi(resetFollowing = false) {
    fomoUi = { scope: '', meta: null, error: null, retryAt: 0, followingOnly: resetFollowing ? false : fomoUi.followingOnly };
    clearTimeout(fomoUiRetryTimer);
    fomoUiClearData();
    fomoUiPanel()?.querySelector('.gdh-fomo-ui')?.replaceChildren();
    fomoUiPanel()?.querySelector('[data-fomo-list]')?.replaceChildren();
  }

  function renderFomoUiItems() {
    const list = fomoUiPanel()?.querySelector('[data-fomo-list]');
    if (!list || !fomoUi.meta) return;
    const tab = fomoUiTab();
    const items = fomoUiVisibleItems(fomoUiItems(), tab);
    if (!items.length && fomoUi.followingOnly && tab !== 'thesis') {
      const empty = document.createElement('div');
      empty.className = 'gdh-fomo-ui__empty';
      empty.textContent = fomoUi.meta.followingKnown
        ? (tab === 'holders' ? 'No followed current holders in this coverage.' : 'No followed trades in this coverage.')
        : 'Following lookup unavailable. Retry or turn off Following only to view all loaded items.';
      list.replaceChildren(empty);
    } else fomoUiRenderItems(list, items, tab);
  }

  function buildFomoUi() {
    const box = document.createElement('div');
    box.className = 'gdh-fomo-ui';
    box.setAttribute('aria-label', 'FOMO source, coverage and recovery');
    return box;
  }

  function renderFomoUi() {
    const box = fomoUiPanel()?.querySelector('.gdh-fomo-ui');
    if (!box) return;
    box.replaceChildren();
    clearTimeout(fomoUiRetryTimer);
    const meta = fomoUi.meta;
    const tab = fomoUiTab();
    const status = document.createElement('div');
    status.className = 'gdh-fomo-ui__status';
    status.setAttribute('role', 'status');
    const source = { 'holder-history': 'Reconstructed from holder histories', 'token-feed': 'Token feed', holders: 'Current holdings', thesis: 'Narratives' };
    const time = meta?.fetchedAt ? new Date(meta.fetchedAt).toLocaleTimeString() : 'unknown';
    status.textContent = meta ? `${source[meta.source] || 'Source unavailable'} · Last successful refresh: ${time}${meta.stale || fomoUi.error ? ' · Stale' : ''}` : 'No successful refresh yet';
    box.appendChild(status);
    const notes = [];
    if (meta?.source === 'holder-history') notes.push('Limited history from current holders, not all token trades. Fully exited users may be absent.');
    if (meta?.partial || meta?.coverage.truncated) notes.push('Partial / incomplete coverage.');
    if (meta?.coverage.attempted !== null && meta?.coverage.attempted > 0) notes.push(`${meta.coverage.succeeded ?? '?'} / ${meta.coverage.attempted} sources loaded${meta.coverage.limit !== null ? ` (limit ${meta.coverage.limit})` : ''}.`);
    if (meta && tab !== 'thesis' && !meta.followingKnown) notes.push('Following lookup unavailable; follow status is unknown.');
    if (tab === 'swaps' && meta?.source !== 'holder-history') notes.push('Trade history, not current holdings.');
    if (fomoUi.error) notes.push(fomoUiErrorText(fomoUi.error));
    if (notes.length) {
      const note = document.createElement('div');
      note.className = 'gdh-fomo-ui__note';
      note.textContent = notes.join(' ');
      box.appendChild(note);
    }
    if (meta?.followingKnown && tab === 'swaps') {
      const latest = fomoUiVisibleItems(fomoUiItems(), 'swaps', true, true).find((item) => fomoUiActivity(item));
      const activity = document.createElement('div');
      activity.className = 'gdh-fomo-ui__activity';
      const at = latest && fomoUiTradeTime(latest);
      activity.textContent = latest ? `Latest followed activity in coverage: ${fomoUiName(latest)} · ${fomoUiActivity(latest)}${at ? ` · ${new Date(at).toLocaleString()}` : ''}` : 'No followed trade activity in this coverage.';
      box.appendChild(activity);
    }
    const controls = document.createElement('div');
    controls.className = 'gdh-fomo-ui__controls';
    if (tab !== 'thesis') {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = '★ Following only';
      toggle.setAttribute('aria-pressed', String(fomoUi.followingOnly));
      toggle.addEventListener('click', () => {
        fomoUi.followingOnly = !fomoUi.followingOnly;
        toggle.setAttribute('aria-pressed', String(fomoUi.followingOnly));
        renderFomoUiItems();
      });
      controls.appendChild(toggle);
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.setAttribute('aria-label', 'Retry FOMO refresh');
    const updateRetry = () => {
      if (!retry.isConnected) return;
      const wait = Math.max(0, Math.ceil((fomoUi.retryAt - Date.now()) / 1000));
      retry.disabled = wait > 0;
      retry.textContent = wait ? `Retry in ${wait}s` : 'Retry';
      if (wait) fomoUiRetryTimer = setTimeout(updateRetry, 1000);
    };
    retry.textContent = 'Retry';
    retry.disabled = fomoUi.retryAt > Date.now();
    retry.addEventListener('click', () => { if (Date.now() >= fomoUi.retryAt) fomoUiLoad(true); });
    controls.appendChild(retry);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy diagnostics';
    copy.title = 'Copy version, source, timestamps, status, coverage, tab and chain only';
    copy.addEventListener('click', async () => {
      const generation = fomoUiAuthGeneration;
      try {
        await navigator.clipboard.writeText(JSON.stringify(fomoUiDiagnostics(), null, 2));
        if (generation === fomoUiAuthGeneration && copy.isConnected) copy.textContent = 'Copied';
      } catch {
        if (generation === fomoUiAuthGeneration && copy.isConnected) copy.textContent = 'Copy unavailable';
      }
    });
    controls.appendChild(copy);
    box.appendChild(controls);
    queueMicrotask(updateRetry);
  }

  // A single notice outside the virtual rows never changes their offsets.
  function renderFomoFollowedGap(response) {
    let notice = document.querySelector('.gdh-fomo-feed-gap');
    const passive = response?.mode === 'passive';
    const gap = passive || response?.coverageGap === true || response?.stale === true;
    if (!gap) { notice?.remove(); return; }
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'gdh-fomo-feed-gap';
      notice.setAttribute('role', 'status');
      notice.tabIndex = 0;
      document.body.appendChild(notice);
    }
    const passiveLabels = {
      'waiting-for-fomo-tab': 'Following feed: waiting for FOMO tab',
      'waiting-for-account': 'Following feed: sign in on FOMO',
      'waiting-for-following': 'Following feed: waiting for native following list',
      'waiting-for-activity': 'Following feed: open FOMO Alerts',
      connected: response?.coverageGap ? 'Following feed: native tab connected · partial coverage' : 'Following feed: receiving from FOMO tab',
      disconnected: 'Following feed: FOMO tab disconnected',
    };
    const text = passive ? (passiveLabels[response.passiveStatus] || 'Following feed: waiting for FOMO tab')
      : response?.coverageGap === true ? 'Following feed: coverage gap' : 'Following feed: stale';
    if (notice.textContent !== text) notice.textContent = text;
    notice.title = passive
      ? 'Passive mode: keep a signed-in FOMO Alerts tab open. This tracker observes native activity only; it does not poll FOMO or open a separate connection. Missing activity is not automatically fetched.'
      : 'Bounded polling may omit activity. This feed is not a complete trade history.';
  }

  function fomoUiPanel() { return fomoPanelEl; }
  function fomoUiRoute() { return currentTokenRoute(); }
  function fomoUiTab() { return fomoTab; }
  function fomoUiItems() { return fomoLastItems; }
  function fomoUiName(item) { return holderName(item); }
  function fomoUiRenderItems(list, items, tab) { renderFomoItems(list, items, tab); }
  function fomoUiLoad(force) { return loadFomoData(force); }
  function fomoUiClearData() {
    fomoLoadGeneration += 1;
    fomoLoadInflight = null;
    fomoLoadedKey = ''; fomoErrKey = ''; fomoLastItems = [];
    fomoStats = { key: '', holders: null, thesisCount: null, supply: 0 };
    fomoPnlObserver?.disconnect(); fomoPnlQueue = [];
    renderFomoStats();
  }

  function currentTokenRoute() {
    const m = location.pathname.match(/^\/([a-z0-9]+)\/token\/([A-Za-z0-9]+)/);
    if (!m) return null;
    const chain = m[1];
    if (!(chain in FOMO_NETWORK_ID)) return null;
    return { chain, address: m[2], networkId: FOMO_NETWORK_ID[chain] };
  }

  function normalizedNotificationHistory(value) {
    return (Array.isArray(value) ? value : [])
      .filter((item) => item && typeof item === 'object' && Number(item.at) > 0)
      .slice(0, 100);
  }

  function notificationUnreadCount() {
    return notificationHistory.filter((item) => Number(item.at) > notificationHistoryReadAt).length;
  }

  function notificationTime(value) {
    const date = new Date(Number(value));
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  }

  function renderNotificationPanel() {
    if (!notificationPanelEl) return;
    const count = notificationPanelEl.querySelector('.gdh-notification__count');
    if (count) count.textContent = `Latest ${notificationHistory.length}/100`;
    const list = notificationPanelEl.querySelector('.gdh-notification__list');
    if (!list) return;
    list.replaceChildren();
    if (!notificationHistory.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-notification__empty';
      empty.textContent = 'No notification history';
      list.appendChild(empty);
      return;
    }
    notificationHistory.forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `gdh-notification__item${item.dir === 'up' ? ' is-up' : item.dir === 'down' ? ' is-down' : ''}`;
      const head = document.createElement('span');
      head.className = 'gdh-notification__item-head';
      const title = document.createElement('strong');
      title.className = 'gdh-notification__item-title';
      title.textContent = `${item.bell || '🔔'} ${item.tag || 'Alert'} · ${item.symbol || 'Position token'}`;
      const time = document.createElement('time');
      time.className = 'gdh-notification__item-time';
      time.textContent = notificationTime(item.at);
      head.append(title, time);
      const value = document.createElement('span');
      value.className = 'gdh-notification__item-value';
      value.textContent = [item.label, item.value].filter(Boolean).join('  ') || '—';
      row.append(head, value);
      if (item.href) {
        row.title = 'Open token page';
        row.addEventListener('click', () => {
          notificationPanelOpen = false;
          notificationPanelEl?.remove();
          notificationPanelEl = null;
          gdhSpaNavigate(item.href);
        });
      } else {
        row.disabled = true;
      }
      list.appendChild(row);
    });
  }

  function buildNotificationPanel() {
    const panel = document.createElement('section');
    panel.className = 'gdh-notification-panel';
    const head = document.createElement('div');
    head.className = 'gdh-notification__bar';
    const title = document.createElement('strong');
    title.className = 'gdh-notification__title';
    title.textContent = 'Notification history';
    const count = document.createElement('span');
    count.className = 'gdh-notification__count';
    count.textContent = `Latest ${notificationHistory.length}/100`;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'gdh-notification__clear';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      if (!window.confirm('Clear all notification history?')) return;
      try {
        chrome.runtime.sendMessage({ type: 'notification-history-clear' }, () => void chrome.runtime.lastError);
      } catch {
      }
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-notification__close';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', () => {
      notificationPanelOpen = false;
      panel.remove();
      notificationPanelEl = null;
      scheduleScan();
    });
    head.append(title, count, clear, close);
    const list = document.createElement('div');
    list.className = 'gdh-notification__list';
    panel.append(head, list);
    return panel;
  }

  function markNotificationHistoryRead() {
    try {
      chrome.runtime.sendMessage({ type: 'notification-history-read' }, () => void chrome.runtime.lastError);
    } catch {
    }
  }

  function nativeLauncherAnchor(selector) {
    if (location.hostname !== 'gmgn.ai') return null;
    return [...document.querySelectorAll(selector)].find(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }) || null;
  }

  function ensureNotificationLauncher() {
    let btn = document.querySelector('.gdh-notification-launcher');
    const anchor = nativeLauncherAnchor('nav[aria-label="Main navigation"]');
    if (!anchor) {
      btn?.remove();
      notificationPanelEl?.remove();
      notificationPanelEl = null;
      notificationPanelOpen = false;
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gdh-notification-launcher';
      btn.textContent = '🔔';
      btn.title = 'View notification history';
      const badge = document.createElement('span');
      badge.className = 'gdh-notification-launcher__badge';
      btn.appendChild(badge);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        notificationPanelOpen = !notificationPanelOpen;
        if (notificationPanelOpen) {
          if (settings.fomoPanelOpen === true) setFomoOpen(false);
          markNotificationHistoryRead();
        }
        scheduleScan();
      });
    }
    if (btn.parentElement !== anchor || anchor.lastElementChild !== btn) anchor.appendChild(btn);
    btn.setAttribute('aria-label', 'Notification history');
    btn.setAttribute('aria-expanded', String(notificationPanelOpen));
    btn.classList.toggle('is-active', notificationPanelOpen);
    const badge = btn.querySelector('.gdh-notification-launcher__badge');
    const unread = notificationUnreadCount();
    if (badge) {
      badge.textContent = unread > 99 ? '99+' : String(unread || '');
      badge.hidden = unread === 0;
    }
    if (!notificationPanelOpen) {
      notificationPanelEl?.remove();
      notificationPanelEl = null;
      return;
    }
    if (!notificationPanelEl || !document.contains(notificationPanelEl)) {
      notificationPanelEl = buildNotificationPanel();
      document.body.appendChild(notificationPanelEl);
      renderNotificationPanel();
    }
  }

  function fomoAgo(value) {
    const t = Number(new Date(value));
    if (!Number.isFinite(t) || t <= 0) return '';
    return formatRelTime(t);
  }

  function fomoUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '';
    const abs = Math.abs(n);
    const s = abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M`
      : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}K`
        : abs.toFixed(abs >= 10 ? 0 : 2);
    return `${n < 0 ? '-' : ''}$${s}`;
  }

  function fomoPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  }

  function fomoDur(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return '';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  }

  function pick(obj, keys) {
    for (const k of keys) {
      const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function deepPick(obj, keyRe, kind, depth = 0, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || depth > 3 || seen.has(obj)) return undefined;
    seen.add(obj);
    const ok = (v) => {
      if (kind === 'number') {
        const n = Number(v);
        return Number.isFinite(n) && v !== '' && v !== true && v !== false ? n : undefined;
      }
      if (kind === 'url') {
        return typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined;
      }
      const s = typeof v === 'string' ? v.trim() : '';
      return s && s.length <= 200 && !/^https?:\/\//.test(s) ? s : undefined;
    };
    for (const [k, v] of Object.entries(obj)) {
      if (!keyRe.test(k)) continue;
      const val = ok(v);
      if (val !== undefined) return val;
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const hit = deepPick(v, keyRe, kind, depth + 1, seen);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }

  function fomoUser(item) {
    return (item && typeof item.user === 'object' && item.user) || item || {};
  }

  function fomoActivitySide(raw) {
    const direct = String(raw?.side || raw?.tradeSide || raw?.tradeType || raw?.type
      || raw?.body?.type || raw?.action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (/(^|_)(buy|bought)(_|$)/.test(direct) || raw?.isBuy === true) return 'buy';
    if (/(^|_)(sell|sold)(_|$)/.test(direct) || raw?.isSell === true || raw?.isBuy === false) return 'sell';
    if (/(^|_)thesis(_|$)/.test(direct)) return 'thesis';
    return '';
  }

  function fomoActivityPosition(raw, side = fomoActivitySide(raw)) {
    const explicit = String(raw?.positionAction || raw?.positionType || raw?.tradeAction
      || raw?.activityLabel || raw?.label || raw?.action || '').trim().toLowerCase();
    if (/^(first|open|opened|new)$/.test(explicit)) return 'First';
    if (/^(more|add|added|increase|increased)$/.test(explicit)) return 'More';
    if (/^(partial|trim|trimmed|reduce|reduced)$/.test(explicit)) return 'Partial';
    if (/^(all|close|closed|exit|exited|full)$/.test(explicit)) return 'All';
    if (side === 'thesis') return 'Thesis';
    const eventAt = Date.parse(raw?.createdAt || raw?.timestamp || raw?.time || '') || Number(raw?.ts) || 0;
    const trade = raw?.authorTrade && typeof raw.authorTrade === 'object' ? raw.authorTrade : {};
    const openedAt = Date.parse(trade.openedAt || raw?.openedAt || '') || 0;
    const closedAt = Date.parse(trade.closedAt || raw?.closedAt || '') || 0;
    const nearEvent = (at) => !!(at && eventAt && Math.abs(at - eventAt) <= 60000);
    if (side === 'buy') return raw?.isFirstTrade === true || nearEvent(openedAt) ? 'First' : 'More';
    if (side === 'sell') {
      return raw?.isFullExit === true || raw?.isClosed === true || nearEvent(closedAt) ? 'All' : 'Partial';
    }
    return trade?.id || trade?.openedAt || trade?.usdValue ? 'Position' : '';
  }

  function normalizeFomoPopupTrade(raw) {
    if (!raw || typeof raw !== 'object') return { side: '', position: '' };
    const side = fomoActivitySide(raw);
    return { ...raw, side, position: fomoUiPosition(raw) };
  }

  function holderName(item) {
    const u = fomoUser(item);
    const handle = typeof u.userHandle === 'string' ? u.userHandle.trim().replace(/^@/, '') : '';
    const display = typeof u.displayName === 'string' ? u.displayName.trim() : '';
    return handle || display
      || deepPick(item, /(username|handle|displayname|nickname)/i, 'string')
      || 'Anonymous';
  }

  function holderAvatar(item) {
    const u = fomoUser(item);
    const direct = u.profilePictureLink || item?.profilePictureLink;
    if (typeof direct === 'string' && /^https?:\/\//.test(direct)) return direct;
    return deepPick(item, /(profilepic|profileimage|avatar|picture|image|photo)/i, 'url');
  }

  const FOMO_BOARD = JSON.parse('{"change":"a1s21kW","frankdegods":"a2s7k","_logjam":"a3s165","chadbchilln":"a4","lesabre":"a5s47","remusofmars":"a6s126","collectible":"a7s102","dystopiansniper":"a8s40","game_for_one":"a9s164","breakingbad":"a10s39","notepad_h":"a11s27k","guavaguy2001":"a12","nfd":"a13","atom_xyz":"a14s38","thebtcgoose":"a15s19k","c1phervoyager":"a16s138","quakerrz":"a17","resellcalendar":"a18s54","vein":"a19s58","nosanityxbt":"a20s9k","billyballs72":"a21","notwashed":"a22s108","0xleo":"a23s17k","xxxfomoxxx":"a24s56","letsdance":"a25","midjetv2":"m13","letsfkingoooo":"m15","hihi33":"m9","runitbackghost":"m39s46","thevilla":"m43","jimbotrading":"m16","avgjoescrypto":"m8","juicycooks":"m18","metaversejoji":"w9s209","surveillor":"m7s193","smol_intern":"m24s188","rafaelonchain":"w14","jotagezin":"m2s41","sandmann":"w16","onmycheck":"w18","mevzoid":"w19s34D","alphacrew23":"w20","aoulss":"w21","letmehelpurmind":"m34","blackgoblin":"w23","traderpow":"w24s163","xventures":"w25","iceslayerman":"w26","xbtpika":"w27","clavtard":"m40","xet":"w29","tendersalt":"w30","gganon44":"w31","warrennakamotox":"m14","maverickdotsol":"w33","openvpp":"w34","kenzo13ro":"w35","trader":"w36s114","ffa888":"w37","jeetergriffin":"w38s271","octoseaa":"w39s6k","0xjiggy":"w40s210","exploit":"w41","moneyman32":"w42","0xdetweiler":"w43s256","0xwives":"w44","crypt0whalex":"w45","eyezenhour":"m31","cryptologykito":"w47","moneymancalls":"w48","just2addicted":"w49","ultimateoldpheasant":"w50","mabon_zsq":"m4","laolu":"m5","dns_err":"m10s287","unnattybrah":"m11","0xuberm":"m12s18k","0x10kliquid":"m17","fathermeme69":"m19","will__price":"m20","hushedlonelybaboon":"m21","cryptogodjohn":"m22","gwei":"m26","staticctrades":"m27","xbrazilzz":"m28s99","iamh3nry":"m29","komorodragon":"m30","fibs":"m32s255","dior100x":"m33","riskit":"m35","hankusun":"m36","riskanonymous":"m37","rtdquant":"m38s214","pxblocito":"m41","jaqs":"m42","randalltrades":"m44","pastlife":"m45","hdegrootvan":"m46","onchainsorcerer":"m47s139","basicexpecteddragon":"m49","wwayfboss":"m50s233","marcellxmarcell":"d6s94","wrld_sol":"d9","0xiamfake":"d13","daumenxyz":"d14s159","astaso1":"d17s121","0xjumpman":"d20","zinceth":"d22s14k","cryptoaeon":"d23","upnext":"d26","dipwheeler":"d27","ineedtowin":"d30","charles_h90":"d31","hp88":"d32","pemp":"d34","goldenchyna":"d41","ckoptimus":"d43","kr_kimkk":"d49","believer12137":"d50","_cr0wbar_":"s1k","spidercrypto0x":"s2k","1947km":"s3k","mystayor":"s4k","nightcore":"s5k","cutie":"s8k","papsio3k1":"s10k","paikcapital":"s11k","_wash3d_":"s12k","wenmoonsolana_":"s13k","onlyz":"s15k","100milly":"s16k","onchainrobber":"s20k","memeinc":"s22k","randomuser123":"s23k","honestregionallungfish":"s24k","0xvantaa":"s25k","thokani":"s26k","careful":"s28k","sized_in":"s29k","kjs16":"s30k","andy":"s31","kingfomo":"s32","nicktesla16":"s33","favel":"s35","flippingprofits":"s36","seyong":"s37","0xforte124":"s42","imim":"s43","moodywsw":"s44","stigstigstig_":"s45","squidward":"s48","eyeamfin":"s49","wealthmaxxer":"s50","seanlippel":"s51","obitouchiha":"s52","_happyk21":"s53","zemirch":"s55","tommy":"s57","kom3thazine":"s59","icemandot":"s60","account":"s61","spiritualscorch":"s62","colby":"s63","pointfarmcap":"s64","sonder_crypto":"s65","theprimegreek":"s66","loopifyyy":"s67","llonchain":"s68","elegantprecisetapir":"s69","igxyffiyofof":"s70","degentodisciple":"s71","mimiardrp":"s72","memeticpower":"s73","hotlneblng":"s74","foreskinnnnn":"s75","real_y22":"s76","0xheme":"s77","0xsneakky":"s78","user_0037":"s79","0xarchitectx0":"s80","kalexbt":"s81","garythegambler":"s82","losteverythingagain":"s83","runecrypto_":"s84","degengigi":"s85","slushie":"s86","adro808":"s87","blitzrun":"s88","mightyegoism":"s89","31337___":"s90","0xkillua_eth":"s91","0x7ama":"s92","spyda":"s93","fullportonly":"s95","jobsnotfinished":"s96","rynzoeth":"s97","parasite_eei":"s98","notanicecat69":"s100","bryptokenneth3":"s101","solswizzle":"s103","rugmeharder":"s104","kekwdjsjnd":"s105","joespina":"s106","mythos":"s107","4pfcoyote":"s109","senzu":"s110","pingucharts":"s111","lucacseth":"s112","horror":"s113","ghostonchain":"s115","samptsd":"s116","hamsa":"s117","guided":"s118","cuttycurryy":"s119","zimmwho":"s120","scalps":"s122","noahknowstrades":"s123","mnds":"s124","bulgugi":"s125","dragossden":"s127","imviriofficial":"s128","notsuavizim":"s129","growingdisabledgerbil":"s130","kidski":"s131","kongkapital":"s132","navalneutralhalibut":"s133","degnsol":"s134","paik_michael":"s135","choppeduncx":"s136","royalbelligerentplatypus":"s137","joeburrow246":"s140","jstacks___":"s141","onchainstudent":"s142","binkieee":"s143W","leftcurvemaxing":"s144","virtualbacon":"s145","halibutcrypto":"s146","graycandol":"s147","crip":"s148","samflintstone":"s149","privateneighbor":"s150","grampsxbt":"s151","77777777777777":"s152","woooooohooooo":"s153","gera_eth":"s154","bobius":"s155","airtightfish":"s156","lacostetn26":"s157","jxck_eth":"s158","ericceth":"s160","mispriced":"s161","kikaka10000":"s162","maximusfab1us":"s166","dumb_ape":"s167","wardsy0x":"s168","winnerx":"s169","x1x2":"s170","maisonghost":"s171","basedbroker":"s172","prewealthy":"s173","aurah":"s174","stinkysasha":"s175","kbz1":"s176","gr3gor14n":"s177","brox":"s178","10xjdog":"s179","rodotfun":"s180","muddy":"s181","thebiglong":"s182","exuro":"s183","shockedjs":"s184","legionyeni":"s185","good":"s186","mistystrictantelope":"s187","_veigarcrypto_xd":"s189","books":"s190","tassolago":"s191","teepanddestroy":"s192","manofwar":"s194","koyla_sol":"s195","takeiteasy":"s196","spicyperuvian_":"s197","t26x":"s198","ferbsol":"s199","tonyovo":"s200","captain_al_80":"s201","stoploss":"s202","hbutspecial":"s203","insentos":"s204","pius":"s205","ohmprovement":"s206","printgod":"s207","cryptojohnnyfap":"s208","deadass":"s211","quanterty":"s212","gnocity_":"s213","px_721":"s215","seikux":"s216","hehe":"s217","nervousfuzzylizard":"s218","cryptodjip":"s219","poorclick":"s220","aaabbbccc":"s221","osideus":"s222","newlowscore677777":"s223","downhorrndously":"s224","________________":"s225","0xforgivable":"s226","quotes":"s227","ocrxa":"s228","patrick33":"s229","vexrex23":"s230","999999999999999":"s231","chimpfone":"s232","katsucurryxbt":"s234","feanor_crypt":"s235","palequietherring":"s236","mino":"s237","scrooge":"s238","bigslime":"s239","toptickcrypto":"s240","xmediumrare":"s241","lay2000lbs":"s242","yogurt_eth":"s243","carlwheezor":"s244","frankneedsabeer":"s245","judee":"s246","charles":"s247","dictator":"s248","devilslayer1802":"s249","hasntpumpedyet":"s250","jikksol":"s251","zackory":"s252","ilillllliliilii":"s253","jlcryptohh":"s254","don999z":"s257","magica_conch":"s258","rebuild":"s259","zoomeroracle":"s260","finalearc":"s261","brrrgrrrz":"s262","lucasw99":"s263","arbiter":"s264","kusanagiyo_00":"s265","bleachsolana":"s266","degensaw":"s267","kobe":"s268","itackld":"s269","6foot4honda":"s270","0xsnibbler":"s272","brazen":"s273","altanxayan":"s274","maxxbiid":"s275","runitback":"s276","krazz":"s277","wizardcat":"s278","mickeymouse":"s279","quinn":"s280","nigayahu":"s281","casino1":"s282","jambalaya":"s283","allidoiswin":"s284","acetto":"s285","heiss_7":"s286","gluttony":"s288","jackson":"s289","theetherista":"s290","wildwilly":"s291","ashegan":"s292","macdegods":"s293","spyzer":"s294","qtags":"s295","shroom_daddy":"s296","paul":"s297","ishowmemecoins":"s298","basedshillbh":"s299","shownuniform08":"s300","zinc":"D","missoralways":"S","logjam":"W","killua":"F","sencrazy":"S","solo":"F","poorgoat🐂🀄️💛🐈":"W","rowdy":"S","rc":"D","solkcrow":"D","0xsun":"S","nobi":"S","lana":"S","smok\\u03bey":"F","frank":"D","pow🧲":"F","rune":"D","ozzy":"F","blknoiz06":"D","unipcs":"W","avast":"D","mr.mystery":"S","\u51b7\u9759\u51b7\u9759\u518d\u51b7\u9759":"S","logan lim":"D"}');
  const FOMO_BOARD_LABEL = { a: 'All time', m: '30d', w: '7d', d: '24h' };
  const FOMO_TIER_ICON = { W: '🐳', D: '🐬', F: '🐟', S: '🦐' };
  const FOMO_TIER_NAME = { W: 'Whale', D: 'Dolphin', F: 'Fish', S: 'Shrimp' };

  function fomoBoardMark(handle) {
    const key = String(handle || '').trim().toLowerCase();
    if (!key) return null;
    const raw = FOMO_BOARD[key];
    if (!raw) return null;
    const board = raw.match(/^([awmd])(\d+)/);
    const smart = raw.match(/s(\d+)/);
    const kol = /k/.test(raw);
    const tier = (raw.match(/[WDFS]/) || [])[0];
    const text = [];
    const tip = [];
    if (tier) {
      text.push(FOMO_TIER_ICON[tier]);
      tip.push(`Capital tier: ${FOMO_TIER_NAME[tier]}`);
    }
    if (board) {
      text.push(`🏆${FOMO_BOARD_LABEL[board[1]]}#${board[2]}`);
      tip.push(`FOMO ${FOMO_BOARD_LABEL[board[1]]} profit rank #${board[2]}`);
    }
    if (smart) {
      if (!board) text.push(`🧠#${smart[1]}`);
      tip.push(`Smart Money rank #${smart[1]}`);
    }
    if (kol) {
      text.push('⭐');
      tip.push('Listed as a KOL');
    }
    if (!text.length) return null;
    return { text: text.join(''), title: tip.join(' · '), top: !!(board && Number(board[2]) <= 10) };
  }

  function attachFomoBoard(container, handle) {
    const mark = fomoBoardMark(handle);
    if (!mark) return;
    const chip = document.createElement('span');
    chip.className = `gdh-fomo__board${mark.top ? ' is-top' : ''}`;
    chip.textContent = mark.text;
    chip.title = mark.title;
    container.appendChild(chip);
  }

  // ---- Local narrative translation (Chrome 138+) ----
  const fomoTrCache = new Map();
  const FOMO_TR_CACHE_MAX = 300;
  const fomoTranslators = new Map();
  let fomoDetector = null;
  let fomoTrQueue = [];
  let fomoTrRunning = false;
  let fomoTrGesture = false;
  let fomoTrNeedsGesture = false;
  let fomoTrStuck = false;
  let fomoTrProgress = 0;
  let fomoTrGeneration = 0;
  const fomoTrPendingLangs = new Set();
  const FOMO_TR_STUCK_MS = 15000;
  const FOMO_TRANSLATION_SOURCE_SELECTOR = '.gdh-fomo__text, .gdh-fomo__htext, .gdh-fomofeed__thesis';

  function browserKind() {
    try {
      const brands = navigator.userAgentData?.brands || [];
      if (brands.some((b) => /Microsoft Edge/i.test(b.brand))) return 'edge';
    } catch {
    }
    return / Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
  }

  function syncFomoTrButton() {
    const btn = fomoPanelEl && fomoPanelEl.querySelector('.gdh-fomo__tr');
    if (!btn) return;
    const supported = !!fomoTrApi();
    const edge = browserKind() === 'edge';
    const downloading = fomoTrProgress > 0 && fomoTrProgress < 100;
    btn.classList.toggle('is-on', supported && settings.fomoTranslate && !fomoTrNeedsGesture && !fomoTrStuck);
    btn.classList.toggle('is-off', !supported || fomoTrStuck);
    btn.classList.toggle('is-wait', supported && settings.fomoTranslate && (fomoTrNeedsGesture || downloading));
    btn.textContent = downloading ? `${fomoTrProgress}%` : 'EN';

    if (!supported) {
      btn.title = edge
        ? 'This Edge version does not provide the local Translation API'
        : 'This browser does not support local translation (Chrome 138+ required)';
    } else if (fomoTrStuck) {
      btn.title = edge
        ? 'Edge reported translation support, but the language pack did not become ready. Check Edge translation settings, then select this button to retry.'
        : 'The language pack did not finish downloading. Select this button to retry.';
    } else if (downloading) {
      btn.title = `Downloading an English translation pack: ${fomoTrProgress}%`;
    } else if (fomoTrNeedsGesture && settings.fomoTranslate) {
      btn.title = 'Select to download the English translation pack';
    } else if (settings.fomoTranslate) {
      btn.title = 'Turn off translation and remove translated lines';
    } else {
      btn.title = 'Add local English translations below the original text';
    }
  }

  const fomoTrApi = () => { try { return globalThis.Translator || null; } catch { return null; } };
  const fomoDetApi = () => { try { return globalThis.LanguageDetector || null; } catch { return null; } };

  function fomoLanguageProbe(text) {
    return String(text || '')
      .replace(/https?:[/][/]\S+/gi, ' ')
      .replace(/\b0x[a-f\d]+\b/gi, ' ')
      .replace(/[^\p{L}\p{M}\s\u0027-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fomoFallbackLang(text) {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
    if (/\p{Script=Hangul}/u.test(text)) return 'ko';
    if (/\p{Script=Han}/u.test(text)) return 'zh';
    return '';
  }

  function normalizeFomoLanguageTag(tag) {
    const raw = String(tag || '').trim().replace(/_/g, '-');
    if (!raw) return '';
    let canonical = raw;
    try {
      canonical = Intl.getCanonicalLocales(raw)[0] || raw;
    } catch {
    }
    const primary = canonical.split('-')[0].toLowerCase();
    return /^[a-z]{2,3}$/.test(primary) ? primary : '';
  }

  function selectFomoDetectedLanguage(list) {
    let best = null;
    for (const item of (Array.isArray(list) ? list : [])) {
      const lang = normalizeFomoLanguageTag(item?.detectedLanguage);
      const confidence = Number(item?.confidence);
      if (!lang || !Number.isFinite(confidence) || confidence <= 0) continue;
      if (!best || confidence > best.confidence
        || (confidence === best.confidence && lang === 'en' && best.lang !== 'en')) {
        best = { lang, confidence };
      }
    }
    return best?.lang || '';
  }

  async function fomoDetectLang(text) {
    const probe = fomoLanguageProbe(text);
    if (!probe) return '';
    const fallback = fomoFallbackLang(probe);
    // Kana and Hangul identify Japanese and Korean directly. Han alone is
    // ambiguous, so let the detector distinguish Chinese from all-kanji
    // Japanese before falling back to Chinese.
    if (fallback === 'ja' || fallback === 'ko') return fallback;
    const api = fomoDetApi();
    if (!api) return fallback;
    try {
      if (!fomoDetector) fomoDetector = await api.create();
      const list = await fomoDetector.detect(probe);
      const detected = selectFomoDetectedLanguage(list);
      if (fallback === 'zh' && detected === 'en') return 'zh';
      return detected || fallback;
    } catch {
      return fallback;
    }
  }

  function primeFomoTranslatorFromGesture(lang) {
    const api = fomoTrApi();
    const sourceLanguage = normalizeFomoLanguageTag(lang);
    if (!api || !sourceLanguage || sourceLanguage === 'en' || fomoTranslators.has(sourceLanguage)) return;
    try {
      const pending = api.create({ sourceLanguage, targetLanguage: 'en' })
        .then((instance) => {
          fomoTranslators.set(sourceLanguage, instance);
          fomoTrPendingLangs.delete(sourceLanguage);
          fomoTrNeedsGesture = false;
          syncFomoTrButton();
          return instance;
        })
        .catch(() => {
          fomoTranslators.delete(sourceLanguage);
          fomoTrPendingLangs.add(sourceLanguage);
          fomoTrNeedsGesture = true;
          syncFomoTrButton();
          return null;
        });
      fomoTranslators.set(sourceLanguage, pending);
    } catch {
      fomoTrPendingLangs.add(sourceLanguage);
      fomoTrNeedsGesture = true;
      syncFomoTrButton();
    }
  }

  function primeVisibleFomoTranslators() {
    const nodes = document.querySelectorAll(FOMO_TRANSLATION_SOURCE_SELECTOR);
    const langs = new Set(fomoTrPendingLangs);
    nodes.forEach((node) => {
      const lang = normalizeFomoLanguageTag(node.dataset.gdhTranslationLanguage)
        || fomoFallbackLang(fomoLanguageProbe(node.textContent));
      if (lang && lang !== 'en') langs.add(lang);
    });
    langs.forEach(primeFomoTranslatorFromGesture);
  }

  async function fomoTranslatorFor(lang) {
    const sourceLanguage = normalizeFomoLanguageTag(lang);
    if (!sourceLanguage || sourceLanguage === 'en') return null;
    if (fomoTranslators.has(sourceLanguage)) return fomoTranslators.get(sourceLanguage);
    const api = fomoTrApi();
    if (!api) return null;
    let availability = 'available';
    try {
      if (typeof api.availability === 'function') {
        availability = String(await api.availability({ sourceLanguage, targetLanguage: 'en' }) || 'available');
      }
    } catch {
      availability = 'available';
    }
    if (availability === 'unavailable') {
      return null;
    }
    if (availability !== 'available' && !fomoTrGesture) {
      fomoTrPendingLangs.add(sourceLanguage);
      fomoTrNeedsGesture = true;
      syncFomoTrButton();
      return null;
    }
    let sawProgress = false;
    let create;
    try {
      create = api.create({
        sourceLanguage,
        targetLanguage: 'en',
        monitor(m) {
          try {
            m.addEventListener('downloadprogress', (event) => {
              sawProgress = true;
              fomoTrProgress = Math.round((Number(event.loaded) || 0) * 100);
              syncFomoTrButton();
            });
          } catch {
          }
        },
      });
    } catch {
      fomoTrPendingLangs.add(sourceLanguage);
      fomoTrNeedsGesture = true;
      syncFomoTrButton();
      return null;
    }
    const stuck = new Promise((resolve) => {
      const tick = () => {
        if (sawProgress) return void window.setTimeout(tick, 5000);
        resolve('stuck');
      };
      window.setTimeout(tick, FOMO_TR_STUCK_MS);
    });
    let translator;
    try {
      translator = await Promise.race([create, stuck]);
    } catch {
      fomoTrPendingLangs.add(sourceLanguage);
      fomoTrNeedsGesture = true;
      syncFomoTrButton();
      return null;
    }
    if (translator === 'stuck') {
      fomoTrPendingLangs.add(sourceLanguage);
      fomoTrStuck = true;
      fomoTrNeedsGesture = false;
      syncFomoTrButton();
      return null;
    }
    fomoTrStuck = false;
    fomoTrProgress = 0;
    fomoTranslators.set(sourceLanguage, translator);
    fomoTrPendingLangs.delete(sourceLanguage);
    fomoTrNeedsGesture = false;
    syncFomoTrButton();
    return translator;
  }

  function paintTranslation(el, english, generation = fomoTrGeneration) {
    if (!settings.fomoTranslate || generation !== fomoTrGeneration || !english || !el.parentNode) return;
    let translationEl = el.nextElementSibling;
    if (!translationEl || !translationEl.classList.contains('gdh-fomo__zh')) {
      translationEl = document.createElement('div');
      translationEl.className = 'gdh-fomo__zh';
      el.after(translationEl);
    }
    translationEl.textContent = english;
    if (el.closest?.('.gdh-fomofeed')) scheduleFomoFeedRowReflow();
  }

  async function runFomoTranslate() {
    if (fomoTrRunning) return;
    fomoTrRunning = true;
    while (fomoTrQueue.length) {
      const { el, text, generation } = fomoTrQueue.shift();
      try {
        if (!settings.fomoTranslate || generation !== fomoTrGeneration) continue;
        const cached = fomoTrCache.get(text);
        if (cached !== undefined) {
          if (cached) paintTranslation(el, cached, generation);
          continue;
        }
        const lang = await fomoDetectLang(text);
        if (!settings.fomoTranslate || generation !== fomoTrGeneration) continue;
        if (!lang) continue;
        el.dataset.gdhTranslationLanguage = lang;
        if (lang === 'en') { setBoundedMap(fomoTrCache, text, '', FOMO_TR_CACHE_MAX); continue; }
        const translator = await fomoTranslatorFor(lang);
        if (!settings.fomoTranslate || generation !== fomoTrGeneration || !translator) continue;
        const english = String(await translator.translate(text) || '').trim();
        if (!settings.fomoTranslate || generation !== fomoTrGeneration || !english) continue;
        setBoundedMap(fomoTrCache, text, english, FOMO_TR_CACHE_MAX);
        paintTranslation(el, english, generation);
      } catch {
      }
    }
    fomoTrRunning = false;
  }

  function queueFomoTranslate(el, text) {
    if (!settings.fomoTranslate || !fomoTrApi()) return;
    const raw = String(text || '').trim();
    if (!raw) return;
    const cached = fomoTrCache.get(raw);
    if (cached !== undefined) { if (cached) paintTranslation(el, cached, fomoTrGeneration); return; }
    fomoTrQueue.push({ el, text: raw, generation: fomoTrGeneration });
    if (!fomoTrRunning) setTimeout(runFomoTranslate, 0);
  }

  function refreshFomoTranslations() {
    const nodes = document.querySelectorAll(FOMO_TRANSLATION_SOURCE_SELECTOR);
    if (!settings.fomoTranslate) {
      fomoTrQueue = [];
      document.querySelectorAll('.gdh-fomo__zh').forEach((el) => el.remove());
      return;
    }
    nodes.forEach((el) => queueFomoTranslate(el, el.textContent));
  }

  function applyFomoTranslationSetting(value) {
    const enabled = value !== false;
    if (settings.fomoTranslate !== enabled) {
      fomoTrGeneration += 1;
      fomoTrQueue = [];
    }
    settings.fomoTranslate = enabled;
    syncFomoTrButton();
    refreshFomoTranslations();
  }

  const FOMO_TIERS = [
    { icon: '💀', label: 'Heavy loss' },
    { icon: '🔴', label: 'Loss' },
    { icon: '⚪', label: 'Flat' },
    { icon: '🟢', label: 'Profit' },
    { icon: '🔥', label: 'Top' },
  ];

  function fomoTier(pnl, equity) {
    const abs = pnl >= 5e4 ? 4 : pnl >= 5e3 ? 3 : pnl > -5e3 ? 2 : pnl > -5e4 ? 1 : 0;
    if (!(equity > 100)) return abs;
    const rate = (pnl / equity) * 100;
    const pct = rate >= 30 ? 4 : rate >= 5 ? 3 : rate > -5 ? 2 : rate > -30 ? 1 : 0;
    return Math.min(abs, pct);
  }

  const FOMO_PNL_TTL = 10 * 60 * 1000;
  const FOMO_PNL_CACHE_MAX = 300;
  const fomoPnlCache = new Map();
  let fomoPnlQueue = [];
  let fomoPnlActive = 0;
  let fomoPnlObserver = null;

  function paintFomoTag(el, data) {
    const pnl = Number(data?.pnl);
    if (!data?.ok || !Number.isFinite(pnl)) {
      el.className = 'gdh-fomo__tag is-none';
      el.textContent = '—';
      el.title = data?.reason === 'expired' ? 'FOMO session expired' : 'No seven-day P&L data';
      return;
    }
    const equity = Number(data.equity) || 0;
    const tier = fomoTier(pnl, equity);
    const meta = FOMO_TIERS[tier];
    const rate = equity > 100 ? (pnl / equity) * 100 : NaN;
    el.className = `gdh-fomo__tag is-t${tier}`;
    el.textContent = `${meta.icon} ${pnl >= 0 ? '+' : ''}${fomoUsd(pnl) || '$0'}`;
    el.title = Number.isFinite(rate)
      ? `${meta.label} · 7d P&L ${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)} (${rate > 0 ? '+' : ''}${rate.toFixed(1)}%) · Portfolio ${fomoUsd(equity)}`
      : `${meta.label} · 7d P&L ${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)}`;
  }

  function pumpFomoPnl() {
    while (fomoPnlActive < 4 && fomoPnlQueue.length) {
      const job = fomoPnlQueue.shift();
      if (!job.el.isConnected) continue;
      fomoPnlActive += 1;
      const generation = fomoUiAuthGeneration;
      chrome.runtime.sendMessage({ type: 'fomo-user-pnl', payload: { userId: job.userId } })
        .then((res) => {
          if (generation !== fomoUiAuthGeneration) return;
          setBoundedMap(fomoPnlCache, job.userId, { at: Date.now(), data: res }, FOMO_PNL_CACHE_MAX);
          if (job.el.isConnected) paintFomoTag(job.el, res);
        })
        .catch(() => {})
        .finally(() => { fomoPnlActive -= 1; pumpFomoPnl(); });
    }
  }

  function watchFomoTag(el, userId) {
    const hit = fomoPnlCache.get(userId);
    if (hit && Date.now() - hit.at < FOMO_PNL_TTL) return void paintFomoTag(el, hit.data);
    if (!fomoPnlObserver) return;
    el.dataset.gdhUid = userId;
    fomoPnlObserver.observe(el);
  }

  function resetFomoTagObserver(root) {
    if (fomoPnlObserver) fomoPnlObserver.disconnect();
    fomoPnlQueue = [];
    fomoPnlObserver = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        const userId = e.target.dataset.gdhUid;
        if (userId) fomoPnlQueue.push({ el: e.target, userId });
      }
      pumpFomoPnl();
    }, { root, rootMargin: '120px' });
  }

  function renderFomoHolders(list, items) {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-fomo__empty';
      empty.textContent = 'No holders';
      return void list.appendChild(empty);
    }
    resetFomoTagObserver(list);
    for (const item of items.slice(0, 60)) {
      const row = document.createElement('div');
      row.className = 'gdh-fomo__hrow';
      row.classList.toggle('is-followed', item?.followed === true);

      const who = document.createElement('div');
      who.className = 'gdh-fomo__hwho';
      const avatarUrl = holderAvatar(item);
      if (avatarUrl) {
        const img = document.createElement('img');
        img.className = 'gdh-fomo__avatar';
        img.src = avatarUrl;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        who.appendChild(img);
      }
      const name = document.createElement('strong');
      name.className = 'gdh-fomo__name';
      name.textContent = holderName(item);
      who.appendChild(name);
      attachFomoBoard(who, fomoUser(item)?.userHandle);

      if (item?.followed === true) {
        const followed = document.createElement('span');
        followed.className = 'gdh-fomo__following';
        followed.textContent = '★ Following';
        followed.title = 'You follow this user on FOMO';
        who.appendChild(followed);
      }

      if (settings.mergeFomoHolders !== false) {
        const rankEl = buildRankBadge(holderTokenAmount(item));
        if (rankEl) who.appendChild(rankEl);
      }

      const uid = fomoUser(item)?.id;
      if (uid) {
        const tag = document.createElement('span');
        tag.className = 'gdh-fomo__tag is-loading';
        tag.textContent = '…';
        tag.title = 'Loading seven-day P&L';
        who.appendChild(tag);
        watchFomoTag(tag, String(uid));
      }

      const hold = fomoDur(item?.averageHoldTimeSeconds)
        || deepPick(item, /hold(ing)?(time|duration|period)|avghold/i, 'string');
      if (hold) {
        const h = document.createElement('span');
        h.className = 'gdh-fomo__hhold';
        h.textContent = String(hold).slice(0, 14);
        who.appendChild(h);
      }
      row.appendChild(who);

      const nums = document.createElement('div');
      nums.className = 'gdh-fomo__hnums';

      const posUsd = Number(item?.value ?? deepPick(item, /(position|value|balance)(usd)?$/i, 'number'));
      const posEl = document.createElement('span');
      posEl.className = 'gdh-fomo__hpos';
      posEl.textContent = Number.isFinite(posUsd) && posUsd > 0 ? fomoUsd(posUsd) : '—';
      nums.appendChild(posEl);

      const pnl = Number(item?.pnl ?? item?.realizedPnl ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number'));
      const pnlEl = document.createElement('span');
      pnlEl.className = 'gdh-fomo__hpnl';
      if (Number.isFinite(pnl) && pnl !== 0) {
        pnlEl.classList.add(pnl >= 0 ? 'is-up' : 'is-down');
        const basis = Number(item?.costBasis);
        const pct = Number.isFinite(basis) && basis > 0 ? (pnl / basis) * 100 : NaN;
        pnlEl.textContent = Number.isFinite(pct) && pct !== 0
          ? `${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`
          : `${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)}`;
      } else {
        pnlEl.textContent = '—';
      }
      nums.appendChild(pnlEl);

      const entryEl = document.createElement('span');
      entryEl.className = 'gdh-fomo__hentry';
      entryEl.textContent = fomoPrice(item?.averageEntryPrice)
        || fomoPrice(deepPick(item, /(entry|average).*(price)/i, 'number')) || '—';
      nums.appendChild(entryEl);
      row.appendChild(nums);

      const thesis = String(item?.comment?.comment
        || deepPick(item, /(thesis|content|message|note|comment)/i, 'string') || '').trim();
      if (thesis) {
        const t = document.createElement('div');
        t.className = 'gdh-fomo__htext';
        t.textContent = thesis;
        row.appendChild(t);
        queueFomoTranslate(t, thesis);
      }
      list.appendChild(row);
    }
  }

  function renderFomoItems(list, items, kind) {
    if (kind === 'holders') return renderFomoHolders(list, items);
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-fomo__empty';
      empty.textContent = kind === 'thesis' ? 'No narratives yet' : 'No trades';
      list.appendChild(empty);
      return;
    }
    for (const item of items.slice(0, 50)) {
      const trade = normalizeFomoPopupTrade(item);
      const row = document.createElement('div');
      row.className = `gdh-fomo__item${trade.side ? ` is-${trade.side}` : ''}`;

      const head = document.createElement('div');
      head.className = 'gdh-fomo__head';
      const avatarUrl = holderAvatar(item);
      if (avatarUrl) {
        const img = document.createElement('img');
        img.className = 'gdh-fomo__avatar';
        img.src = avatarUrl;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        head.appendChild(img);
      }
      const name = document.createElement('strong');
      name.className = 'gdh-fomo__name';
      name.textContent = holderName(item);
      head.appendChild(name);
      attachFomoBoard(head, fomoUser(item)?.userHandle);
      row.classList.toggle('is-followed', item?.followed === true);
      if (item?.followed === true) {
        const badge = document.createElement('span');
        badge.className = 'gdh-fomo__following';
        badge.textContent = '★ Following';
        head.appendChild(badge);
      }

      if (kind === 'swaps' && (trade.side === 'buy' || trade.side === 'sell')) {
        const side = document.createElement('span');
        side.className = `gdh-fomo__side gdh-fomo__side--${trade.side}`;
        side.textContent = trade.side === 'sell' ? '↓ Sell' : '↑ Buy';
        side.title = trade.side === 'sell' ? 'Sell activity' : 'Buy activity';
        head.appendChild(side);
        if (trade.position) {
          const position = document.createElement('span');
          position.className = 'gdh-fomo__position';
          position.textContent = trade.position;
          position.title = `Position change: ${trade.position}`;
          head.appendChild(position);
        }
      }

      const authorTrade = item?.authorTrade;
      const pnl = Number(authorTrade
        ? (authorTrade.closedAt ? authorTrade.realizedPnlUsd : (authorTrade.realizedPnlUsd || 0) + (authorTrade.unrealizedPnlUsd || 0))
        : (item?.pnlChange ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number')));
      if (Number.isFinite(pnl) && pnl !== 0) {
        const pnlEl = document.createElement('span');
        pnlEl.className = `gdh-fomo__pnl ${pnl >= 0 ? 'is-up' : 'is-down'}`;
        pnlEl.textContent = fomoUsd(pnl);
        head.appendChild(pnlEl);
      }
      const sizeUsd = Number(item?.usdAmount ?? authorTrade?.usdValue
        ?? item?.positionUsd ?? deepPick(item, /(amount|size|value|position)(usd)?$/i, 'number'));
      if (Number.isFinite(sizeUsd) && Math.abs(sizeUsd) > 0) {
        const sz = document.createElement('span');
        sz.className = `gdh-fomo__size${trade.side ? ` is-${trade.side}` : ''}`;
        sz.textContent = fomoUsd(Math.abs(sizeUsd));
        head.appendChild(sz);
      }
      const time = document.createElement('span');
      time.className = 'gdh-fomo__time';
      time.textContent = fomoAgo(pick(item, ['createdAt', 'timestamp', 'createdTime', 'time'])
        || deepPick(item, /(createdat|created_at|timestamp|time)$/i, 'number'));
      head.appendChild(time);
      row.appendChild(head);

      const text = String(item?.comment?.comment
        || deepPick(item, /(thesis|content|text|body|message|note)/i, 'string') || '').trim();
      if (text) {
        const body = document.createElement('div');
        body.className = 'gdh-fomo__text';
        body.textContent = text;
        row.appendChild(body);
        queueFomoTranslate(body, text);
      }
      list.appendChild(row);
    }
  }

  function describeFomoToken(stored) {
    if (!stored?.token) return { cls: 'is-bad', text: 'No session found' };
    const exp = Number(stored.exp) || 0;
    const got = formatRelTime(stored.at || Date.now());
    if (!exp) return { cls: 'is-ok', text: `Found (${got})` };
    const left = exp - Date.now();
    if (left <= 0) return { cls: 'is-bad', text: `Expired ${formatRelTime(exp)}; found ${got}` };
    const mins = Math.round(left / 60000);
    return {
      cls: 'is-ok',
      text: `Valid for about ${mins >= 60 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}${stored.renewed ? ' (auto-renewed)' : ''}`,
    };
  }

  async function buildFomoErrorBox(res, isCurrentRequest = () => true) {
    const box = document.createElement('div');
    box.className = 'gdh-fomo__guide';
    let stored = null;
    try {
      const got = await chrome.storage.local.get('fomoToken');
      stored = got?.fomoToken || null;
    } catch {
    }
    if (!isCurrentRequest()) return box;
    const reason = res?.reason || 'unknown';
    if (reason === 'expired' && !fomoSelfHealTried) {
      fomoSelfHealTried = true;
      chrome.runtime.sendMessage({ type: 'fomo-force-refresh' })
        .then((r) => { if (r?.ok && isCurrentRequest()) { fomoLoadedKey = ''; fomoErrKey = ''; fomoLoadInflight = null; loadFomoData(true); } })
        .catch(() => {});
    }
    const needLogin = reason === 'no-token' || reason === 'expired' || reason === 'auth-changed';

    const title = document.createElement('div');
    title.className = 'gdh-fomo__gtitle';
    const why = document.createElement('div');
    why.className = 'gdh-fomo__gwhy';

    if (reason === 'no-token') {
      title.textContent = 'One more step: connect your FOMO session';
      why.textContent = 'FOMO holder and narrative requests require your login session. The extension reads it from your signed-in FOMO page; nothing needs to be copied.';
    } else if (reason === 'expired') {
      title.textContent = 'Your FOMO session expired';
      why.textContent = stored?.refresh
        ? 'Automatic renewal failed, usually because FOMO invalidated the session. Follow the steps below to reconnect.'
        : 'This saved session predates automatic renewal. Follow the steps below to reconnect with renewable credentials.';
    } else if (reason === 'blocked') {
      title.textContent = 'FOMO blocked the request';
      why.textContent = `Request returned ${res?.status || 403} (Cloudflare). Wait briefly, then retry.`;
    } else if (reason === 'network') {
      title.textContent = 'Network unavailable';
      why.textContent = fomoUiErrorText(res);
    } else {
      title.textContent = 'FOMO refresh unavailable';
      why.textContent = fomoUiErrorText(res);
    }
    box.append(title, why);

    if (needLogin) {
      const steps = document.createElement('ol');
      steps.className = 'gdh-fomo__steps';
      [
        ['Open FOMO with the button below', 'FOMO opens in a new tab'],
        ['Confirm that you are signed in', 'Sign in if needed, or refresh the page once'],
        ['Open your profile from the top-right avatar', 'The positions page provides the most reliable session mirror'],
        ['Return to this tab', 'The extension reconnects automatically'],
      ].forEach(([main, sub]) => {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = main;
        const s = document.createElement('span');
        s.textContent = sub;
        li.append(b, s);
        steps.appendChild(li);
      });
      box.appendChild(steps);
    }

    const state = document.createElement('div');
    const desc = describeFomoToken(stored);
    state.className = `gdh-fomo__gstate ${desc.cls}`;
    state.textContent = `Session: ${desc.text}`;
    box.appendChild(state);

    const actions = document.createElement('div');
    actions.className = 'gdh-fomo__gacts';

    if (needLogin) {
      const link = document.createElement('a');
      link.className = 'gdh-fomo__gopen';
      link.href = 'https://fomo.family/';
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Open FOMO and sign in →';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        window.open('https://fomo.family/r/Unipioneer', '_blank', 'noopener,noreferrer');
      });
      actions.appendChild(link);
    }

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'gdh-fomo__retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isCurrentRequest() || Date.now() < fomoUi.retryAt) return;
      loadFomoData(true);
    });
    actions.appendChild(retry);
    box.appendChild(actions);
    return box;
  }

  let fomoStats = { key: '', holders: null, thesisCount: null, supply: 0 };
  let fomoSupplyLoadingKey = '';
  let fomoSelfHealTried = false;

  function fomoStatBlock(label, value, sub, accent) {
    const box = document.createElement('div');
    box.className = 'gdh-fomo__stat';
    const l = document.createElement('div');
    l.className = 'gdh-fomo__stat-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = `gdh-fomo__stat-value${accent ? ' is-accent' : ''}`;
    v.textContent = value;
    const sEl = document.createElement('div');
    sEl.className = 'gdh-fomo__stat-sub';
    sEl.textContent = sub;
    box.append(l, v, sEl);
    return box;
  }

  function holderTokenAmount(item) {
    const direct = Number(item?.humanAmount);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const found = deepPick(item, /^(human_?amount|token_?amount|amount|balance|quantity|qty|size)$/i, 'number');
    if (Number.isFinite(found) && found > 0) return found;

    const usd = Number(item?.value ?? deepPick(item, /(position|value|balance)(usd)?$/i, 'number'));
    const price = Number(item?.priceUsd ?? item?.price
      ?? deepPick(item, /^(price|price_?usd|token_?price)$/i, 'number'));
    if (Number.isFinite(usd) && usd > 0 && Number.isFinite(price) && price > 0) return usd / price;
    return 0;
  }

  function renderFomoStats() {
    if (!fomoPanelEl) return;
    const box = fomoPanelEl.querySelector('.gdh-fomo__stats');
    if (!box) return;
    const h = fomoStats.holders;
    if (!h) return void box.replaceChildren();

    const loaded = h.items.length;
    const total = Number.isFinite(h.total) && h.total > 0 ? h.total : loaded;
    const sumUsd = h.items.reduce((a, x) => a + (Number(x?.value) || 0), 0);
    const sumAmt = h.items.reduce((a, x) => a + holderTokenAmount(x), 0);
    const pct = fomoStats.supply > 0 ? (sumAmt / fomoStats.supply) * 100 : NaN;

    const thesis = Number.isFinite(fomoStats.thesisCount)
      ? `${fomoStats.thesisCount} narratives` : '—';
    const pctText = Number.isFinite(pct)
      ? `${loaded < total ? '≥' : ''}${pct < 0.01 ? '<0.01' : pct.toFixed(1)}%`
      : '—';
    const sub = `Total ${fomoUsd(sumUsd) || '$0'} · ${loaded}/${total}`;

    box.replaceChildren(
      fomoStatBlock('FOMO holders', total.toLocaleString('en-US'), thesis, false),
      fomoStatBlock('FOMO holding share', pctText, sub, true),
    );
  }

  async function loadFomoSupply(route) {
    const statKey = `${route.chain}|${route.address}`;
    const generation = fomoLoadGeneration;
    if (fomoStats.supply > 0 || fomoSupplyLoadingKey === statKey) return;
    fomoSupplyLoadingKey = statKey;
    try {
      let supply = 0;
      const apiQuery = gmgnApiQuery();
      if (apiQuery) {
        try {
          const res = await fetch(`https://gmgn.ai/api/v1/mutil_window_token_info?${apiQuery}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chain: route.chain, addresses: [route.address] }),
          });
          const body = await res.json().catch(() => null);
          const item = body?.data?.[0];
          const raw = item?.total_supply ?? item?.max_supply ?? item?.circulating_supply;
          const value = Number(raw);
          if (res.ok && body?.code === 0 && Number.isFinite(value) && value > 0) supply = value;
        } catch {
        }
      }

      if (!supply) {
        const fallback = await chrome.runtime.sendMessage({
          type: 'token-supply',
          payload: { chain: route.chain, address: route.address, apiQuery },
        }).catch(() => null);
        if (fallback?.ok && fallback.supply > 0) supply = Number(fallback.supply);
      }

      if (generation === fomoLoadGeneration && supply > 0 && fomoStats.key === statKey) {
        fomoStats.supply = supply;
        renderFomoStats();
      }
    } finally {
      if (fomoSupplyLoadingKey === statKey) fomoSupplyLoadingKey = '';
    }
  }

  async function loadFomoData(force) {
    const route = currentTokenRoute();
    if (!route || !fomoPanelEl || settings.fomoPanelOpen !== true) return;
    const key = `${fomoTab}|${route.chain}|${route.address}`;
    if (fomoUi.scope !== key) { resetFomoUi(); fomoUi.scope = key; }
    if (Date.now() < fomoUi.retryAt) return;
    if (!force && key === fomoLoadedKey) return;
    if (!force && key === fomoErrKey && Date.now() - fomoErrAt < FOMO_ERR_COOLDOWN) return;
    if (fomoLoadInflight?.key === key) return;
    const requestGeneration = ++fomoLoadGeneration;
    const requestPanel = fomoPanelEl;
    const authGeneration = fomoUiAuthGeneration;
    fomoLoadInflight = { key, generation: requestGeneration };
    const isCurrentRequest = () => {
      if (requestGeneration !== fomoLoadGeneration || authGeneration !== fomoUiAuthGeneration
        || fomoPanelEl !== requestPanel || settings.fomoPanelOpen !== true) return false;
      const current = currentTokenRoute();
      return Boolean(current && `${fomoTab}|${current.chain}|${current.address}` === key);
    };
    const list = requestPanel.querySelector('.gdh-fomo__list');
    if (!fomoUi.meta && !list.querySelector('.gdh-fomo__guide')) {
      const loading = document.createElement('div');
      loading.className = 'gdh-fomo__empty';
      loading.textContent = 'Loading…';
      list.replaceChildren(loading);
    }
    renderFomoUi();
    const showError = async (response) => {
      if (!isCurrentRequest()) return;
      const error = fomoUiError(response);
      const needsLogin = ['no-token', 'expired', 'auth-changed'].includes(error.reason);
      if (needsLogin) {
        fomoLastItems = []; fomoUi.meta = null; fomoLoadedKey = '';
        fomoStats = { key: '', holders: null, thesisCount: null, supply: 0 };
        renderFomoStats(); list.replaceChildren();
      }
      fomoUi.error = error; fomoUi.retryAt = error.retryAt;
      fomoErrKey = key; fomoErrAt = Date.now();
      // Async session-guide reads must not paint after auth/route/panel changes.
      if (!fomoUi.meta) {
        const box = await buildFomoErrorBox(error, isCurrentRequest);
        if (!isCurrentRequest()) return;
        list.replaceChildren(box);
      }
      if (!isCurrentRequest()) return;
      renderFomoUi();
      requestPanel.classList.toggle('has-error', !fomoUi.meta);
    };
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'fomo-token-feed',
        payload: { tokenAddress: route.address, networkId: route.networkId, kind: fomoTab },
      });
      if (!isCurrentRequest()) return;
      if (res?.ok && Array.isArray(res.items)) {
        fomoLoadedKey = key; fomoErrKey = '';
        fomoLastItems = res.items;
        fomoUi.meta = fomoUiMeta(res); fomoUi.error = null; fomoUi.retryAt = 0;
        const statKey = `${route.chain}|${route.address}`;
        if (fomoStats.key !== statKey) {
          fomoStats = { key: statKey, holders: null, thesisCount: null, supply: 0 };
          fomoSelfHealTried = false;
        }
        if (fomoTab === 'holders') fomoStats.holders = { items: res.items, total: Number(res.total) };
        if (fomoTab === 'thesis') fomoStats.thesisCount = res.items.length;
        loadFomoSupply(route);
        renderFomoStats(); renderFomoUiItems(); renderFomoUi();
        requestPanel.classList.remove('has-error');
      } else await showError(res);
    } catch {
      await showError({ reason: 'runtime' });
    } finally {
      if (fomoLoadInflight?.generation === requestGeneration) fomoLoadInflight = null;
    }
  }

  function positionFomoPanel(panel) {
    const pos = settings.fomoPanelPos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, pos.x))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, pos.y))}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.right = '16px';
      panel.style.top = '110px';
      panel.style.left = 'auto';
    }
  }

  function makeFomoDraggable(panel, handle) {
    let sx = 0; let sy = 0; let ox = 0; let oy = 0; let dragging = false;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = event.clientX; sy = event.clientY; ox = r.left; oy = r.top;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - 120, ox + event.clientX - sx));
      const y = Math.max(0, Math.min(window.innerHeight - 60, oy + event.clientY - sy));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const r = panel.getBoundingClientRect();
      settings.fomoPanelPos = { x: Math.round(r.left), y: Math.round(r.top) };
      try {
        chrome.storage.local.set({ fomoPanelPos: settings.fomoPanelPos });
      } catch {
        // ignore
      }
    });
  }

  function setFomoOpen(open) {
    settings.fomoPanelOpen = open;
    if (!open) resetFomoUi();
    try {
      chrome.storage.local.set({ fomoPanelOpen: open });
    } catch {
      // ignore
    }
  }

  function buildFomoPanel() {
    const panel = document.createElement('section');
    panel.className = 'gdh-fomo-panel';

    const head = document.createElement('div');
    head.className = 'gdh-fomo__bar';
    const title = document.createElement('strong');
    title.className = 'gdh-fomo__title';
    title.textContent = 'fomo';
    const tabs = document.createElement('div');
    tabs.className = 'gdh-fomo__tabs';
    [['holders', 'Holders'], ['thesis', 'Narratives'], ['swaps', 'Trades']].forEach(([id, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gdh-fomo__tab';
      btn.dataset.tab = id;
      btn.textContent = label;
      btn.classList.toggle('is-active', fomoTab === id);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        fomoTab = id;
        panel.querySelectorAll('.gdh-fomo__tab').forEach((t) => {
          t.classList.toggle('is-active', t.dataset.tab === id);
        });
        loadFomoData(true);
      });
      tabs.appendChild(btn);
    });
    const open = document.createElement('a');
    open.className = 'gdh-fomo__ext';
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = '↗';
    open.title = 'Open on fomo.family';
    const tr = document.createElement('button');
    tr.type = 'button';
    tr.className = 'gdh-fomo__tr';
    tr.textContent = 'EN';
    tr.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (settings.fomoTranslate && fomoTrStuck) {
        fomoTrStuck = false;
        fomoTrGesture = true;
        fomoTranslators.clear();
        primeVisibleFomoTranslators();
        syncFomoTrButton();
        refreshFomoTranslations();
        return;
      }
      if (settings.fomoTranslate && fomoTrNeedsGesture) {
        fomoTrGesture = true;
        fomoTrNeedsGesture = false;
        primeVisibleFomoTranslators();
        syncFomoTrButton();
        refreshFomoTranslations();
        return;
      }
      const enabled = !settings.fomoTranslate;
      applyFomoTranslationSetting(enabled);
      if (enabled) {
        fomoTrGesture = true;
        primeVisibleFomoTranslators();
      }
      chrome.storage.local.set({ fomoTranslate: enabled });
    });

    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'gdh-fomo__fold';
    fold.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      settings.fomoPanelFolded = !settings.fomoPanelFolded;
      chrome.storage.local.set({ fomoPanelFolded: settings.fomoPanelFolded });
      applyFomoFold();
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-fomo__close';
    close.textContent = '×';
    close.title = 'Close (use the FOMO button to reopen)';
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setFomoOpen(false);
      scheduleScan();
    });
    head.append(title, tabs, tr, open, fold, close);

    const stats = document.createElement('div');
    stats.className = 'gdh-fomo__stats';

    const list = document.createElement('div');
    list.className = 'gdh-fomo__list';
    list.setAttribute('data-fomo-list', '');
    panel.setAttribute('aria-label', 'FOMO token panel');
    panel.append(head, stats, buildFomoUi(), list);
    makeFomoDraggable(panel, head);
    applyFomoFold(panel);
    return panel;
  }

  function applyFomoFold(target) {
    const panel = target || fomoPanelEl;
    if (!panel) return;
    const folded = settings.fomoPanelFolded === true;
    panel.classList.toggle('is-folded', folded);
    const btn = panel.querySelector('.gdh-fomo__fold');
    if (btn) {
      btn.textContent = folded ? '▣' : '▤';
      btn.title = folded ? 'Expand full panel' : 'Collapse to holder count and holding share';
    }
  }

  function ensureFomoLauncher() {
    let btn = document.querySelector('.gdh-fomo-launcher');
    const anchor = nativeLauncherAnchor('[data-sentry-component="BaseInfoBar"]');
    if (settings.enableFomoPanel === false || !currentTokenRoute() || !anchor) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gdh-fomo-launcher';
      btn.textContent = 'fomo';
      btn.title = 'View this token on FOMO';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        notificationPanelOpen = false;
        notificationPanelEl?.remove();
        notificationPanelEl = null;
        setFomoOpen(!settings.fomoPanelOpen);
        scheduleScan();
      });
    }
    if (btn.parentElement !== anchor || anchor.lastElementChild !== btn) anchor.appendChild(btn);
    btn.setAttribute('aria-label', 'FOMO token panel');
    btn.setAttribute('aria-expanded', String(settings.fomoPanelOpen === true));
    btn.classList.toggle('is-active', settings.fomoPanelOpen === true);
  }

  function scanFomoPanel() {
    ensureNotificationLauncher();
    const route = currentTokenRoute();
    if (settings.enableFomoPanel === false || !route || settings.fomoPanelOpen !== true) {
      if (fomoPanelEl) {
        resetFomoUi();
        fomoPanelEl.remove();
        fomoPanelEl = null;
        fomoLoadedKey = '';
      }
      if (fomoTimer) {
        window.clearInterval(fomoTimer);
        fomoTimer = 0;
      }
      ensureFomoLauncher();
      return;
    }
    ensureFomoLauncher();
    if (!fomoPanelEl || !document.contains(fomoPanelEl)) {
      fomoPanelEl = buildFomoPanel();
      document.body.appendChild(fomoPanelEl);
      positionFomoPanel(fomoPanelEl);
      syncFomoTrButton();
      fomoLoadedKey = '';
    }
    const slug = FOMO_CHAIN_SLUG[route.chain] || route.chain;
    const ext = fomoPanelEl.querySelector('.gdh-fomo__ext');
    if (ext) ext.href = `https://fomo.family/tokens/${slug}/${route.address}`;
    loadFomoData(false);
    if (!fomoTimer) {
      fomoTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') loadFomoData(true);
      }, FOMO_REFRESH_MS);
    }
  }

  const HOLDING_ROW_SELECTOR = '[data-sentry-component="SmToken"]';
  const HOLDING_PANEL_PRESENT = '[data-testid="position-table-floating"], [data-sentry-source-file^="PositionTable"], [data-sentry-source-file="Holding.tsx"]';
  const HOLDING_WATCH_PER_CHAIN_MAX = 100;
  const HOLDING_POLL_MS = 30000;
  const HOLDING_API_TTL_MS = 30000;
  const GMGN_HOLDING_CONFIG_REQUEST_EVENT = 'gdh-holding-config-request';
  const GMGN_HOLDING_CONFIG_RESULT_EVENT = 'gdh-holding-config-result';
  const GMGN_HOLDING_CONFIG_RESULT_ATTRIBUTE = 'data-gdh-holding-config-result';
  const GMGN_HOLDING_SIGNAL_SYNC_MS = 5 * 60 * 1000;
  const GMGN_HOLDING_SIGNAL_RETRY_MS = 60 * 1000;

  function holdingCooldownMs() {
    const minutes = Number(settings.holdingSurgeCooldown);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60 * 1000;
  }
  const HOLDING_BATCH = 40;
  const holdingAlertedAt = new Map();
  const holdingAlertLevel = new Map();
  let holdingWatchMap = new Map();
  let holdingSaveTimer = 0;
  const holdingPendingWrites = new Map();
  const holdingApiSyncedAt = new Map();
  const holdingApiInflight = new Map();
  const holdingAlertConfirming = new Set();
  let holdingPollTimer = 0;
  let holdingPolling = false;
  let gmgnHoldingSignalConfig = { loaded: false, byChain: new Map(), at: 0 };
  let gmgnHoldingSignalAttemptAt = 0;
  let gmgnHoldingSignalInflight = null;

  function holdingSignalBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true' || value === 'on' || value === 'open') return true;
    if (value === 0 || value === '0' || value === 'false' || value === 'off' || value === 'close') return false;
    return null;
  }

  function parseGmgnHoldingSignalConfig(payload) {
    const candidates = [payload, payload?.data, payload?.result];
    const rows = candidates.find((value) => Array.isArray(value));
    if (!rows) return null;
    const byChain = {};
    for (const row of rows) {
      const chain = String(row?.push_chain || '').trim().toLowerCase();
      const dict = row?.push_switch_dict;
      if (!chain || !dict || typeof dict !== 'object'
        || !Object.prototype.hasOwnProperty.call(dict, 'holding_signal')) continue;
      const enabled = holdingSignalBoolean(dict.holding_signal);
      if (enabled !== null) byChain[chain] = enabled;
    }
    return Object.keys(byChain).length ? byChain : null;
  }

  function holdingSignalAllowed(chain) {
    if (settings.enableHoldingSurge === false) return false;
    if (!gmgnHoldingSignalConfig.loaded) return true;
    const normalized = String(chain || '').toLowerCase();
    if (normalized === 'robinhood' && !gmgnHoldingSignalConfig.byChain.has(normalized)) return true;
    return gmgnHoldingSignalConfig.byChain.get(normalized) === true;
  }

  function saveGmgnHoldingSignalSyncState(state) {
    try {
      chrome.storage.local.set({ gmgnHoldingSignalSyncState: state });
    } catch {
    }
  }

  function requestGmgnHoldingSignalConfig() {
    return new Promise((resolve) => {
      if (!document.documentElement) return resolve({ ok: false, reason: 'unavailable', stage: 'document' });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        document.removeEventListener(GMGN_HOLDING_CONFIG_RESULT_EVENT, onResult);
        resolve(result);
      };
      const onResult = () => {
        try {
          const raw = document.documentElement.getAttribute(GMGN_HOLDING_CONFIG_RESULT_ATTRIBUTE);
          finish(raw ? JSON.parse(raw) : { ok: false, reason: 'unavailable', stage: 'missing-result' });
        } catch {
          finish({ ok: false, reason: 'unavailable', stage: 'invalid-result' });
        }
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, reason: 'unavailable', stage: 'timeout' }),
        11000,
      );
      document.addEventListener(GMGN_HOLDING_CONFIG_RESULT_EVENT, onResult);
      document.dispatchEvent(new Event(GMGN_HOLDING_CONFIG_REQUEST_EVENT));
    });
  }

  async function syncGmgnHoldingSignalConfig(force = false) {
    if (gmgnHoldingSignalInflight) return gmgnHoldingSignalInflight;
    if (settings.enableHoldingSurge === false || !isTabVisibleForHolding()) return null;
    const now = Date.now();
    const waitMs = gmgnHoldingSignalConfig.loaded
      ? GMGN_HOLDING_SIGNAL_SYNC_MS : GMGN_HOLDING_SIGNAL_RETRY_MS;
    if (!force && now - gmgnHoldingSignalAttemptAt < waitMs) return null;
    gmgnHoldingSignalAttemptAt = now;
    gmgnHoldingSignalInflight = (async () => {
      try {
        const result = await requestGmgnHoldingSignalConfig();
        const parsed = result?.ok ? parseGmgnHoldingSignalConfig(result.data) : null;
        if (!parsed) {
          saveGmgnHoldingSignalSyncState({
            synced: false,
            reason: result?.reason === 'login-required' ? 'login-required' : 'unavailable',
            detail: String(result?.stage || ''),
            status: Number(result?.status) || 0,
            attemptedAt: Date.now(),
            lastSyncedAt: gmgnHoldingSignalConfig.at || 0,
          });
          return null;
        }

        const previous = gmgnHoldingSignalConfig.byChain;
        const next = new Map(Object.entries(parsed));
        gmgnHoldingSignalConfig = { loaded: true, byChain: next, at: Date.now() };
        for (const key of holdingAlertLevel.keys()) {
          const chain = key.split(':', 1)[0];
          if (previous.get(chain) !== next.get(chain)) holdingAlertLevel.delete(key);
        }
        saveGmgnHoldingSignalSyncState({
          synced: true,
          source: 'gmgn-app',
          robinhoodFallback: !next.has('robinhood'),
          enabledChains: [...next].filter(([, enabled]) => enabled).map(([chain]) => chain),
          disabledChains: [...next].filter(([, enabled]) => !enabled).map(([chain]) => chain),
          attemptedAt: gmgnHoldingSignalConfig.at,
          lastSyncedAt: gmgnHoldingSignalConfig.at,
        });
        return parsed;
      } catch (error) {
        saveGmgnHoldingSignalSyncState({
          synced: false,
          reason: 'unavailable',
          detail: String(error?.message || error?.name || 'exception').slice(0, 120),
          status: 0,
          attemptedAt: Date.now(),
          lastSyncedAt: gmgnHoldingSignalConfig.at || 0,
        });
        return null;
      }
    })().finally(() => { gmgnHoldingSignalInflight = null; });
    return gmgnHoldingSignalInflight;
  }

  function holdingKey(chain, address) {
    const normalizedChain = String(chain || '').trim().toLowerCase();
    const normalizedAddress = normalizeWalletAddress(String(address || ''));
    return normalizedChain && normalizedAddress ? `${normalizedChain}:${normalizedAddress}` : '';
  }

  function rebuildHoldingWatch() {
    const previous = holdingWatchMap;
    const next = new Map(
      (Array.isArray(settings.holdingWatchList) ? settings.holdingWatchList : [])
        .map((item) => {
          const chain = String(item?.chain || '').trim().toLowerCase();
          const address = normalizeWalletAddress(String(item?.address || ''));
          const key = holdingKey(chain, address);
          return key ? [key, {
            chain,
            address,
            symbol: String(item?.symbol || ''),
            cost: Number(item?.cost) > 0 ? Number(item.cost) : 0,
            at: Number(item?.at) || 0,
          }] : null;
        })
        .filter(Boolean),
    );
    for (const [key, item] of next) {
      const old = previous.get(key);
      if (!old || holdingCostMateriallyChanged(old.cost, item.cost)) {
        holdingAlertedAt.delete(key);
        holdingAlertLevel.delete(key);
      }
    }
    for (const key of previous.keys()) {
      if (next.has(key)) continue;
      holdingAlertedAt.delete(key);
      holdingAlertLevel.delete(key);
    }
    holdingWatchMap = next;
  }

  function scheduleHoldingSave(chain, replace = false) {
    const normalizedChain = String(chain || '').trim().toLowerCase();
    if (!normalizedChain) return;
    const pending = holdingPendingWrites.get(normalizedChain);
    holdingPendingWrites.set(normalizedChain, { replace: replace || pending?.replace === true });
    if (holdingSaveTimer) return;
    holdingSaveTimer = window.setTimeout(() => {
      holdingSaveTimer = 0;
      const writes = [...holdingPendingWrites.entries()];
      holdingPendingWrites.clear();
      for (const [writeChain, options] of writes) {
        const items = [...holdingWatchMap.values()]
          .filter((item) => item.chain === writeChain)
          .sort((a, b) => b.at - a.at)
          .slice(0, HOLDING_WATCH_PER_CHAIN_MAX);
        try {
          chrome.runtime.sendMessage({
            type: 'holding-watch-update',
            payload: { chain: writeChain, items, replace: options.replace === true },
          }, () => void chrome.runtime.lastError);
        } catch {
          // context invalidated
        }
      }
    }, 800);
  }

  function holdingCostFromApi(hit) {
    const positive = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const nonNegative = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const balance = positive(hit?.balance);
    const amount = positive(hit?.accu_amount);
    const cost = positive(hit?.accu_cost);
    if (!balance || !amount || !cost) return { balance, average: 0 };
    return { balance, average: (cost + nonNegative(hit?.accu_fee)) / amount };
  }

  function holdingCostChange(price, cost) {
    const now = Number(price);
    const base = Number(cost);
    return now > 0 && base > 0 ? ((now - base) / base) * 100 : NaN;
  }

  function holdingFiveMinuteChange(update, price) {
    const now = Number(price);
    const base = Number(update?.price5m ?? update?.p5m ?? update?.price_5m);
    if (now > 0 && base > 0) return ((now - base) / base) * 100;
    const fallback = Number(update?.pct5m ?? update?.pcp5m ?? update?.price_change_percent5m);
    return Number.isFinite(fallback) ? fallback : NaN;
  }

  function holdingCostMateriallyChanged(previous, next) {
    const before = Number(previous);
    const after = Number(next);
    if (!(after > 0)) return false;
    if (!(before > 0)) return true;
    return Math.abs(after - before) / before >= 0.001;
  }

  function putHolding(item) {
    const key = holdingKey(item?.chain, item?.address);
    if (!key) return false;
    const prev = holdingWatchMap.get(key);
    const next = {
      chain: String(item.chain).toLowerCase(),
      address: normalizeWalletAddress(String(item.address)),
      symbol: String(item.symbol || '').slice(0, 24),
      cost: Number(item.cost) > 0 ? Number(item.cost) : (Number(prev?.cost) || 0),
      at: Number(item.at) || Date.now(),
    };
    if (!prev || holdingCostMateriallyChanged(prev.cost, next.cost)) {
      holdingAlertedAt.delete(key);
      holdingAlertLevel.delete(key);
    }
    holdingWatchMap.set(key, next);
    return !prev || prev.symbol !== next.symbol || prev.cost !== next.cost;
  }

  function requestHoldingSnapshot() {
    return new Promise((resolve) => {
      if (!document.documentElement) return resolve({ ok: false });
      const id = `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const finish = (result) => {
        window.clearTimeout(timer);
        document.removeEventListener('gdh-holdings-result', onResult);
        resolve(result);
      };
      const onResult = () => {
        try {
          const result = JSON.parse(document.documentElement.getAttribute('data-gdh-holdings-result') || 'null');
          if (result?.id === id) finish(result);
        } catch { /* wait for a matching sanitized result */ }
      };
      const timer = window.setTimeout(() => finish({ ok: false }), 22000);
      document.addEventListener('gdh-holdings-result', onResult);
      document.documentElement.setAttribute('data-gdh-holdings-request', JSON.stringify({ id, chain: '' }));
      document.dispatchEvent(new Event('gdh-holdings-request'));
      document.documentElement.removeAttribute('data-gdh-holdings-request');
    });
  }

  async function syncHoldingWatchFromApi(targetChain = '', force = false, expectedKey = '') {
    if (settings.enableHoldingSurge === false || !isTabVisibleForHolding()) return { ok: false, present: false };
    // One multichain read coalesces poll + alert confirmation without guessing the fusion page's chain.
    const cacheKey = 'multichain';
    let task = holdingApiInflight.get(cacheKey);
    if (!task && !force && Date.now() - (holdingApiSyncedAt.get(cacheKey) || 0) < HOLDING_API_TTL_MS) {
      return { ok: false, reason: 'throttled', present: false };
    }
    if (!task) {
      holdingApiSyncedAt.set(cacheKey, Date.now());
      task = (async () => {
        const result = await requestHoldingSnapshot();
        const seen = new Set();
        if (!result?.ok || !Array.isArray(result.data)) return { ok: false, seen };
        if (settings.enableHoldingSurge === false || !isTabVisibleForHolding()) return { ok: false, seen };
        for (const group of result.data) {
          const chain = String(group?.chain || '');
          if (!['sol', 'bsc', 'base', 'robinhood'].includes(chain) || !Array.isArray(group.rows)) continue;
          const grouped = new Map();
          for (const row of group.rows.slice(0, 1000)) {
            const address = normalizeWalletAddress(String(row?.token_address || ''));
            if (!address) continue;
            const { balance, average } = holdingCostFromApi(row);
            if (!(balance > 0)) continue;
            const key = holdingKey(chain, address);
            const hit = grouped.get(key) || { address, symbol: '', weightedCost: 0, balance: 0, completeCost: true };
            hit.symbol = hit.symbol || String(row?.symbol || '').slice(0, 24);
            hit.balance += balance;
            if (!(average > 0)) hit.completeCost = false;
            hit.weightedCost += average * balance;
            grouped.set(key, hit);
          }
          for (const [key, hit] of grouped) {
            // Missing cost must not reuse another wallet scope's old basis.
            if (!hit.completeCost || !(hit.weightedCost > 0)) continue;
            putHolding({ chain, address: hit.address, symbol: hit.symbol, cost: hit.weightedCost / hit.balance, at: Date.now() });
            seen.add(key);
          }
          // Native filters/pagination and wallet selections are not a chain-wide inventory.
          // Never purge unrelated positions; every alert still requires positive fresh confirmation.
          scheduleHoldingSave(chain, false);
        }
        return { ok: true, seen, authoritative: false };
      })().catch(() => ({ ok: false, seen: new Set() })).finally(() => holdingApiInflight.delete(cacheKey));
      holdingApiInflight.set(cacheKey, task);
    }
    const result = await task;
    return { ...result, present: expectedKey ? result.seen?.has(expectedKey) === true : null };
  }

  function collectHoldingRows() {
    if (!isTabVisibleForHolding()) return;
    let changed = false;
    const rows = [...document.querySelectorAll('[data-gdh-hold-addr]')];
    const changedChains = new Set();
    rows.forEach((row) => {
      const chain = String(row.getAttribute('data-gdh-hold-chain') || '').toLowerCase();
      const address = normalizeWalletAddress(row.getAttribute('data-gdh-hold-addr') || '');
      if (!chain || !address) return;
      const symbol = row.getAttribute('data-gdh-hold-symbol') || '';
      const cost = Number(row.getAttribute('data-gdh-hold-cost')) || 0;
      if (putHolding({ chain, address, symbol, cost, at: Date.now() })) changed = true;
      changedChains.add(chain);
    });
    if (changed) changedChains.forEach((chain) => scheduleHoldingSave(chain, false));
  }

  function formatPriceShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${n.toPrecision(4)}`;
  }

  function holdingSurgeDecision(previousLevel, pct, threshold, cooldownReady, fiveMinuteRising) {
    const level = Math.floor((Number(pct) + 1e-9) / Number(threshold));
    const previous = Number.isFinite(previousLevel) ? previousLevel : null;
    if (!Number.isFinite(level)) return { nextLevel: previous ?? 0, alert: false };
    if (previous === null) {
      return { nextLevel: fiveMinuteRising ? Math.max(level, 0) : 0, alert: false };
    }
    if (level <= 0) return { nextLevel: 0, alert: false };
    if (!fiveMinuteRising) return { nextLevel: previous, alert: false };
    if (level <= previous || !cooldownReady) return { nextLevel: previous, alert: false };
    return { nextLevel: level, alert: true };
  }

  async function confirmHoldingStillOwned(chain, key) {
    if (!key || holdingAlertConfirming.has(key)) return false;
    holdingAlertConfirming.add(key);
    try {
      const result = await syncHoldingWatchFromApi(chain, true, key);
      return result?.ok === true && result.present === true && holdingWatchMap.has(key);
    } finally {
      holdingAlertConfirming.delete(key);
    }
  }

  async function handleHoldingPriceUpdate(update, fallbackSymbol = '') {
    if (settings.enableHoldingSurge === false || !isTabVisibleForHolding()) return;
    const chain = String(update?.chain || '').trim().toLowerCase();
    if (!holdingSignalAllowed(chain)) return;
    const address = normalizeWalletAddress(String(update?.address || ''));
    const key = holdingKey(chain, address);
    const meta = holdingWatchMap.get(key);
    const price = Number(update?.price ?? update?.p);
    const pct = holdingCostChange(price, meta?.cost);
    const pct5m = holdingFiveMinuteChange(update, price);
    if (!meta || !(price > 0) || !Number.isFinite(pct) || !Number.isFinite(pct5m)) return;
    const threshold = Math.max(5, Number(settings.holdingSurgeThreshold) || 20);
    const last = holdingAlertedAt.get(key) || 0;
    const decision = holdingSurgeDecision(
      holdingAlertLevel.has(key) ? holdingAlertLevel.get(key) : null,
      pct,
      threshold,
      Date.now() - last >= holdingCooldownMs(),
      pct5m > 0,
    );
    if (!decision.alert) {
      holdingAlertLevel.set(key, decision.nextLevel);
      return;
    }
    if (!(await confirmHoldingStillOwned(chain, key))) return;
    if (settings.enableHoldingSurge === false || !isTabVisibleForHolding() || !holdingSignalAllowed(chain)) return;
    const confirmedMeta = holdingWatchMap.get(key);
    const confirmedPct = holdingCostChange(price, confirmedMeta?.cost);
    const confirmedDecision = holdingSurgeDecision(
      holdingAlertLevel.has(key) ? holdingAlertLevel.get(key) : null,
      confirmedPct,
      threshold,
      Date.now() - (holdingAlertedAt.get(key) || 0) >= holdingCooldownMs(),
      pct5m > 0,
    );
    holdingAlertLevel.set(key, confirmedDecision.nextLevel);
    if (!confirmedDecision.alert || !confirmedMeta) return;
    holdingAlertedAt.set(key, Date.now());
    showRemindCard({
      href: `/${chain}/token/${address}`,
      dir: 'up',
      bell: '🚀',
      kind: 'position-surge',
      tagText: 'Position surge',
      symbol: confirmedMeta.symbol || fallbackSymbol || 'Position token',
      label: 'Cost / 5m',
      value: `Cost ${confirmedPct >= 0 ? '+' : ''}${confirmedPct.toFixed(1)}% · 5m +${pct5m.toFixed(1)}%`,
      raw: '',
    });
  }

  document.addEventListener('gdh-token-stat', () => {
    const raw = document.documentElement?.getAttribute('data-gdh-token-stat') || '';
    if (!raw) return;
    try {
      const items = JSON.parse(raw);
      if (Array.isArray(items)) items.forEach((item) => handleHoldingPriceUpdate(item));
    } catch {
    }
  });

  async function pollHoldingSurge() {
    if (holdingPolling) return;
    if (settings.enableHoldingSurge === false) return;
    if (!isTabVisibleForHolding()) return;
    const entries = [...holdingWatchMap.values()]
      .filter((item) => holdingSignalAllowed(item.chain));
    if (!entries.length) return;

    holdingPolling = true;
    const byChain = new Map();
    entries.forEach((item) => {
      if (!byChain.has(item.chain)) byChain.set(item.chain, []);
      byChain.get(item.chain).push(item);
    });

    for (const [chain, items] of byChain) {
      for (let i = 0; i < items.length; i += HOLDING_BATCH) {
        const slice = items.slice(i, i + HOLDING_BATCH);
        try {
          const res = await fetch(`https://gmgn.ai/api/v1/mutil_window_token_info?${gmgnApiQuery() || DEV_ATH_QS}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chain, addresses: slice.map((s) => s.address) }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || body?.code !== 0 || !Array.isArray(body.data)) continue;
          body.data.forEach((token) => {
            const p = token?.price;
            if (!p) return;
            const now = Number(p.price);
            if (!(now > 0)) return;
            const address = normalizeWalletAddress(String(token.address || p.address || ''));
            handleHoldingPriceUpdate({
              chain,
              address,
              price: now,
              price5m: Number(p.price_5m),
              pct5m: Number(p.price_change_percent5m),
            }, token.symbol);
          });
        } catch {
        }
      }
    }
    holdingPolling = false;
  }

  function isTabVisibleForHolding() {
    return document.visibilityState === 'visible';
  }

  function startHoldingPoll() {
    if (holdingPollTimer) return;
    holdingPollTimer = window.setInterval(async () => {
      syncGmgnHoldingSignalConfig().catch(() => {});
      await syncHoldingWatchFromApi().catch(() => {});
      pollHoldingSurge().catch(() => {});
    }, HOLDING_POLL_MS);
  }

  function scanHoldingSurge() {
    if (settings.enableHoldingSurge === false) {
      if (holdingPollTimer) {
        window.clearInterval(holdingPollTimer);
        holdingPollTimer = 0;
      }
      return;
    }
    if (!isTabVisibleForHolding()) return;
    syncGmgnHoldingSignalConfig().catch(() => {});
    collectHoldingRows();
    syncHoldingWatchFromApi().catch(() => {});
    startHoldingPoll();
  }

  function scanRemindToasts() {
    if (settings.enableRemindAlert === false) {
      document.querySelectorAll('[data-gdh-remind-taken="1"]').forEach((node) => {
        node.style.removeProperty('display');
        delete node.dataset.gdhRemindTaken;
      });
      remindContainer?.remove();
      remindContainer = null;
      return;
    }
    document.querySelectorAll(REMIND_TOAST_SELECTOR).forEach((node) => {
      if (node.dataset.gdhRemindTaken === '1') return;
      node.dataset.gdhRemindTaken = '1';
      try {
        showRemindCard(remindInfoFromToast(node));
        node.style.setProperty('display', 'none', 'important');
      } catch {
        node.style.removeProperty('display');
      }
    });
  }

  function scanFrontrunLightning() {
    if (settings.hideLightningTrade !== true) {
      document
        .querySelectorAll('[data-gdh-hidden-lightning="1"]')
        .forEach(restoreFrontrunHost);
      return;
    }
    document.querySelectorAll(FRONTRUN_LIGHTNING_SELECTOR).forEach(hideFrontrunHost);
    document.querySelectorAll('frontrun-csui').forEach((host) => {
      try {
        const shadow = host.shadowRoot;
        if (!shadow) return;
        const isLightning = (shadow.textContent || '').includes('\u95ea\u7535\u4ea4\u6613');
        if (isLightning) hideFrontrunHost(host);
        else if (host.dataset.gdhHiddenLightning === '1') restoreFrontrunHost(host);
      } catch {
      }
    });
  }

  function formatRelTime(ms) {
    const diff = Math.max(0, Date.now() - Number(ms));
    if (diff < 60e3) return `${Math.max(1, Math.floor(diff / 1e3))}s ago`;
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)}m ago`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h ago`;
    return `${Math.floor(diff / 86400e3)}d ago`;
  }

  function scanCalloutBlacklist() {
    if (settings.enableCalloutBlacklist === false) {
      blacklistModalOpen = false;
      document.querySelectorAll('.gdh-callout-blacklist-button, .gdh-callout-block-button, .gdh-callout-blacklist-modal, .gdh-callout-toast')
        .forEach((element) => element.remove());
      document.querySelectorAll('[data-gdh-callout-host="1"]').forEach((host) => {
        delete host.dataset.gdhCalloutHost;
        delete host.dataset.gdhCallerBlocked;
      });
      document.querySelectorAll(`${MANIFESTO_SELECTOR}[data-gdh-caller-blocked="1"]`)
        .forEach((chip) => delete chip.dataset.gdhCallerBlocked);
      document.querySelectorAll('.gdh-callout-panel-host')
        .forEach((panel) => panel.classList.remove('gdh-callout-panel-host'));
      return;
    }

    document.querySelectorAll(CALLOUT_SELECTOR).forEach(applyCalloutCardState);
    document.querySelectorAll(MANIFESTO_SELECTOR).forEach(applyManifestoState);
    ensureCalloutControls();
  }

  function scanCards() {
    scanScheduled = false;
    scanRafId = 0;
    if (settings.showDevTooltip === false) {
      dismissTooltipForLifecycle();
    }
    document.documentElement.style.setProperty(
      '--gdh-highlight',
      settings.highlightColor || DEFAULTS.highlightColor,
    );
    scanVisibleCards();
    ensureDeveloperBookmarkButtons();
  }

  const FOMO_FEED_POLL_MS = 5000;
  // The passive source already bounds its snapshot. A second head-only render
  // cap evicts still-readable cards on every burst and cannot represent history.
  const FOMO_FEED_CHAIN_COLORS = {
    sol: '#7b44f2', bsc: '#eab204', base: '#3073ff', eth: '#4d84f7', robinhood: '#9fc700',
    stable: '#007b4f', arc: '#5c8de5', xlayer: '#4a4a4a', hyperevm: '#55c6ab',
    megaeth: '#2a2a2a', monad: '#6a52f1',
  };
  function fomoFeedChainColor(chain) {
    try {
      const raw = JSON.parse(window.localStorage.getItem('follow_toast_chain_color_v1') || '{}');
      const custom = raw?.[chain]?.color;
      if (typeof custom === 'string' && custom) return custom;
    } catch {
    }
    return FOMO_FEED_CHAIN_COLORS[chain] || '#8a93a6';
  }

  const FOMO_FEED_TAGS = {
    buy: { label: 'Buy', cls: 'is-buy' },
    sell: { label: 'Sell', cls: 'is-sell' },
    thesis: { label: 'Narrative', cls: 'is-thesis' },
    callout: { label: 'Callout', cls: 'is-callout' },
    reply: { label: 'Reply', cls: 'is-reply' },
  };
  const FOMO_FEED_MARKERS = {
    followed: { label: 'Following', icon: '★' },
  };
  let fomoFollowedEvents = [];
  const fomoFeedCards = new Map();
  const fomoFeedSeen = new Set();
  const FOMO_FEED_SEEN_MAX = 600;
  let fomoFollowedLastPollAt = 0;
  function currentChainSlug() {
    const match = location.pathname.match(/^\/(sol|bsc|eth|base|tron|blast|monad|megaeth|hyperevm|xlayer|robinhood|arc|stable|arbitrum)(\/|$)/);
    if (match) return match[1];
    const q = new URLSearchParams(location.search).get('chain');
    return q ? String(q).toLowerCase() : '';
  }

  function fomoFeedEventAllowed(ev) {
    const types = settings.fomoFeedTypes || DEFAULTS.fomoFeedTypes;
    if (types[ev.type] === false) return false;
    if (ev.addr && isTokenBlocked(ev.addr)) return false;
    if (ev?.source === 'fomo-followed') return ev.followed === true;
    return false;
  }

  function trackingFeedNormalizedAddress(raw) {
    const value = String(raw || '').trim();
    return /^0x[a-fA-F0-9]+$/.test(value) ? value.toLowerCase() : value;
  }

  function trackingFeedNormalizedTx(raw) {
    const value = String(raw || '').trim();
    return value.startsWith('0x') ? value.toLowerCase() : value;
  }

  function trackingFeedEventIdentity(ev) {
    if (ev?.source === 'fomo-followed') {
      // A tradeId is a position, not a swap or transaction. A single position
      // can contain many buys, exits and independent comments.
      const kind = String(ev.type || '');
      const user = String(ev.userId || ev.handle || '');
      const narrative = ['thesis', 'reply', 'callout'].includes(kind);
      const id = typeof ev.canonicalIdentity === 'string' && ev.canonicalIdentity
        ? ['canonical', ev.canonicalIdentity]
        : narrative
        ? ev.commentId ? ['comment', ev.commentId] : ['event', ev.eventId || ev.providerEventId || ev.key]
        : ev.swapId ? ['swap', ev.swapId] : ['event', ev.eventId || ev.providerEventId || ev.key];
      return `fomo-followed:${JSON.stringify([kind, user, id[0], String(id[1] || '')])}`;
    }
    const tx = trackingFeedNormalizedTx(ev?.tx);
    if (tx) return `tx:${tx}`;
    const source = String(ev?.source || 'fomo');
    const addr = trackingFeedNormalizedAddress(ev?.addr);
    const side = String(ev?.type || '');
    const principal = trackingFeedNormalizedAddress(ev?.handle);
    const ts = Math.round((Number(ev?.ts) || 0) / 1000);
    const usd = Math.round((Number(ev?.usd) || 0) * 100);
    if (addr && side && principal && ts) return `event:${source}:${addr}:${side}:${principal}:${ts}:${usd}`;
    return `key:${String(ev?.key || '')}`;
  }

  function nativeTrackingFeedRows(cards) {
    // Complete bridge identities stay stable while the native virtualizer
    // recycles its pool. A visible-only duplicate filter makes FOMO rows vanish
    // and reappear (and changes the insertion map) merely because of scrolling.
    for (const card of cards) {
      const spacer = card.closest('[data-gdh-native-index]');
      if (!spacer) continue;
      try {
        const stamps = JSON.parse(spacer.getAttribute('data-gdh-native-index'));
        const rows = JSON.parse(spacer.getAttribute('data-gdh-native-rows'));
        if (Array.isArray(stamps) && Array.isArray(rows) && rows.length === stamps.length && rows.length <= 10000
          && rows.every((row,i) => row && row.ts === stamps[i])) return rows.map(row => ({
            tx:trackingFeedNormalizedTx(row.tx), addr:trackingFeedNormalizedAddress(row.addr),
            chain:String(row.chain || '').trim().toLowerCase(), side:String(row.side || '').trim().toLowerCase(), ts:row.ts,
          }));
      } catch { /* Older bridge snapshots retain their conservative fallback. */ }
    }
    return cards.map((card) => ({
      tx: trackingFeedNormalizedTx(card.getAttribute('data-gdh-track-tx')),
      addr: trackingFeedNormalizedAddress(card.getAttribute('data-gdh-track-addr')),
      chain: String(card.getAttribute('data-gdh-track-chain') || '').trim().toLowerCase(),
      side: String(card.getAttribute('data-gdh-track-side') || '').trim().toLowerCase(),
      maker: trackingFeedNormalizedAddress(card.getAttribute('data-gdh-track-maker')),
      ts: Number(card.getAttribute('data-gdh-track-ts')) || 0,
      usd: Number(card.getAttribute('data-gdh-track-usd')) || 0,
    })).filter((row) => row.tx || (row.addr && row.side && row.ts));
  }

  function trackingFeedIsNativeDuplicate(ev, row) {
    const side = String(ev?.type || '').trim().toLowerCase();
    if (side !== 'buy' && side !== 'sell') return false;
    const tx = trackingFeedNormalizedTx(ev?.tx);
    if (ev?.source === 'fomo-followed') {
      // Direct provider events carry real hashes only; absent a hash, fuzzy
      // amount/time matching cannot prove that two position fills are one.
      const addr = trackingFeedNormalizedAddress(ev?.addr);
      const chain = String(ev?.chain || '').trim().toLowerCase();
      return !!tx && !!row?.tx && tx === row.tx
        && !!addr && addr === row.addr && side === row.side
        && !!chain && chain === row.chain;
    }
    if (tx && row?.tx && tx === row.tx) return true;
    const addr = trackingFeedNormalizedAddress(ev?.addr);
    if (!addr || !row?.addr || addr !== row.addr || !row.side || side !== row.side) return false;
    const chain = String(ev?.chain || '').trim().toLowerCase();
    if (chain && row.chain && chain !== row.chain) return false;
    const ts = Number(ev?.ts) || 0;
    if (!ts || !row.ts || Math.abs(ts - row.ts) > 15000) return false;
    const usd = Number(ev?.usd) || 0;
    if (!usd || !row.usd) return false;
    return Math.abs(usd - row.usd) <= Math.max(1, Math.max(usd, row.usd) * 0.05);
  }

  function visibleTrackingFeedEvents(nativeRows = []) {
    const chain = settings.fomoFeedChainOnly === true ? currentChainSlug() : '';
    const out = [];
    if (settings.enableFomoFeed !== false) {
      for (const ev of fomoFollowedEvents) {
        if (!ev?.key || !ev.ts || !fomoFeedEventAllowed(ev)) continue;
        if (chain && ev.chain && ev.chain !== chain) continue;
        out.push(ev);
      }
    }
    const seen = new Set();
    return out.sort((a, b) => b.ts - a.ts).filter((ev) => {
      const identity = trackingFeedEventIdentity(ev);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return !nativeRows.some((row) => trackingFeedIsNativeDuplicate(ev, row));
    });
  }

  let trackingFeedRaf = 0;
  function scheduleTrackingFeedRender() {
    if (trackingFeedRaf || document.visibilityState === 'hidden') return;
    trackingFeedRaf = requestAnimationFrame(() => {
      trackingFeedRaf = 0;
      scanFomoFeed();
    });
  }

  let fomoFollowedRaf = 0;
  let fomoFollowedEpoch = '';
  let fomoFollowedRevision = 0;
  let fomoFollowedUpdatedAt = 0;
  async function updateFomoFollowedEpoch(record) {
    const generation = fomoUiAuthGeneration;
    fomoFollowedEpoch = '';
    const token = String(record?.token || '').trim();
    if (!token) return;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      if (generation !== fomoUiAuthGeneration) return;
      fomoFollowedEpoch = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* Poll callbacks still have generation fencing if digest is unavailable. */ }
  }
  function canDisplayFomoFollowedFeed() {
    return settings.enabled && settings.enableFomoFeed !== false
      && (document.querySelector(TRACK_TAB_CELL) || trackerCards().length);
  }
  function applyFomoFollowedResponse(resp) {
    renderFomoFollowedGap(resp);
    if (!Array.isArray(resp.events)) return;
    fomoFollowedRevision += 1;
    fomoFollowedUpdatedAt = Number(resp.updatedAt) || 0;
    fomoFollowedEvents = resp.events.map((event) => {
      const normalized = { ...event, source: 'fomo-followed', followed: true };
      normalized.key = trackingFeedEventIdentity(normalized);
      return normalized;
    });
    scheduleFomoFollowedRender();
  }
  function scheduleFomoFollowedRender() {
    if (fomoFollowedRaf || document.visibilityState === 'hidden') return;
    fomoFollowedRaf = requestAnimationFrame(() => {
      fomoFollowedRaf = 0;
      scanFomoFeed(); // direct callback lane: never wait for the full-page scan
    });
  }

  function pollFomoFollowedFeed() {
    const canDisplay = canDisplayFomoFollowedFeed;
    if (!canDisplay()) { renderFomoFollowedGap(null); return; }
    const generation = fomoUiAuthGeneration;
    const revision = fomoFollowedRevision;
    fomoFollowedLastPollAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'fomo-followed-feed' }, (resp) => {
        if (generation !== fomoUiAuthGeneration || !canDisplay()) return;
        if (chrome.runtime.lastError || !resp) {
          renderFomoFollowedGap({ stale: true });
          return;
        }
        if (resp.mode === 'passive') {
          if (revision !== fomoFollowedRevision) return;
          applyFomoFollowedResponse(resp); // empty snapshots must clear stale account rows too
          return;
        }
        if (resp.reason === 'not-connected') {
          fomoFollowedEvents = [];
          renderFomoFollowedGap({ ...resp, stale: true });
          scheduleFomoFollowedRender();
          return;
        }
        // Auth rejection above outranks snapshot freshness, including a push
        // received while this same-account request was still in flight.
        if (revision !== fomoFollowedRevision && !(Number(resp.updatedAt) > fomoFollowedUpdatedAt)) return;
        // A failed later page can still carry useful same-account partial data.
        applyFomoFollowedResponse(resp);
      });
    } catch {
      if (generation === fomoUiAuthGeneration && canDisplay()) renderFomoFollowedGap({ stale: true });
    }
  }

  function fomoFeedRelTime(ts) {
    const diff = Math.max(0, Date.now() - Number(ts));
    if (diff < 60000) return `${Math.max(1, Math.floor(diff / 1000))}s`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  }

  function refreshFomoFeedTimes(root = document) {
    root.querySelectorAll('[data-gdh-fomo-ts]').forEach((timeEl) => {
      const ts = Number(timeEl.dataset.gdhFomoTs);
      if (!Number.isFinite(ts) || ts <= 0) return;
      const next = fomoFeedRelTime(ts);
      if (timeEl.textContent !== next) timeEl.textContent = next;
    });
  }

  function gdhSpaNavigate(url) {
    if (location.pathname === url) return;
    const before = location.pathname;
    try {
      document.documentElement.setAttribute('data-gdh-nav', url);
      document.dispatchEvent(new Event('gdh-navigate'));
    } catch {
      location.href = url;
      return;
    }
    window.setTimeout(() => {
      if (location.pathname === before) location.href = url;
    }, 450);
  }

  function trackingFeedProfileMeta(ev) {
    if (ev?.source === 'fomo-followed') {
      return {
        source: `${FOMO_FEED_MARKERS.followed.icon} ${FOMO_FEED_MARKERS.followed.label}`,
        title: `${ev?.handle ? `@${ev.handle}` : fomoFeedUserLabel(ev)} · Followed on FOMO${ev?.userId ? ` · ${ev.userId}` : ''}`,
        url: ev?.handle ? `https://fomo.family/profile/${encodeURIComponent(ev.handle)}` : '',
      };
    }
    return {
      source: 'fomo',
      title: `@${ev?.handle || ''} · Open FOMO profile`,
      url: ev?.handle ? `https://fomo.family/profile/${encodeURIComponent(ev.handle)}` : '',
    };
  }

  function appendFomoFollowedMarkers(container, ev) {
    if (ev?.source !== 'fomo-followed') return;
    const icon = document.createElement('span');
    icon.className = `gdh-fomofeed__event-icon is-${ev.type || 'position'}`;
    icon.textContent = ev.type === 'sell' ? '↘' : ev.type === 'thesis' ? '✦' : '↗';
    icon.title = ev.type === 'sell' ? 'Followed user sold' : ev.type === 'thesis'
      ? 'Followed user posted a thesis' : 'Followed user bought';
    container.appendChild(icon);
    if (ev.position) {
      const position = document.createElement('span');
      position.className = 'gdh-fomofeed__position';
      position.textContent = ev.position;
      position.title = `FOMO position action: ${ev.position}`;
      container.appendChild(position);
    }
  }

  function fomoFeedUserLabel(ev) {
    const name = String(ev.name || '').trim();
    if (name && name !== 'Followed user') return name;
    if (ev.handle) return String(ev.handle);
    const id = String(ev.userId || '');
    return id ? `FOMO user ${id.slice(0, 6)}…${id.slice(-4)}` : 'Unknown FOMO user';
  }

  function fomoFeedTokenLabel(ev) {
    const symbol = String(ev.symbol || '').trim();
    if (symbol) return symbol;
    const address = String(ev.addr || '');
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Token unavailable';
  }

  // Snapshot only fields that affect card content/behavior. Unchanged polls keep
  // their DOM; enrichment replaces one row without replaying its entry animation.
  function fomoFeedCardSignature(ev, tableMode = isTrackerTableMode()) {
    return JSON.stringify([tableMode, ...[
      'source', 'dataSource', 'type', 'stale', 'name', 'handle', 'userId', 'avatar',
      'symbol', 'img', 'chain', 'addr', 'usd', 'mc', 'mcSource', 'comment', 'position', 'profileUrl',
    ].map(key => ev[key] ?? null)]);
  }

  // Native Alerts use absolute amounts and compact Math.round formatting (not
  // the signed/decimal formatter used by positions and PnL elsewhere).
  function fomoFeedUsd(ev, value) {
    if (ev.dataSource !== 'trading-activity') return fomoUsd(value);
    if (value == null || value === '' || !Number.isFinite(Number(value))) return '';
    const n = Math.abs(Number(value));
    if (n < 1000 && Math.round(n) < 1000) return `$${Math.round(n)}`;
    const units = [[1e3, 'K'], [1e6, 'M'], [1e9, 'B']];
    let i = n < 1e6 ? 0 : n < 1e9 ? 1 : 2;
    if (i < 2 && Number((n / units[i][0]).toFixed(1)) >= 1000) i++;
    return `$${(n / units[i][0]).toFixed(1).replace(/\.0$/, '')}${units[i][1]}`;
  }

  function fomoFeedMcTitle(ev) {
    return {
      'alerts-fdv': 'Native Alerts MC: provider fdv (preferred over marketCap)',
      'alerts-market-cap': 'Native Alerts MC: provider marketCap (fdv unavailable)',
      'alerts-unavailable': 'Native Alerts market cap unavailable',
      'current-token': 'Current token market cap — not the historical trade-time market cap',
    }[ev.mcSource] || 'Provider market cap';
  }

  function buildFomoFeedTableRow(ev, card, tag) {
    const profile = trackingFeedProfileMeta(ev);
    const row = document.createElement('div');
    row.className = 'gdh-fomofeed__trow';

    const time = document.createElement('span');
    time.className = 'gdh-fomofeed__tcell gdh-fomofeed__ttime';
    time.dataset.gdhFomoTs = String(ev.ts);
    time.textContent = fomoFeedRelTime(ev.ts);

    const who = document.createElement('span');
    who.className = 'gdh-fomofeed__tcell gdh-fomofeed__twho';
    const av = document.createElement('span');
    av.className = 'gdh-fomofeed__av';
    if (ev.avatar) {
      const img = document.createElement('img');
      img.src = ev.avatar; img.loading = 'lazy'; img.decoding = 'async';
      img.onerror = function () { this.remove(); };
      av.appendChild(img);
    } else {
      av.textContent = (ev.name || ev.handle || '?').slice(0, 1).toUpperCase();
    }
    const name = document.createElement('span');
    name.className = 'gdh-fomofeed__name';
    name.textContent = fomoFeedUserLabel(ev);
    name.title = profile.title;
    const openProfile = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (profile.url) window.open(profile.url, '_blank', 'noopener,noreferrer');
    };
    av.addEventListener('click', openProfile);
    name.addEventListener('click', openProfile);
    const src = document.createElement('span');
    src.className = 'gdh-fomofeed__src';
    src.textContent = ev.source === 'fomo-followed' ? FOMO_FEED_MARKERS.followed.icon : profile.source;
    src.title = ev.source === 'fomo-followed' ? FOMO_FEED_MARKERS.followed.label : profile.source;
    who.append(av, name, src);

    const sym = document.createElement('span');
    sym.className = 'gdh-fomofeed__tcell gdh-fomofeed__tsym';
    if (ev.img) {
      const logo = document.createElement('span');
      logo.className = 'gdh-fomofeed__logo';
      const img = document.createElement('img');
      img.src = ev.img; img.loading = 'lazy'; img.decoding = 'async';
      img.onerror = function () { this.parentElement?.remove(); };
      logo.appendChild(img);
      sym.appendChild(logo);
    }
    const symText = document.createElement('span');
    symText.className = 'gdh-fomofeed__symtext';
    symText.textContent = fomoFeedTokenLabel(ev);
    symText.title = ev.symbol ? String(ev.addr || '') : 'Ticker unavailable; token address shown';
    const act = document.createElement('span');
    act.className = 'gdh-fomofeed__tag';
    act.textContent = tag.label;
    sym.append(symText, act);
    appendFomoFollowedMarkers(sym, ev);

    const amt = document.createElement('span');
    amt.className = 'gdh-fomofeed__tcell gdh-fomofeed__tamt';
    amt.textContent = ev.dataSource === 'trading-activity' || ev.usd > 0 ? fomoFeedUsd(ev, ev.usd) : '';

    const mc = document.createElement('span');
    mc.className = 'gdh-fomofeed__tcell gdh-fomofeed__tmc';
    mc.textContent = ev.mc > 0 ? fomoUsd(ev.mc) : '';
    mc.title = fomoFeedMcTitle(ev);

    row.append(time, who, sym, amt, mc);
    card.appendChild(row);

    if (['thesis', 'refund', 'callout', 'reply'].includes(ev.type) && ev.comment) {
      const text = document.createElement('div');
      text.className = 'gdh-fomofeed__thesis';
      text.textContent = ev.comment;
      card.appendChild(text);
      queueFomoTranslate(text, ev.comment);
    }
  }

  function buildFomoFeedCard(ev, tableMode = isTrackerTableMode()) {
    const tag = FOMO_FEED_TAGS[ev.type] || { label: 'fomo', cls: '' };
    const profile = trackingFeedProfileMeta(ev);
    const card = document.createElement('div');
    card.className = `gdh-fomofeed ${tag.cls}${ev.source === 'fomo-followed' ? ' is-followed' : ''}`;
    card.dataset.gdhFomoKey = ev.key;
    card.dataset.gdhFeedSource = ev.source || 'fomo';
    card.dataset.gdhFomoStale = ev.stale ? '1' : '0';
    card.dataset.gdhFomoSignature = fomoFeedCardSignature(ev, tableMode);

    if (ev.chain) {
      const stripe = document.createElement('span');
      stripe.className = 'gdh-fomofeed__stripe';
      stripe.style.backgroundColor = fomoFeedChainColor(ev.chain);
      card.appendChild(stripe);
    }

    if (tableMode) {
      card.classList.add('is-table');
      buildFomoFeedTableRow(ev, card, tag);
      attachFomoFeedCardBehavior(ev, card);
      return card;
    }

    const r1 = document.createElement('div');
    r1.className = 'gdh-fomofeed__r1';

    const av = document.createElement('span');
    av.className = 'gdh-fomofeed__av';
    if (ev.avatar) {
      const img = document.createElement('img');
      img.src = ev.avatar;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onerror = function () { this.remove(); };
      av.appendChild(img);
    } else {
      av.textContent = (ev.name || ev.handle || '?').slice(0, 1).toUpperCase();
    }

    const name = document.createElement('span');
    name.className = 'gdh-fomofeed__name';
    name.textContent = fomoFeedUserLabel(ev);
    name.title = profile.title;
    const openProfile = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (profile.url) window.open(profile.url, '_blank', 'noopener,noreferrer');
    };
    av.addEventListener('click', openProfile);
    name.addEventListener('click', openProfile);

    const tagEl = document.createElement('span');
    tagEl.className = 'gdh-fomofeed__tag';
    tagEl.textContent = tag.label;

    const src = document.createElement('span');
    src.className = 'gdh-fomofeed__src';
    src.textContent = profile.source;

    const time = document.createElement('span');
    time.className = 'gdh-fomofeed__time';
    time.dataset.gdhFomoTs = String(ev.ts);
    time.textContent = fomoFeedRelTime(ev.ts);

    r1.append(av, name, tagEl);
    appendFomoFollowedMarkers(r1, ev);
    r1.append(src, time);
    card.appendChild(r1);

    const r2 = document.createElement('div');
    r2.className = 'gdh-fomofeed__r2';

    if (ev.dataSource === 'trading-activity' || ev.usd > 0) {
      const usd = document.createElement('span');
      usd.className = 'gdh-fomofeed__usd';
      usd.textContent = fomoFeedUsd(ev, ev.usd);
      r2.appendChild(usd);
    }

    if (ev.img) {
      const logo = document.createElement('span');
      logo.className = 'gdh-fomofeed__logo';
      const img = document.createElement('img');
      img.src = ev.img;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onerror = function () { this.parentElement?.remove(); };
      logo.appendChild(img);
      r2.appendChild(logo);
    }

    {
      const sym = document.createElement('span');
      sym.className = 'gdh-fomofeed__sym';
      sym.textContent = fomoFeedTokenLabel(ev);
      sym.title = ev.symbol ? String(ev.addr || '') : 'Ticker unavailable; token address shown';
      r2.appendChild(sym);
    }

    if (ev.mc > 0) {
      const mc = document.createElement('span');
      mc.className = 'gdh-fomofeed__mc';
      mc.textContent = `MC:${fomoUsd(ev.mc)}`;
      mc.title = fomoFeedMcTitle(ev);
      r2.appendChild(mc);
    }
    card.appendChild(r2);

    if (['thesis', 'refund', 'callout', 'reply'].includes(ev.type) && ev.comment) {
      const text = document.createElement('div');
      text.className = 'gdh-fomofeed__thesis';
      text.textContent = ev.comment;
      card.appendChild(text);
      queueFomoTranslate(text, ev.comment);
    }

    attachFomoFeedCardBehavior(ev, card);
    return card;
  }

  function attachFomoFeedCardBehavior(ev, card) {
    if (ev.source === 'fomo-followed' && ev.addr && ev.chain) {
      const buy = document.createElement('div');
      buy.className = 'gdh-native-buy-host';
      buy.tabIndex = 0;
      buy.setAttribute('aria-label', `Quick buy ${ev.symbol || ev.addr} on ${ev.chain}`);
      buy.dataset.chain = ev.chain;
      buy.dataset.address = ev.addr;
      buy.dataset.symbol = ev.symbol || '';
      buy.dataset.logo = ev.img || '';
      buy.dataset.eventKey = ev.key;
      buy.dataset.state = 'idle';
      buy.textContent = 'Buy';
      buy.title = 'Hover to load native GMGN quick buy';
      card.appendChild(buy);
    }
    if (ev.addr && ev.chain) {
      card.title = `${ev.symbol || ev.addr} · Open GMGN token page`;
      card.addEventListener('click', (event) => {
        if (event.target.closest?.('.gdh-native-buy-host')) { event.stopPropagation(); return; }
        event.preventDefault();
        event.stopPropagation();
        gdhSpaNavigate(`/${ev.chain}/token/${ev.addr}`);
      });
    }
    card.addEventListener('pointerdown', (event) => event.stopPropagation());

    if (!fomoFeedSeen.has(ev.key)) {
      rememberBoundedSet(fomoFeedSeen, ev.key, FOMO_FEED_SEEN_MAX);
      card.classList.add('is-new');
    }
  }

  function fomoFeedCardFor(ev, tableMode = isTrackerTableMode()) {
    let el = fomoFeedCards.get(ev.key);
    if (el instanceof HTMLElement && el.dataset.gdhFomoSignature !== fomoFeedCardSignature(ev, tableMode)) {
      const replacement = buildFomoFeedCard(ev, tableMode);
      mergedTracker?.resize.unobserve(el);
      if (el.isConnected) el.replaceWith(replacement);
      el = replacement;
      fomoFeedCards.set(ev.key, el);
    }
    if (!el || !(el instanceof HTMLElement)) {
      el = buildFomoFeedCard(ev, tableMode);
      fomoFeedCards.set(ev.key, el);
    }
    el.querySelectorAll('.gdh-fomofeed__time, .gdh-fomofeed__ttime').forEach((timeEl) => {
      if (timeEl.dataset.gdhFomoTs !== String(ev.ts)) timeEl.dataset.gdhFomoTs = String(ev.ts);
    });
    refreshFomoFeedTimes(el);
    return el;
  }

  const fomoFeedShifted = new Map();
  let fomoFeedReflowRaf = 0;
  const fomoFeedScrollTargets = new WeakSet();

  function setFomoFeedRowShift(el, amount) {
    const next = Number.isFinite(amount) && Math.abs(amount) > 0.25 ? amount : 0;
    let state = fomoFeedShifted.get(el);
    if (!state && !next) return true;
    if (!state) {
      const originalTranslate = String(el.style.translate || '');
      if (originalTranslate && originalTranslate !== 'none') return false;
      state = { originalTranslate, amount: 0 };
      fomoFeedShifted.set(el, state);
    }
    if (!next) {
      el.style.translate = state.originalTranslate;
      fomoFeedShifted.delete(el);
      return true;
    }
    state.amount = next;
    // React can recycle a wrapper in place, including replacing its style.
    // Avoid writing identical styles: our geometry observer also sees translate.
    const translate = `0px ${next}px`;
    if (el.style.translate !== translate) el.style.translate = translate;
    return true;
  }

  function clearFomoFeedShifts() {
    for (const [el, state] of fomoFeedShifted) {
      if (el.isConnected) el.style.translate = state.originalTranslate;
    }
    fomoFeedShifted.clear();
  }

  function refreshFomoFeedFixedRowShifts() {
    if (mergedTracker) { syncMergedTracker(); return; }
    const cards = trackerCards().filter((card) => card.isConnected);
    const rows = [];
    for (const card of cards) {
      const info = fomoFeedFixedRow(card);
      if (info) rows.push({ card, ...info });
    }
    if (!rows.length) { clearFomoFeedShifts(); return; }
    rows.sort((a, b) => a.top - b.top);
    const spacer = rows[0].wrap.parentElement;
    if (!(spacer instanceof HTMLElement)) return;

    const stillShifted = new Set();
    let collapsed = 0;
    for (const row of rows) {
      const amount = collapsed;
      if (setFomoFeedRowShift(row.wrap, amount) && amount) stillShifted.add(row.wrap);
      if (row.card.dataset.gdhTokenBlocked === '1') collapsed -= row.h;
    }
    for (const el of [...fomoFeedShifted.keys()]) {
      if (!stillShifted.has(el)) {
        setFomoFeedRowShift(el, 0);
      }
    }
  }

  function scheduleFomoFeedRowReflow() {
    if (fomoFeedReflowRaf) return;
    if (!fomoFeedShifted.size && !document.querySelector('[data-gdh-token-blocked="1"]')) return;
    fomoFeedReflowRaf = window.requestAnimationFrame(() => {
      fomoFeedReflowRaf = 0;
      refreshFomoFeedFixedRowShifts();
    });
  }

  function fomoFeedFixedRow(cardEl) {
    let wrap = cardEl.parentElement;
    for (let level = 0; level < 4 && wrap instanceof HTMLElement; level += 1) {
      if ((wrap.style.position || '') === 'absolute') {
        const parent = wrap.parentElement;
        const state = fomoFeedShifted.get(wrap);
        let top = Number.NaN;
        if (parent instanceof HTMLElement) {
          const wrapRect = wrap.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          top = wrapRect.top - parentRect.top - parent.clientTop + parent.scrollTop
            - (state && wrap.style.translate === `0px ${state.amount}px` ? state.amount : 0);
        }
        if (!Number.isFinite(top)) top = Number.parseFloat(wrap.style.top);
        // Native rows may be fractional CSS pixels (e.g. 64.5px); offsetHeight
        // rounds to 65 and invalidates every subsequent virtual index boundary.
        const h = wrap.getBoundingClientRect().height || Number.parseFloat(wrap.style.height) || wrap.offsetHeight;
        if (Number.isFinite(top) && h > 0) return { wrap, top, h };
        return null;
      }
      wrap = wrap.parentElement;
    }
    return null;
  }

  function teardownFomoFeed() {
    for (const el of fomoFeedCards.values()) el.remove();
    fomoFeedCards.clear();
    destroyMergedTracker();
    clearFomoFeedShifts();
  }

  let fomoFeedLastMode = null;
  let debugRenderAt = 0;
  function logTrackingRender(events = [], reason = 'rendered') {
    if (settings.debugLogging !== true || Date.now()-debugRenderAt < 5000) return;
    debugRenderAt=Date.now();
    const received=fomoFollowedEvents.length;
    const eligible=events.filter(e=>e.source==='fomo-followed').length;
    const placed=[...fomoFeedCards.values()].filter(el=>el.isConnected && el.dataset.gdhFeedSource==='fomo-followed').length;
    try { chrome.runtime.sendMessage({type:'debug-render',fields:{source:'gmgn',reason,received,eligible,placed,
      filtered:Math.max(0,received-eligible),missingProfiles:fomoFollowedEvents.filter(e=>!e.handle).length,
      missingSymbols:fomoFollowedEvents.filter(e=>!e.symbol).length,missingMC:fomoFollowedEvents.filter(e=>!e.mc).length,
    }},()=>{ void chrome.runtime.lastError; }); } catch {}
  }

  function scanFomoFeed() {
    if (!settings.enabled) {
      teardownFomoFeed();
      logTrackingRender([], 'disabled');
      return;
    }
    if (settings.enableFomoFeed === false) {
      teardownFomoFeed();
      collapseBlockedTrackerRows();
      logTrackingRender([], 'disabled');
      return;
    }
    const mode = isTrackerTableMode() ? 'table' : 'card';
    if (fomoFeedLastMode !== null && fomoFeedLastMode !== mode) teardownFomoFeed();
    fomoFeedLastMode = mode;
    if (settings.enableFomoFeed !== false && Date.now() - fomoFollowedLastPollAt > FOMO_FEED_POLL_MS) pollFomoFollowedFeed();

    const cards = trackerCards().filter((c) => c.isConnected);
    const events = visibleTrackingFeedEvents(nativeTrackingFeedRows(cards));
    if (!events.length) {
      teardownFomoFeed();
      collapseBlockedTrackerRows();
      logTrackingRender(events, cards.length ? 'filtered' : 'no-native-rows');
      return;
    }

    if (!renderMergedTracker(cards, events)) {
      teardownFomoFeed();
      logTrackingRender(events, 'no-native-rows');
      return;
    }
    logTrackingRender(events);
  }

  let mergedTracker = null;

  // Restore React-owned parentage before native layout handlers unmount the
  // recycler. Waiting for a mutation observer is too late for removeChild.
  window.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[data-icon="IconLayoutcard16pxRegular"], [data-icon="IconLayoutlist16pxRegular"]')) {
      teardownFomoFeed();
      scheduleTrackingFeedRender();
    }
  }, true);

  function destroyMergedTracker() {
    const m = mergedTracker;
    if (!m) return;
    mergedTracker = null;
    m.observer.disconnect();
    m.resize.disconnect();
    clearTimeout(m.pendingTimer);
    m.viewport.removeEventListener('wheel', m.onWheel);
    m.viewport.style.cssText = m.originalStyle;
    if (m.viewport.parentElement === m.surface) {
      m.surface.before(m.viewport);
    }
    m.surface.remove();
    clearFomoFeedShifts();
  }

  function syncMergedTracker() {
    const m = mergedTracker;
    if (!m || !m.surface.isConnected) return;
    // The pinned absolute native viewport participates in CSS scroll overflow.
    // If its old top survives a shrinking snapshot (especially an evicted FOMO
    // anchor), it fabricates blank history below the real merged extent.
    const maxY = Math.max(0, Number.parseFloat(m.extent.style.height) - m.surface.clientHeight) || 0;
    const y = Math.min(m.surface.scrollTop, maxY);
    m.viewport.style.top = `${y}px`;
    if (m.surface.scrollTop > maxY + .5) m.surface.scrollTop = y;
    // Invert the insertion map. While traversing an inserted run, pin the host
    // at its native boundary instead of asking it for a nonexistent native index.
    let nativeY = y;
    let added = 0;
    for (const slot of m.slots) {
      if (y < slot.top) break;
      if (y < slot.top + slot.height) { nativeY = slot.at; break; }
      added += slot.height;
      nativeY = y - added;
    }
    m.viewport.style.height = `${m.surface.clientHeight}px`;
    // Translated pool rows may enlarge native scrollHeight too; the complete
    // native index, not that transient visual overflow, owns native coordinates.
    m.viewport.scrollTop = Math.max(0, Math.min(nativeY, m.stamps.length * m.h - m.surface.clientHeight));
    const delta = y - m.viewport.scrollTop;
    for (const el of [...fomoFeedShifted.keys()]) if (!el.isConnected) fomoFeedShifted.delete(el);
    const rows = trackerCards().map(fomoFeedFixedRow).filter(row => row && row.wrap.parentElement === m.spacer);
    for (const row of rows) {
      const before = m.slots.reduce((sum, slot) => sum + (slot.at <= row.top + .25 ? slot.height : 0), 0);
      // Blocking still hides native cards. Keep their index-sized gap here:
      // partial visible-only compaction would overlap the interleaved rows.
      setFomoFeedRowShift(row.wrap, before - delta);
    }
  }

  // The bridge stamps committed rows asynchronously after React reuses them.
  // Retain only an already validated adapter during that bounded handoff; a
  // genuinely unknown geometry/index must never bootstrap from visible samples.
  function deferMergedTrackerValidation(spacer) {
    const m = mergedTracker;
    if (!m || m.spacer !== spacer || !m.surface.isConnected || !spacer.isConnected) return false;
    if (!m.pendingSince) {
      m.pendingSince = performance.now();
      m.pendingTimer = setTimeout(() => {
        m.pendingTimer = 0;
        if (mergedTracker === m) scanFomoFeed();
      }, 1500);
    }
    if (performance.now() - m.pendingSince >= 1500) return false;
    syncMergedTracker();
    return true;
  }

  function mergedNativeIdentity(row) {
    return row?.tx ? JSON.stringify([row.tx, row.addr, row.chain, row.side, row.ts]) : '';
  }

  function mergedTrackerAnchor(m) {
    if (!m?.stamps || m.surface.scrollTop <= 1) return null;
    const y = m.surface.scrollTop;
    let added = 0;
    for (const slot of m.slots) {
      if (y < slot.top) break;
      if (y < slot.top + slot.height) return { key:slot.key, offset:y-slot.top };
      added += slot.height;
    }
    const index = Math.min(m.stamps.length - 1, Math.floor((y-added)/m.h));
    return { index, offset:y-added-index*m.h, stamps:m.stamps, nativeKey:mergedNativeIdentity(m.nativeRows?.[index]) };
  }

  function renderMergedTracker(cards, events) {
    const first = cards.map(fomoFeedFixedRow).find(Boolean);
    if (!first) return deferMergedTrackerValidation(mergedTracker?.spacer);
    const spacer = first.wrap.parentElement;
    let stamps;
    try { stamps = JSON.parse(spacer.getAttribute('data-gdh-native-index')); } catch { return false; }
    // Full index ownership is mandatory. Unknown host layouts fail closed rather
    // than silently losing native rows or pretending visible samples are history.
    if (!Array.isArray(stamps) || !stamps.length || stamps.length > 10000
      || !stamps.every((t, i) => Number.isFinite(t) && t > 0 && (!i || stamps[i - 1] >= t))) return false;
    const h = first.h;
    let pending = false;
    if (mergedTracker?.spacer === spacer && Math.abs(mergedTracker.h - h) > .5) return false;
    for (const card of cards) {
      const row = fomoFeedFixedRow(card);
      if (!row || row.wrap.parentElement !== spacer || Math.abs(row.h - h) > .5) return false;
      const index = Math.round(row.top / h);
      if (Math.abs(index * h - row.top) > .5 || index < 0 || index >= stamps.length) return false;
      // GMGN may leave overscan metadata stale indefinitely. Its complete index
      // still owns those slots; validate card stamps when the native slot enters
      // the viewport, not while an off-screen recycled row is parked in the pool.
      const viewport = mergedTracker?.spacer === spacer ? mergedTracker.viewport : spacer.parentElement;
      const inNativeViewport = row.top + h > viewport.scrollTop
        && row.top < viewport.scrollTop + viewport.clientHeight;
      if (inNativeViewport && stamps[index] !== Number(card.dataset.gdhTrackTs)) pending = true;
    }
    if (pending) return deferMergedTrackerValidation(spacer);
    if (mergedTracker && (mergedTracker.spacer !== spacer || !mergedTracker.surface.isConnected)) destroyMergedTracker();
    if (!mergedTracker) {
      let viewport = spacer.parentElement;
      while (viewport && viewport !== document.body && !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
      if (!viewport || viewport === document.body) return false;
      const originalStyle = viewport.style.cssText;
      const surface = document.createElement('div');
      surface.className = 'gdh-merged-tracker';
      surface.tabIndex = 0;
      surface.setAttribute('aria-label', 'GMGN and FOMO chronological activity');
      surface.style.height = `${viewport.clientHeight}px`;
      viewport.before(surface);
      surface.append(viewport);
      const extent = document.createElement('div');
      extent.className = 'gdh-merged-tracker__extent';
      surface.append(extent);
      viewport.style.cssText += ';position:absolute;left:0;top:0;width:100%;overflow:hidden;overflow-anchor:none;min-height:0;';
      const observer = new MutationObserver(records => {
        // Observe in-place pool reuse, not just child replacement. Ignore our
        // own translate writes so observing style cannot create a render loop.
        if (mergedTracker?.spacer !== spacer) return;
        const changed = records.map(record => {
          if (record.attributeName !== 'style') return true;
          const el = record.target;
          const geometry = `${el.style.transform}|${el.style.top}|${el.style.height}|${el.style.position}`;
          const previous = mergedTracker.geometry.get(el);
          mergedTracker.geometry.set(el, geometry);
          const shift = fomoFeedShifted.get(el);
          return previous !== geometry || (shift && el.style.translate !== `0px ${shift.amount}px`);
        }).some(Boolean);
        if (!changed) return;
        scheduleTrackingFeedRender();
        syncMergedTracker();
      });
      observer.observe(spacer, { childList:true, subtree:true, attributes:true, attributeFilter:['style','data-gdh-native-index','data-gdh-native-rows','data-gdh-track-ts','data-gdh-token-blocked'] });
      const resize = new ResizeObserver(() => { syncMergedTracker(); scheduleTrackingFeedRender(); });
      resize.observe(surface);
      mergedTracker = { surface, extent, viewport, spacer, originalStyle, observer, resize, slots:[], index:'', geometry:new WeakMap(), h };
      surface.addEventListener('scroll', syncMergedTracker, { passive:true });
      mergedTracker.onWheel = event => {
        if (mergedTracker?.viewport !== viewport) return;
        event.preventDefault();
        surface.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1);
      };
      viewport.addEventListener('wheel', mergedTracker.onWheel, { passive:false });
    }
    const m = mergedTracker;
    const anchor = mergedTrackerAnchor(m);
    clearTimeout(m.pendingTimer);
    m.pendingTimer = 0;
    m.pendingSince = 0;
    m.stamps = stamps;
    m.nativeRows = null;
    try {
      const rows = JSON.parse(spacer.getAttribute('data-gdh-native-rows'));
      if (Array.isArray(rows) && rows.length === stamps.length && rows.every((row,i) => row?.ts === stamps[i])) m.nativeRows = rows;
    } catch { /* Timestamp overlap remains the fallback for older bridges. */ }
    m.h = h;
    m.index = spacer.getAttribute('data-gdh-native-index');
    const wanted = new Set(events.map(ev => ev.key));
    for (const [key, el] of fomoFeedCards) if (!wanted.has(key)) { m.resize.unobserve(el); el.remove(); fomoFeedCards.delete(key); }
    m.slots = [];
    let added = 0;
    const tableMode = isTrackerTableMode();
    // Batch DOM writes, then all height reads, then placement writes. Reading
    // native mode/geometry between every card used to force O(events) layouts,
    // delaying the native recycling/stamp handoff past otherwise idle frames.
    const entries = [...events].sort((a,b) => b.ts - a.ts).map(ev => {
      let index = stamps.findIndex(ts => ts < ev.ts);
      if (index < 0) index = stamps.length;
      const el = fomoFeedCardFor(ev, tableMode);
      if (el.parentElement !== m.extent) m.extent.append(el);
      m.resize.observe(el);
      el.style.position = 'absolute';
      el.style.width = '100%';
      return { ev, el, at:index * h };
    });
    const heights = entries.map(({el}) => el.getBoundingClientRect().height);
    entries.forEach(({ev, el, at},i) => {
      const height = heights[i];
      const top = `${at + added}px`;
      if (el.style.top !== top) el.style.top = top;
      m.slots.push({ key:ev.key, at, top:at + added, height });
      added += height;
    });
    m.extent.style.height = `${stamps.length * h + added}px`;
    if (anchor?.key) {
      const slot = m.slots.find(slot => slot.key === anchor.key);
      if (slot) m.surface.scrollTop = slot.top + Math.min(anchor.offset, slot.height);
    } else if (anchor) {
      // Match a contiguous overlap rather than indexOf(timestamp): native
      // timestamps need not be unique. Ambiguous/evicted anchors stay put.
      const candidates = [];
      let comparisons = 0;
      if (anchor.nativeKey && m.nativeRows) {
        m.nativeRows.forEach((row,index) => { if (mergedNativeIdentity(row) === anchor.nativeKey) candidates.push(index); });
      }
      // An actual native identity outranks ambiguous same-second timestamps.
      // If that identity was evicted or has several legs, never pick a random
      // timestamp neighbour as a substitute.
      for (let index = 0; !(anchor.nativeKey && m.nativeRows) && index < stamps.length; index++) {
        if (stamps[index] !== anchor.stamps[anchor.index]) continue;
        const shift = index - anchor.index;
        const from = Math.max(0, -shift), to = Math.min(anchor.stamps.length, stamps.length-shift);
        if (to-from >= Math.min(3, anchor.stamps.length)
          && anchor.stamps.slice(from,to).every((ts,i) => ++comparisons <= 30000 && stamps[from+i+shift] === ts)) candidates.push(index);
        if (comparisons > 30000 || candidates.length > 1) break;
      }
      if (comparisons <= 30000 && candidates.length === 1) {
        const at = candidates[0] * h;
        m.surface.scrollTop = at + anchor.offset + m.slots.reduce((sum,slot) => sum+(slot.at<=at+.25 ? slot.height : 0),0);
      }
    }
    syncMergedTracker();
    return true;
  }

  function collapseBlockedTrackerRows() {
    refreshFomoFeedFixedRowShifts();
  }

  let lastFullScanAt = 0;
  let scanCostEma = 0;

  function scanVisibleCards() {
    const gap = scanCostEma > 50 ? 3000 : scanCostEma > 25 ? 2000 : 900;
    const now = Date.now();
    if (now - lastFullScanAt < gap) return;
    lastFullScanAt = now;
    const t0 = performance.now();
    const parts = [];
    const timed = (name, fn) => {
      const s0 = performance.now();
      fn();
      const ms = performance.now() - s0;
      if (ms >= 1) parts.push([name, ms]);
    };
    timed('trench', () => document.querySelectorAll(CARD_SELECTOR).forEach(applyCardState));
    timed('callout', scanCalloutBlacklist);
    timed('special', scanSpecialWallets);
    timed('marked', () => { try { scanMarkedBadges(); } catch {  } });
    timed('lightning', scanFrontrunLightning);
    timed('remind', scanRemindToasts);
    timed('surge', scanHoldingSurge);
    timed('fomoPanel', scanFomoPanel);
    timed('fomoFeed', scanFomoFeed);
    const cost = performance.now() - t0;
    scanCostEma = scanCostEma ? scanCostEma * 0.7 + cost * 0.3 : cost;
    //   document.documentElement.getAttribute('data-gdh-perf')
    const top = parts.sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([n, ms]) => `${n}:${Math.round(ms)}`).join(',');
    try { document.documentElement.setAttribute('data-gdh-perf', `${Math.round(cost)}|${Math.round(scanCostEma)}|${top}`); } catch {  }
  }

  let scanRafId = 0;
  let scanDelayTimer = 0;
  let lastScanAt = 0;
  let scrollingUntil = 0;
  const SCAN_MIN_GAP_SCROLLING = 120;

  function runScheduledScan() {
    scanRafId = 0;
    const now = Date.now();
    if (now < scrollingUntil && now - lastScanAt < SCAN_MIN_GAP_SCROLLING) {
      if (!scanDelayTimer) {
        const wait = Math.max(1, SCAN_MIN_GAP_SCROLLING - (now - lastScanAt));
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

  function scheduleScrollScan(event) {
    scrollingUntil = Date.now() + 200;

    const target = event.target;
    let trackingScroll = target instanceof Element && fomoFeedScrollTargets.has(target);
    if (!trackingScroll && target instanceof Element
      && (target.querySelector(TRACKER_ITEM_SELECTOR) || target.querySelector(TRACKER_SYMBOL_CELL))) {
      fomoFeedScrollTargets.add(target);
      trackingScroll = true;
    }
    if (trackingScroll) {
      scheduleFomoFeedRowReflow();
    }
    if (!(target instanceof Element)
      || (!target.closest('[data-sentry-component="PumpSubX"]')
        && !target.closest('[data-testid="trench-token-card"]'))) {
      window.clearTimeout(scrollScanTimer);
      scrollScanTimer = window.setTimeout(() => {
        scrollScanTimer = 0;
        scheduleScan();
      }, 180);
      return;
    }

    window.clearTimeout(scrollScanTimer);
    scrollScanTimer = window.setTimeout(() => {
      scrollScanTimer = 0;
      scheduleScan();
    }, 100);
  }

  function ensureTooltip() {
    if (tooltip) return tooltip;

    tooltip = document.createElement('div');
    tooltip.className = 'gdh-tooltip';
    tooltip.setAttribute('role', 'tooltip');

    const title = document.createElement('div');
    title.className = 'gdh-tooltip__title';
    title.dataset.field = 'title';
    tooltip.appendChild(title);

    const address = document.createElement('div');
    address.className = 'gdh-tooltip__address';
    address.dataset.field = 'address';
    tooltip.appendChild(address);

    const fields = [
      ['Developer migrated tokens', 'migrated'],
      ['Developer launches', 'total'],
      ['Developer migration rate', 'ratio'],
    ];
    for (const [labelText, field] of fields) {
      const row = document.createElement('div');
      row.className = 'gdh-tooltip__row';
      const label = document.createElement('span');
      label.textContent = labelText;
      const value = document.createElement('strong');
      value.dataset.field = field;
      row.append(label, value);
      tooltip.appendChild(row);
    }

    document.body.appendChild(tooltip);
    return tooltip;
  }

  function setTooltipField(field, value) {
    ensureTooltip().querySelector(`[data-field="${field}"]`).textContent = value;
  }

  function fillTooltip(card) {
    const label = card.dataset.gdhWatchLabel;
    const symbol = card.dataset.gdhSymbol;
    setTooltipField('title', label || symbol || 'Watched developer');
    setTooltipField('address', card.dataset.gdhCreator || '--');
    setTooltipField('migrated', formatCount(card.dataset.gdhMigrated));
    setTooltipField('total', formatCount(card.dataset.gdhTotal));
    setTooltipField('ratio', formatRatio(card));
  }

  function positionTooltip(event) {
    if (!tooltip || !tooltip.classList.contains('gdh-tooltip--visible')) return;
    const gap = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + rect.width + 10 > window.innerWidth) left = event.clientX - rect.width - gap;
    if (top + rect.height + 10 > window.innerHeight) top = event.clientY - rect.height - gap;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function findWatchedCard(target) {
    if (settings.showDevTooltip === false || !(target instanceof Element)) return null;
    const trigger = target.closest('.gdh-dev-performance');
    return trigger?.closest(`${CARD_SELECTOR}[data-gdh-watched="1"]`) || null;
  }

  function hideTooltip() {
    activeCard = null;
    tooltip?.classList.remove('gdh-tooltip--visible');
  }

  function suppressTooltipUntilPointerExit() {
    if (!activeCard) return;
    suppressedTooltipCard = activeCard;
    hideTooltip();
  }

  function dismissTooltipForLifecycle() {
    suppressedTooltipCard = null;
    hideTooltip();
  }

  function handleTooltipPointerMove(event) {
    const card = findWatchedCard(event.target);
    if (suppressedTooltipCard) {
      if (card === suppressedTooltipCard) return;
      if (!suppressedTooltipCard.isConnected && card) {
        suppressedTooltipCard = card;
        return;
      }
      suppressedTooltipCard = null;
    }
    if (!activeCard) {
      if (card) showTooltipForCard(card, event);
      return;
    }
    if (!activeCard.isConnected || card !== activeCard) {
      hideTooltip();
      return;
    }
    positionTooltip(event);
  }

  function handleTooltipScroll(event) {
    dismissTooltipForLifecycle();
    scheduleScrollScan(event);
  }

  function showTooltipForCard(card, event) {
    activeCard = card;
    fillTooltip(card);
    ensureTooltip().classList.add('gdh-tooltip--visible');
    positionTooltip(event);
  }

  document.addEventListener(
    'pointerover',
    (event) => {
      const card = findWatchedCard(event.target);
      if (!card) { dismissTooltipForLifecycle(); return; }
      if (suppressedTooltipCard) {
        if (card === suppressedTooltipCard) return;
        if (!suppressedTooltipCard.isConnected) {
          suppressedTooltipCard = card;
          return;
        }
        suppressedTooltipCard = null;
      }
      if (card === activeCard) return;
      showTooltipForCard(card, event);
    },
    true,
  );

  document.addEventListener(
    'pointerout',
    (event) => {
      if (suppressedTooltipCard) {
        const leavingSuppressedCard = findWatchedCard(event.target);
        if (leavingSuppressedCard === suppressedTooltipCard
          && !(event.relatedTarget instanceof Node && suppressedTooltipCard.contains(event.relatedTarget))) {
          suppressedTooltipCard = null;
          const enteringCard = findWatchedCard(event.relatedTarget);
          if (enteringCard) showTooltipForCard(enteringCard, event);
        }
      }
      if (!activeCard) return;
      if (event.relatedTarget instanceof Node && activeCard.contains(event.relatedTarget)) return;
      const leavingCard = findWatchedCard(event.target);
      if (leavingCard !== activeCard) return;
      hideTooltip();
    },
    true,
  );

  document.addEventListener('pointerdown', suppressTooltipUntilPointerExit, true);
  document.addEventListener('pointermove', handleTooltipPointerMove, true);
  document.addEventListener('scroll', handleTooltipScroll, true);
  window.addEventListener('blur', dismissTooltipForLifecycle);

  const GDH_SELF_SELECTOR = '[data-gdh-fomo-key], .gdh-marked, .gdh-remind-card, .gdh-notification-launcher, .gdh-notification-panel, .gdh-fomo, .gdh-fomo-panel, .gdh-fomo-ui, .gdh-fomo-feed-gap, .gdh-fomofeed-lane, .gdh-tooltip, .gdh-tokenblock';
  const observer = new MutationObserver((records) => {
    if (activeCard && !activeCard.isConnected) hideTooltip();
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target?.parentElement;
      if (target && target.closest(GDH_SELF_SELECTOR)) continue;
      scheduleFomoFeedRowReflow();
      scheduleScan();
      return;
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-gdh-creator',
      'data-gdh-migrated',
      'data-gdh-total',
      'data-gdh-ratio',
      'data-gdh-symbol',
      'data-gdh-ready',
      'data-gdh-caller-ready',
      'data-gdh-caller-wallet',
      'data-gdh-caller-handle',
      'data-gdh-caller-name',
      'href',
    ],
  });

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildBlockedTokenIndex();
    rebuildSpecialWalletSet();
    rebuildHoldingWatch();
    scheduleScan();
  });

  chrome.storage.local.get({
    [NOTIFICATION_HISTORY_KEY]: [],
    [NOTIFICATION_HISTORY_READ_AT_KEY]: 0,
  }, (stored) => {
    notificationHistory = normalizedNotificationHistory(stored[NOTIFICATION_HISTORY_KEY]);
    notificationHistoryReadAt = Number(stored[NOTIFICATION_HISTORY_READ_AT_KEY]) || 0;
    scheduleScan();
  });

  chrome.storage.local.get({ holdingWatchPurgedV1: false }, (stored) => {
    if (stored.holdingWatchPurgedV1) return;
    settings.holdingWatchList = [];
    holdingWatchMap = new Map();
    chrome.storage.local.set({ holdingWatchList: [], holdingWatchPurgedV1: true });
  });

  chrome.storage.local.get({ markedHolders: null, markedListMigratedV2: false }, (stored) => {
    if (stored.markedListMigratedV2 || !Array.isArray(stored.markedHolders)) return;
    const list = stored.markedHolders.slice();
    const have = new Set(list.map((x) => String(x?.address || '').toLowerCase()));
    for (const def of DEFAULTS.markedHolders) {
      if (!have.has(def.address.toLowerCase())) list.push({ ...def });
    }
    const afeng = list.find((x) => String(x?.address || '').toLowerCase() === '0xbf004bff64725914ee36d03b87d6965b0ced4903');
    if (afeng && afeng.name === '\u963f\u5cf0') afeng.name = 'Afeng Main 1';
    chrome.storage.local.set({ markedHolders: list, markedListMigratedV2: true });
  });

  function fomoStoredAccountIdentity(record) {
    const token = String(record?.token || '');
    const payload = token.split('.')[1] || '';
    if (!payload) return '';
    try {
      const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(Math.ceil(payload.length / 4) * 4, '=');
      const body = JSON.parse(atob(padded));
      return String(body?.sub || body?.userId || body?.uid || body?.did || '').trim();
    } catch {
      return '';
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.keys(changes).every(key=>key==='gdhDebugLogV1')) return;
    let fomoTokenChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key === 'gdhDebugLogV1') continue;
      if (key === 'fomoToken') {
        const oldIdentity = fomoStoredAccountIdentity(change.oldValue);
        const newIdentity = fomoStoredAccountIdentity(change.newValue);
        const sameAccount = oldIdentity && newIdentity && oldIdentity === newIdentity;
        fomoUiAuthGeneration += 1;
        fomoFollowedRevision += 1;
        fomoFollowedUpdatedAt = 0;
        void updateFomoFollowedEpoch(change.newValue);
        resetFomoUi(!sameAccount);
        fomoPnlCache.clear();
        renderFomoFollowedGap(null);
        fomoTokenChanged = true;
        fomoLoadGeneration += 1;
        fomoLoadInflight = null;
        fomoFollowedHoldersGeneration += 1;
        fomoFollowedHoldersByChain.clear();
        fomoFollowedHoldersInflight.clear();
        fomoFollowedHoldersFailures.clear();
        fomoFollowedEvents = [];
        fomoFollowedLastPollAt = 0;
        // Remove old-account cards immediately; a throttled scan can lag seconds.
        for (const [key, card] of fomoFeedCards) {
          if (!card.classList.contains('is-followed')) continue;
          card.remove();
          fomoFeedCards.delete(key);
        }
        scheduleFomoFollowedRender();
        fomoLoadedKey = '';
        fomoErrKey = '';
        fomoLastItems = [];
        fomoStats = { key: '', holders: null, thesisCount: null, supply: 0 };
        renderFomoStats();
        continue;
      }
      if (key === 'markedListMigratedV2') continue;
      if (key === 'holdingWatchPurgedV1') continue;
      if (key === 'gmgnHoldingSignalSyncState') continue;
      if (key === NOTIFICATION_HISTORY_KEY) {
        notificationHistory = normalizedNotificationHistory(change.newValue);
        renderNotificationPanel();
        continue;
      }
      if (key === NOTIFICATION_HISTORY_READ_AT_KEY) {
        notificationHistoryReadAt = Number(change.newValue) || 0;
        continue;
      }
      if (key === 'fomoTranslate') {
        applyFomoTranslationSetting(change.newValue);
        teardownFomoFeed();
        continue;
      }
      settings[key] = change.newValue;
    }
    if (fomoTokenChanged && fomoPanelEl) {
      loadFomoData(true);
    }
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildBlockedTokenIndex();
    rebuildSpecialWalletSet();
    rebuildHoldingWatch();
    scheduleScan();
  });

  const initialFomoFollowedGeneration = fomoUiAuthGeneration;
  chrome.storage.local.get('fomoToken', stored => {
    if (initialFomoFollowedGeneration === fomoUiAuthGeneration) void updateFomoFollowedEpoch(stored?.fomoToken);
  });

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'fomo-followed-feed-update') {
        if (!canDisplayFomoFollowedFeed()) return;
        if (!msg.epoch) { pollFomoFollowedFeed(); return; }
        if (!fomoFollowedEpoch || msg.epoch !== fomoFollowedEpoch) return;
        if (!msg.data || (Number(msg.data.updatedAt) && Number(msg.data.updatedAt) < fomoFollowedUpdatedAt)) return;
        applyFomoFollowedResponse(msg.data);
        return;
      }
    });
  } catch {
  }

  window.setInterval(() => {
    if (document.visibilityState !== 'hidden') {
      if (Date.now() - fomoFollowedLastPollAt >= FOMO_FEED_POLL_MS) pollFomoFollowedFeed();
      refreshFomoFeedTimes();
      scanVisibleCards();
    }
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dismissTooltipForLifecycle();
    else { scheduleFomoFollowedRender(); scheduleTrackingFeedRender(); scheduleScan(); }
  });
})();
