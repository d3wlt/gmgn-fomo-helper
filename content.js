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


  if (/(^|\.)985monitor\.xyz$/.test(location.hostname)) {
    const readJson = (key, fallback) => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || fallback);
        return parsed == null ? JSON.parse(fallback) : parsed;
      } catch {
        return JSON.parse(fallback);
      }
    };
    const storageGet = (defaults) => new Promise((resolve) => {
      try { chrome.storage.local.get(defaults, resolve); } catch { resolve(defaults); }
    });
    const storageSet = (values) => new Promise((resolve) => {
      try { chrome.storage.local.set(values, resolve); } catch { resolve(); }
    });
    const accountKey = (value) => (/^0x/i.test(String(value || ''))
      ? String(value || '').toLowerCase() : String(value || ''));
    const pageAuth = () => {
      try {
        const wallet = String(window.localStorage.getItem('xMonitorWalletAddress') || '').trim();
        const token = String(window.localStorage.getItem('xMonitorWalletToken') || '').trim();
        return { wallet, token };
      } catch {
        return { wallet: '', token: '' };
      }
    };
    const pagePrefs = () => {
      let fomoMuted = readJson('xMonitorFomoMutedV1', '[]');
      let fomoPrefs = readJson('xMonitorFomoPrefsV1', '{}');
      let pumpMuted = readJson('xMonitorPumpMutedV1', '[]');
      let pumpPrefs = readJson('xMonitorPumpPrefsV1', '{}');
      if (!Array.isArray(fomoMuted)) fomoMuted = [];
      if (!fomoPrefs || typeof fomoPrefs !== 'object' || Array.isArray(fomoPrefs)) fomoPrefs = {};
      if (!Array.isArray(pumpMuted)) pumpMuted = [];
      if (!pumpPrefs || typeof pumpPrefs !== 'object' || Array.isArray(pumpPrefs)) pumpPrefs = {};
      let onlyMine = true;
      try { onlyMine = window.localStorage.getItem('xMonitorPumpOnlyMineV1') !== 'false'; } catch {}
      return {
        fomo: { muted: fomoMuted, prefs: fomoPrefs },
        pump: { muted: pumpMuted, prefs: pumpPrefs, onlyMine },
      };
    };
    const applyAccountConfig = async (config, session) => {
      if (!config?.connected || !config?.account?.userId) return;
      const at = Date.now();
      const expiresAt = Number(session?.expiresAt || config.sessionExpiresAt) || 0;
      await storageSet({
        monitorFomoConfig: { ...(config.fomo || {}), wallet: config.account.userId, connected: true, revision: config.revision, at },
        monitorPumpConfig: { ...(config.pump || {}), wallet: config.account.userId, connected: true, revision: config.revision, at },
        monitor985SyncStateV1: {
          connected: true,
          accountId: config.account.userId,
          displayName: String(config.account.displayName || ''),
          syncedAt: at,
          expiresAt,
        },
      });
    };
    const pageHeaders = ({ wallet, token }) => ({
      'Content-Type': 'application/json',
      'X-User-Id': wallet,
      'X-User-Token': token,
      'X-Wallet-Address': wallet,
    });
    let syncInflight = null;
    let lastPrefsStamp = '';
    let lastFullSyncAt = 0;
    const syncAccount = async (force = false) => {
      if (syncInflight) return syncInflight;
      syncInflight = (async () => {
        const auth = pageAuth();
        const stored = await storageGet({ monitor985SessionV1: null, monitor985ClientIdV1: '', monitor985SyncStateV1: null });
        let clientId = String(stored.monitor985ClientIdV1 || '').trim();
        if (!clientId) {
          clientId = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID() : `chrome-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          await storageSet({ monitor985ClientIdV1: clientId });
        }
        const session = stored.monitor985SessionV1;
        const sameAccount = accountKey(session?.accountId) === accountKey(auth.wallet);
        const sessionFresh = sameAccount && session?.token && Number(session.expiresAt) > Date.now() + 24 * 60 * 60 * 1000;
        if (!auth.wallet || !auth.token) {
          if (!sessionFresh) {
            await storageSet({ monitor985SyncStateV1: { connected: false, reason: 'login-required', checkedAt: Date.now() } });
          }
          return;
        }
        const prefs = pagePrefs();
        const prefsStamp = JSON.stringify(prefs);
        const needsRebind = !sessionFresh || stored.monitor985SyncStateV1?.reason === 'unauthorized';
        const periodic = Date.now() - lastFullSyncAt >= 3 * 60 * 1000;
        if (!force && !needsRebind && prefsStamp === lastPrefsStamp && !periodic) return;
        const endpoint = needsRebind ? '/api/extension/session' : '/api/extension/prefs';
        const payload = needsRebind ? { clientId, prefs } : { prefs };
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: pageHeaders(auth),
          cache: 'no-store',
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.ok !== true || !body?.config) {
          if (response.status === 401) {
            await storageSet({ monitor985SyncStateV1: { connected: false, reason: 'login-required', checkedAt: Date.now() } });
          }
          return;
        }
        let activeSession = session;
        if (body.session?.token) {
          activeSession = {
            token: body.session.token,
            clientId: body.session.clientId || clientId,
            expiresAt: Number(body.session.expiresAt) || 0,
            accountId: body.config.account.userId,
          };
          await storageSet({ monitor985SessionV1: activeSession });
        }
        await applyAccountConfig(body.config, activeSession);
        lastPrefsStamp = prefsStamp;
        lastFullSyncAt = Date.now();
        try {
          chrome.runtime.sendMessage({ type: '985-monitor-session-updated' }, () => void chrome.runtime.lastError);
        } catch {}
      })().catch(() => {
      }).finally(() => { syncInflight = null; });
      return syncInflight;
    };
    syncAccount(true);
    window.setInterval(() => syncAccount(false), 15000);
    window.addEventListener('focus', () => syncAccount(true));
    window.addEventListener('storage', () => syncAccount(false));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncAccount(false);
    });
    return;
  }

  const CARD_SELECTOR =
    '[data-testid="trench-token-card"], [data-sentry-source-file="TokenItem.tsx"][href*="/token/0x"]';
  const CALLOUT_SELECTOR = '[data-sentry-component="CalloutItem"]';
  const MANIFESTO_SELECTOR = '[data-sentry-component="ManifestoChipInner"]';
  const DEFAULTS = {
    enabled: true,
    showDevPerformance: true,
    showDevTooltip: true,
    enableDevBookmark: true,
    enableCalloutBlacklist: true,
    enableManifestoToast: true,
    enableManifestoTab: true,
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
    enableFlapTax: true,
    flapRpc: '',
    enableFomoFeed: true,
    enablePumpFeed: true,
    fomoFeedChainOnly: false,
    fomoFeedTypes: { buy: true, sell: true, swap: true, thesis: true, transferIn: true, refund: true },
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

  function getDevAth(creator) {
    if (!creator) return null;
    const hit = devAthCache.get(creator);
    const fresh = hit
      && Date.now() - hit.at < (hit.ok ? DEV_ATH_TTL_MS : DEV_ATH_ERROR_RETRY_MS);
    if (!fresh && !devAthQueued.has(creator)) {
      devAthQueued.add(creator);
      devAthQueue.push(creator);
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
    const creator = devAthQueue.shift();
    if (!creator) return;
    let entry = { at: Date.now(), ok: false, mc: 0, symbol: '' };
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://gmgn.ai/api/v1/dev_created_tokens/bsc/${creator}?${DEV_ATH_QS}`,
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
    setBoundedMap(devAthCache, creator, entry, DEV_ATH_CACHE_MAX);
    devAthQueued.delete(creator);
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
    if (settings.showDevPerformance === false || !metricsRow || card.dataset.gdhReady !== '1') {
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

    const ath = getDevAth(normalizeAddress(card.dataset.gdhCreator));
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
        if (blacklistModalOpen) maniListOpen = false;
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

  const FLAP_ADDR_RE = /^0x[a-fA-F0-9]{36}(?:7777|8888)$/;
  const flapInfoCache = new Map();
  const flapPending = new Set();
  const flapRetry = new Map();
  const FLAP_RETRY_BASE = 8000;
  const FLAP_RETRY_MAX = 5;
  const FLAP_CACHE_MAX = 400;


  function flapMode(dist) {
    if (!dist) return { icon: '❓', name: 'Unknown', cls: 'unknown' };
    const vault = dist.vault.reduce((sum, x) => sum + x.bps, 0);
    const parts = [
      { bps: dist.dividendBps, icon: '💎', name: 'Holder rewards', cls: 'holder' },
      { bps: dist.lpBps, icon: '💧', name: 'Liquidity', cls: 'lp' },
      { bps: dist.deflationBps, icon: '🔥', name: 'Burn', cls: 'burn' },
      { bps: vault, icon: '🎁', name: 'Treasury/marketing', cls: 'gift' },
    ].filter((x) => x.bps > 0).sort((a, b) => b.bps - a.bps);
    if (!parts.length) return { icon: '❓', name: 'No allocation', cls: 'unknown' };
    if (parts.length > 1) return { icon: parts[0].icon, name: 'Mixed allocation', cls: 'hybrid', multi: parts.length };
    return parts[0];
  }

  const flapPct = (bps) => `${(Number(bps || 0) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`;
  const flapShort = (addr) => (addr && !/^0x0+$/.test(addr) ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—');



  function flapSym(sym) {
    const cleaned = String(sym || '').trim().replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
    if (!cleaned) return '';
    if (/[\u4e00-\u9fff]/.test(cleaned)) return cleaned.slice(0, 6);
    const raw = cleaned.toUpperCase();
    if (raw === 'WBNB') return 'BNB';
    return raw.slice(0, 4);
  }

  function flapSegPct(bps) {
    const n = Number(bps) || 0;
    if (n % 100 === 0) return `${n / 100}%`;
    return `${String((n / 100).toFixed(1)).replace(/\.0$/, '')}%`;
  }

  function flapBadgeText(info) {
    const d = info.dist;
    if (!d) return `🪙${flapSym(info.quoteSymbol)}`.trim() || '❓';
    const vaultBps = d.vault.reduce((a, b) => a + b.bps, 0);
    const segs = [
      { kind: 'holder', emoji: '💎', bps: d.dividendBps, pri: 0 },
      { kind: 'gift', emoji: '🎁', bps: vaultBps, pri: 1 },
      { kind: 'burn', emoji: '🔥', bps: d.deflationBps, pri: 3 },
      { kind: 'lp', emoji: '💧', bps: d.lpBps, pri: 4 },
    ].filter((x) => x.bps > 0).sort((a, b) => b.bps - a.bps || a.pri - b.pri);
    if (!segs.length) return `🪙${flapSym(info.quoteSymbol)}`.trim() || '❓';

    const top = segs[0].kind;
    const topSym = top === 'holder'
      ? flapSym(info.dividendSymbol)
      : (top === 'burn' ? '' : flapSym(info.quoteSymbol));
    const fee = segs.map((seg) => {
      const base = `${seg.emoji}${seg.bps === 10000 ? '' : flapSegPct(seg.bps)}`;
      return seg.kind === top && topSym ? `${base}→${topSym}` : base;
    }).join('');
    const pool = flapSym(info.quoteSymbol);
    return pool ? `🪙${pool} | ${fee}` : fee;
  }

  function flapTooltipText(info) {
    const d = info.dist;
    const pair = info.tokenSymbol && info.quoteSymbol
      ? `${info.tokenSymbol}/${info.quoteSymbol}` : '';
    const lines = [
      `Total tax ${flapPct(info.taxBps)} (buy ${flapPct(info.buyTaxBps)} / sell ${flapPct(info.sellTaxBps)})`,
    ];
    if (d) {
      lines.push('— Tax allocation —');
      if (d.dividendBps) {
        const sym = info.dividendSymbol ? `${info.dividendSymbol} ` : '';
        lines.push(`💎 Holder rewards ${flapPct(d.dividendBps)} · Asset ${sym}${flapShort(d.dividendToken)}`);
      }
      if (d.lpBps) lines.push(`💧 Liquidity ${flapPct(d.lpBps)}`);
      if (d.deflationBps) lines.push(`🔥 Burn ${flapPct(d.deflationBps)}`);
      d.vault.forEach((v, i) => {
        if (v.bps) lines.push(`🎁 Treasury${d.vault.length > 1 ? i + 1 : ''} ${flapPct(v.bps)} · ${flapShort(v.address)}`);
      });
      if (d.commissionBps) lines.push(`Platform fee ${flapPct(d.commissionBps)}`);
    }
    lines.push(`Pool ${pair ? pair + ' · ' : ''}${flapShort(info.mainPool)}`);
    lines.push('Read directly from the chain without a third-party service');
    return lines.join('\n');
  }


  function findNativeTaxChip(card) {
    return [...card.querySelectorAll('div,span')].find((el) => (
      el.children.length === 0 && /^Tax\s*[\d.]+%(\s*\/\s*[\d.]+%)?$/i.test((el.textContent || '').trim())
    )) || null;
  }


  function flapOwnRow(card, native) {
    let existing = card.querySelector(':scope .gdh-flap-row');
    if (existing) return existing;

    let anchor = native;
    if (anchor) {
      const cardWidth = card.getBoundingClientRect().width || 1;
      for (let level = 0; level < 4 && anchor.parentElement && anchor.parentElement !== card; level += 1) {
        anchor = anchor.parentElement;
        if (anchor.getBoundingClientRect().width > cardWidth * 0.6) break;
      }
    } else {
      anchor = card.children[1]?.firstElementChild?.firstElementChild || null;
    }
    if (!anchor || !anchor.parentElement) return null;

    card.dataset.gdhFlapRoom = '1';
    const line = document.createElement('div');
    line.className = 'gdh-flap-row';
    anchor.insertAdjacentElement('afterend', line);
    return line;
  }

  function flapTaxUrl(token) {
    if (!FLAP_ADDR_RE.test(token || '')) return '';
    return `https://flap.sh/bnb/${token.toLowerCase()}/taxinfo?lang=zh`;
  }

  function ensureFlapBadge(host, token, native) {
    const info = flapInfoCache.get(token);
    let badge = host.querySelector(':scope > .gdh-flap');
    if (!info || info.ok === false) {
      if (info && info.ok === false) {
        badge?.remove();
        if (native) native.style.removeProperty('display');
        host.dataset.gdhFlapFail = info.reason || 'unknown';
      }
      return;
    }
    delete host.dataset.gdhFlapFail;
    if (native && native.isConnected) native.style.setProperty('display', 'none', 'important');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'gdh-flap';
      badge.setAttribute('role', 'link');
      badge.setAttribute('tabindex', '0');
      const go = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const url = flapTaxUrl(badge.dataset.gdhFlapToken || '');
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      };
      badge.addEventListener('pointerdown', (event) => event.stopPropagation());
      badge.addEventListener('click', go);
      badge.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') go(event);
      });
      host.appendChild(badge);
    }
    const mode = flapMode(info.dist);
    badge.className = `gdh-flap is-${mode.cls}`;
    badge.dataset.gdhFlapToken = token;
    badge.textContent = flapBadgeText(info);
    badge.title = `${mode.name}
${flapTooltipText(info)}

Select to open Flap tax details`;
  }


  function requestFlapInfo(token) {
    if (flapPending.has(token)) return;
    const cached = flapInfoCache.get(token);
    if (cached) {
      if (cached.ok !== false || cached.reason === 'not-flap') return;
      const last = flapRetry.get(token);
      if (!last || last.tries >= FLAP_RETRY_MAX) return;
      if (Date.now() - last.at < FLAP_RETRY_BASE * 2 ** (last.tries - 1)) return;
    }
    if (flapPending.size >= 4) return;
    flapPending.add(token);
    chrome.runtime.sendMessage({
      type: 'flap-token-info',
      payload: { token, rpc: String(settings.flapRpc || '').trim() },
    }).then((res) => {
      setBoundedMap(flapInfoCache, token, res || { ok: false, reason: 'no-response' }, FLAP_CACHE_MAX);
      if (res?.ok || res?.reason === 'not-flap') {
        flapRetry.delete(token);
      } else {
        setBoundedMap(flapRetry, token, { at: Date.now(), tries: (flapRetry.get(token)?.tries || 0) + 1 }, FLAP_CACHE_MAX);
      }
    }).catch(() => {}).finally(() => {
      flapPending.delete(token);
      scheduleScan();
    });
  }


  function searchScopes() {
    const inputs = document.querySelectorAll(
      'input[placeholder*="\u5408\u7ea6\u5730\u5740"], input[placeholder*="\u4ee3\u7801"], input[placeholder*="Contract"], input[placeholder*="Search"]',
    );
    const scopes = new Set();
    inputs.forEach((input) => {
      let el = input.parentElement;
      for (let level = 0; level < 8 && el instanceof HTMLElement; level += 1) {
        if (el.querySelector('a[href*="/token/0x"]')) return void scopes.add(el);
        el = el.parentElement;
      }
    });
    return [...scopes];
  }

  function scanFlapBadges() {
    if (settings.enableFlapTax === false) {
      document.querySelectorAll('.gdh-flap').forEach((el) => el.remove());
      return;
    }
    const seen = new Set();
    const put = (host, token, native) => {
      if (!FLAP_ADDR_RE.test(token)) return;
      const key = token.toLowerCase();
      seen.add(key);
      requestFlapInfo(key);
      ensureFlapBadge(host, key, native);
    };

    document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
      const token = String(card.getAttribute('href') || '').match(/\/token\/(0x[a-fA-F0-9]{40})/)?.[1];
      if (!token) return;
      let row = card.dataset.gdhFlapKey === token ? card.querySelector(':scope .gdh-flap-row') : null;
      let native = null;
      if (!row) {
        card.dataset.gdhFlapKey = token;
        native = findNativeTaxChip(card);
        if (native) native.setAttribute('data-gdh-flap-native', '1');
        row = flapOwnRow(card, native);
      } else {
        native = card.querySelector('[data-gdh-flap-native]');
      }
      put(row || card, token, native);
    });


    searchScopes().forEach((scope) => {
      scope.querySelectorAll('a[href*="/token/0x"]').forEach((link) => {
        const token = link.getAttribute('href')?.match(/\/token\/(0x[a-fA-F0-9]{40})/)?.[1];
        if (!token) return;
        const native = findNativeTaxChip(link);
        put(flapOwnRow(link, native) || link, token, native);
      });
    });

    const route = currentTokenRoute();
    if (route && FLAP_ADDR_RE.test(route.address)) {
      const title = document.querySelector('h1, [class*="text-[20px]"], [class*="text-2xl"]');
      if (title) {
        let row = document.querySelector('.gdh-flap-row--detail');
        if (!row) {
          let anchor = title;
          let el = title.parentElement;
          for (let level = 0; level < 4 && el instanceof HTMLElement; level += 1) {
            const cs = getComputedStyle(el);
            if (cs.display.includes('flex') && !cs.flexDirection.includes('column')) {
              anchor = el;
              el = el.parentElement;
            } else break;
          }
          if (anchor.parentElement) {
            row = document.createElement('div');
            row.className = 'gdh-flap-row gdh-flap-row--detail';
            anchor.insertAdjacentElement('afterend', row);
          }
        }
        put(row || title, route.address);
      }
    }
  }

  const MARKED_TTL = 120000;
  let markedMap = new Map();
  const markedByChain = new Map();
  let markedLoading = false;

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
    const covered = new Set();
    try {
      const server = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'marked-holdings' }, (resp) => {
            resolve(chrome.runtime.lastError ? null : resp);
          });
        } catch {
          resolve(null);
        }
      });
      if (server?.ok && Array.isArray(server.holdings)) {
        const nameOf = new Map(people.map((p2) => [p2.address.toLowerCase(), p2.name]));
        for (const h of server.holdings) {
          if (h?.chain !== chain) continue;
          const person = String(h.a || '').toLowerCase();
          if (!nameOf.has(person)) continue;
          covered.add(person);
          if (!(Number(h.u) >= MARKED_MIN_USD)) continue;
          put(h.t, `${nameOf.get(person)}(${fomoUsd(h.u)})`);
        }
      }
    } catch {
    }
    const rest = people.filter((p2) => !covered.has(p2.address.toLowerCase()));
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
    const names = markedMap.get(String(tokenAddress).toLowerCase());
    let badge = host.querySelector(':scope > .gdh-marked');
    if (!names || !names.length) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'gdh-marked';
      host.appendChild(badge);
    }
    badge.textContent = `👤${names.length}`;
    badge.title = `Marked people holding this token: ${names.join(', ')}`;
  }

  function scanMarkedBadges() {
    if (settings.enableMarkedHolders === false) {
      document.querySelectorAll('.gdh-marked').forEach((el) => el.remove());
      return;
    }
    loadMarkedHoldings();
    if (!markedMap.size) return;

    trackerCards().forEach((card) => {
      const addr = card.dataset.gdhTrackAddr;
      if (!addr) return;
      const host = card.querySelector(TRACKER_SYMBOL_CELL);
      if (host) ensureMarkedBadge(host, addr);
      else { card.querySelector(':scope .gdh-marked')?.remove(); }
    });

    document.querySelectorAll('a[href*="/token/0x"]').forEach((link) => {
      if (link.closest(TRACKER_ITEM_SELECTOR)) return;
      if (link.querySelector(TRACKER_SYMBOL_CELL) || link.querySelector(TRACKER_MAKER_CELL)) return;
      const m = link.getAttribute('href')?.match(/\/token\/(0x[a-fA-F0-9]{40})/);
      if (!m) return;
      ensureMarkedBadge(link, m[1]);
    });
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
      timer = window.setTimeout(dismiss, REMIND_CARD_MS);
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    card.addEventListener('mouseenter', () => window.clearTimeout(timer));
    card.addEventListener('mouseleave', arm);
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
  let fomoLoading = false;

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

  function ensureNotificationLauncher() {
    let btn = document.querySelector('.gdh-notification-launcher');
    if (!currentTokenRoute()) {
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
      document.body.appendChild(btn);
    }
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

  function holderName(item) {
    const u = fomoUser(item);
    const handle = typeof u.userHandle === 'string' ? u.userHandle.trim() : '';
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
      chrome.runtime.sendMessage({ type: 'fomo-user-pnl', payload: { userId: job.userId } })
        .then((res) => {
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
      const row = document.createElement('div');
      row.className = 'gdh-fomo__item';

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

      const trade = item?.authorTrade;
      const pnl = Number(trade
        ? (trade.closedAt ? trade.realizedPnlUsd : (trade.realizedPnlUsd || 0) + (trade.unrealizedPnlUsd || 0))
        : (item?.pnlChange ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number')));
      if (Number.isFinite(pnl) && pnl !== 0) {
        const pnlEl = document.createElement('span');
        pnlEl.className = `gdh-fomo__pnl ${pnl >= 0 ? 'is-up' : 'is-down'}`;
        pnlEl.textContent = fomoUsd(pnl);
        head.appendChild(pnlEl);
      }
      const sizeUsd = Number(trade?.usdValue
        ?? item?.positionUsd ?? deepPick(item, /(amount|size|value|position)(usd)?$/i, 'number'));
      if (Number.isFinite(sizeUsd) && sizeUsd > 0) {
        const sz = document.createElement('span');
        sz.className = 'gdh-fomo__size';
        sz.textContent = fomoUsd(sizeUsd);
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


  async function buildFomoErrorBox(res) {
    const box = document.createElement('div');
    box.className = 'gdh-fomo__guide';
    let stored = null;
    try {
      const got = await chrome.storage.local.get('fomoToken');
      stored = got?.fomoToken || null;
    } catch {
    }
    const reason = res?.reason || 'unknown';
    if (reason === 'expired' && !fomoSelfHealTried) {
      fomoSelfHealTried = true;
      chrome.runtime.sendMessage({ type: 'fomo-force-refresh' })
        .then((r) => { if (r?.ok) { fomoLoadedKey = ''; fomoErrKey = ''; loadFomoData(true); } })
        .catch(() => {});
    }
    const needLogin = reason === 'no-token' || reason === 'expired';

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
      why.textContent = `${String(res?.message || 'Request failed').slice(0, 60)}. Check your network or proxy, then retry.`;
    } else {
      title.textContent = `Load failed (${reason}${res?.status ? ' / ' + res.status : ''})`;
      why.textContent = String(res?.message || 'Use this message to diagnose the failure.').slice(0, 90);
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
      fomoLoadedKey = '';
      fomoErrKey = '';
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
          payload: { chain: route.chain, address: route.address, rpc: settings.flapRpc || '', apiQuery },
        }).catch(() => null);
        if (fallback?.ok && fallback.supply > 0) supply = Number(fallback.supply);
      }

      if (supply > 0 && fomoStats.key === statKey) {
        fomoStats.supply = supply;
        renderFomoStats();
      }
    } finally {
      if (fomoSupplyLoadingKey === statKey) fomoSupplyLoadingKey = '';
    }
  }

  async function loadFomoData(force) {
    const route = currentTokenRoute();
    if (!route || !fomoPanelEl) return;
    const key = `${fomoTab}|${route.chain}|${route.address}`;
    if (!force && key === fomoLoadedKey) return;
    if (!force && key === fomoErrKey && Date.now() - fomoErrAt < FOMO_ERR_COOLDOWN) return;
    if (fomoLoading) return;
    fomoLoading = true;
    const list = fomoPanelEl.querySelector('.gdh-fomo__list');
    const keepingGuide = key === fomoErrKey && list.querySelector('.gdh-fomo__guide');
    if (key !== fomoLoadedKey && !keepingGuide) {
      list.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'gdh-fomo__empty';
      loading.textContent = 'Loading…';
      list.appendChild(loading);
    }
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'fomo-token-feed',
        payload: { tokenAddress: route.address, networkId: route.networkId, kind: fomoTab },
      });
      if (!fomoPanelEl) return;
      if (res?.ok) {
        fomoLoadedKey = key;
        fomoErrKey = '';
        fomoLastItems = res.items || [];
        const statKey = `${route.chain}|${route.address}`;
        if (fomoStats.key !== statKey) {
          fomoStats = { key: statKey, holders: null, thesisCount: null, supply: 0 };
          fomoSelfHealTried = false;
        }
        if (fomoTab === 'holders') fomoStats.holders = { items: res.items || [], total: Number(res.total) };
        if (fomoTab === 'thesis') fomoStats.thesisCount = (res.items || []).length;
        loadFomoSupply(route);
        renderFomoStats();
        renderFomoItems(list, fomoLastItems, fomoTab);
        fomoPanelEl.classList.remove('has-error');
      } else {
        fomoErrKey = key;
        fomoErrAt = Date.now();
        const box = await buildFomoErrorBox(res);
        list.replaceChildren(box);
        fomoPanelEl.classList.add('has-error');
      }
    } catch {
    }
    fomoLoading = false;
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
    const dbg = document.createElement('button');
    dbg.type = 'button';
    dbg.className = 'gdh-fomo__dbg';
    dbg.textContent = '{}';
    dbg.title = 'Show raw data for diagnostics';
    dbg.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const list = panel.querySelector('.gdh-fomo__list');
      const existing = list.querySelector('.gdh-fomo__raw');
      if (existing) {
        existing.remove();
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'gdh-fomo__raw';
      const first = fomoLastItems[0];
      pre.textContent = first
        ? `${fomoLastItems.length} items · First item fields:\n${JSON.stringify(first, null, 1).slice(0, 1500)}`
        : 'No data (items is empty)';
      list.prepend(pre);
    });

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
    head.append(title, tabs, tr, dbg, open, fold, close);

    const stats = document.createElement('div');
    stats.className = 'gdh-fomo__stats';

    const list = document.createElement('div');
    list.className = 'gdh-fomo__list';
    panel.append(head, stats, list);
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
    if (settings.enableFomoPanel === false || !currentTokenRoute()) {
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
      document.body.appendChild(btn);
    }
    btn.classList.toggle('is-active', settings.fomoPanelOpen === true);
  }

  function scanFomoPanel() {
    ensureNotificationLauncher();
    const route = currentTokenRoute();
    if (settings.enableFomoPanel === false || !route || settings.fomoPanelOpen !== true) {
      if (fomoPanelEl) {
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
    if (!gmgnHoldingSignalConfig.loaded) return true;
    return gmgnHoldingSignalConfig.byChain.get(String(chain || '').toLowerCase()) === true;
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

  function latestHoldingApiUrl(chain) {
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const raw = String(entries[i]?.name || '');
        if (!raw.includes('/td/api/v1/wallets/holdings?')) continue;
        const url = new URL(raw);
        if (url.origin !== location.origin || url.pathname !== '/td/api/v1/wallets/holdings') continue;
        if (String(url.searchParams.get('chain') || '').toLowerCase() !== chain) continue;
        if (!url.searchParams.getAll('wallet_addresses').length) continue;
        return url;
      }
    } catch {
    }
    return null;
  }

  async function syncHoldingWatchFromApi(targetChain = '', force = false, expectedKey = '') {
    if (!isTabVisibleForHolding()) return;
    const chain = String(targetChain || currentChain() || '').trim().toLowerCase();
    if (!chain) return { ok: false, reason: 'missing-chain', present: false };
    if (holdingApiInflight.has(chain)) {
      const inflight = await holdingApiInflight.get(chain);
      return { ...inflight, present: expectedKey ? inflight?.seen?.has(expectedKey) === true : null };
    }
    if (!force && Date.now() - (holdingApiSyncedAt.get(chain) || 0) < HOLDING_API_TTL_MS) {
      return { ok: true, reason: 'fresh', present: expectedKey ? holdingWatchMap.has(expectedKey) : null };
    }
    const url = latestHoldingApiUrl(chain);
    const token = gmgnAccessToken();
    if (!url || !token) return { ok: false, reason: !url ? 'missing-url' : 'missing-token', present: false };
    holdingApiSyncedAt.set(chain, Date.now());
    const task = (async () => {
      try {
        const response = await fetch(url.toString(), {
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
        });
        const body = await response.json().catch(() => null);
        const rows = body?.data?.holdings;
        if (!response.ok || body?.code !== 0 || !Array.isArray(rows)) {
          return { ok: false, reason: 'bad-response', seen: new Set(), authoritative: false };
        }
        const grouped = new Map();
        for (const row of rows) {
          const address = normalizeWalletAddress(String(row?.token_address || row?.token_basic_stats?.address || ''));
          if (!address) continue;
          const { balance, average } = holdingCostFromApi(row);
          if (!(balance > 0)) continue;
          const key = holdingKey(chain, address);
          const hit = grouped.get(key) || { chain, address, symbol: '', weightedCost: 0, balance: 0 };
          hit.symbol = hit.symbol || String(row?.token_basic_stats?.symbol || row?.symbol || '').slice(0, 24);
          hit.balance += balance;
          if (average > 0) hit.weightedCost += average * balance;
          grouped.set(key, hit);
        }
        const seen = new Set();
        for (const hit of grouped.values()) {
          const cost = hit.balance > 0 && hit.weightedCost > 0 ? hit.weightedCost / hit.balance : 0;
          putHolding({ chain, address: hit.address, symbol: hit.symbol, cost, at: Date.now() });
          seen.add(holdingKey(chain, hit.address));
        }
        const authoritative = rows.length < 100;
        if (authoritative) {
          for (const [key, item] of [...holdingWatchMap]) {
            if (item.chain !== chain || seen.has(key)) continue;
            holdingWatchMap.delete(key);
            holdingAlertedAt.delete(key);
            holdingAlertLevel.delete(key);
          }
        }
        scheduleHoldingSave(chain, authoritative);
        return { ok: true, seen, authoritative };
      } catch {
        return { ok: false, reason: 'fetch-failed', seen: new Set(), authoritative: false };
      }
    })().finally(() => holdingApiInflight.delete(chain));
    holdingApiInflight.set(chain, task);
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
      tagText: 'Position surge',
      symbol: confirmedMeta.symbol || fallbackSymbol || 'Position token',
      label: 'Cost / 5m',
      value: `Cost ${confirmedPct >= 0 ? '+' : ''}${confirmedPct.toFixed(1)}% · 5m +${pct5m.toFixed(1)}%  ${formatPriceShort(price)}`,
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

  const MANI_SEEN_MAX = 500;
  const MANI_SEEN_STORE_KEY = 'maniSeenKeys';
  const MANI_TOAST_MS = 12000;
  const MANI_TOAST_MAX = 3;
  const MANI_BASELINE_FAILSAFE_MS = 8000;
  const maniSeen = new Set();
  let maniSeenLoaded = false;
  let maniSeenSaveTimer = 0;
  let maniBaselineDone = false;
  let maniRailFirstSeenAt = 0;
  let maniContainer = null;

  function maniKeyFromChip(chip) {
    const ulid = chip.dataset.gdhManiUlid || '';
    if (ulid) return ulid;
    const href = chip.getAttribute('href') || '';
    const token = normalizeAddress(
      chip.dataset.gdhManiToken || (href.match(/\/token\/(0x[a-fA-F0-9]{40})/) || [])[1] || '',
    );
    if (!token) return '';
    return `${token}|${chip.dataset.gdhCallerHandle || ''}`;
  }

  function trimManiSeen() {
    if (maniSeen.size <= MANI_SEEN_MAX) return;
    const iterator = maniSeen.values();
    for (let extra = maniSeen.size - MANI_SEEN_MAX; extra > 0; extra -= 1) {
      maniSeen.delete(iterator.next().value);
    }
  }

  function scheduleManiSeenSave() {
    if (maniSeenSaveTimer) return;
    maniSeenSaveTimer = window.setTimeout(() => {
      maniSeenSaveTimer = 0;
      try {
        chrome.storage.local.set({ [MANI_SEEN_STORE_KEY]: [...maniSeen] });
      } catch {
      }
    }, 400);
  }

  function mergeManiSeenKeys(keys) {
    if (!Array.isArray(keys)) return;
    keys.forEach((key) => {
      if (typeof key === 'string' && key) maniSeen.add(key);
    });
    trimManiSeen();
  }

  function rememberManiKey(key) {
    maniSeen.add(key);
    trimManiSeen();
    scheduleManiSeenSave();
  }

  function manifestoTokenHref(chip) {
    const href = chip.getAttribute('href') || '';
    if (/\/token\/0x[a-fA-F0-9]{40}/.test(href)) return href;
    const token = normalizeAddress(chip.dataset.gdhManiToken);
    return token ? `/bsc/token/${token}` : '';
  }

  function ensureManiContainer() {
    if (maniContainer && document.contains(maniContainer)) return maniContainer;
    maniContainer = document.createElement('div');
    maniContainer.className = 'gdh-mani-toast-container';
    document.body.appendChild(maniContainer);
    return maniContainer;
  }


  function buildManiCard(info) {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'gdh-mani-card__head';
    if (info.avatar) {
      const avatar = document.createElement('img');
      avatar.className = 'gdh-mani-card__avatar';
      avatar.src = info.avatar;
      avatar.alt = '';
      avatar.referrerPolicy = 'no-referrer';
      head.appendChild(avatar);
    }
    const main = document.createElement('div');
    main.className = 'gdh-mani-card__main';
    const nameRow = document.createElement('div');
    nameRow.className = 'gdh-mani-card__namerow';
    const nameEl = document.createElement('strong');
    nameEl.className = 'gdh-mani-card__name';
    nameEl.textContent = info.name || info.handle || 'Anonymous';
    nameRow.appendChild(nameEl);
    if (info.verified) {
      const check = document.createElement('span');
      check.className = 'gdh-mani-card__verified';
      check.textContent = '✔';
      check.setAttribute('aria-label', 'Verified');
      nameRow.appendChild(check);
    }
    const mult = Number(info.multiplier);
    if (Number.isFinite(mult) && mult > 0) {
      const multEl = document.createElement('span');
      multEl.className = 'gdh-mani-card__mult';
      multEl.textContent = `${mult.toFixed(1).replace(/\.0$/, '')}x`;
      nameRow.appendChild(multEl);
    }
    main.appendChild(nameRow);
    if (info.handle) {
      const handleEl = document.createElement('div');
      handleEl.className = 'gdh-mani-card__handle';
      handleEl.textContent = `@${info.handle}`;
      main.appendChild(handleEl);
    }
    head.appendChild(main);
    const timeMs = Number(info.timeMs);
    if (Number.isFinite(timeMs) && timeMs > 0) {
      const timeEl = document.createElement('span');
      timeEl.className = 'gdh-mani-card__time';
      timeEl.textContent = formatRelTime(timeMs);
      head.appendChild(timeEl);
    }
    frag.appendChild(head);

    if (info.text) {
      const textEl = document.createElement('div');
      textEl.className = 'gdh-mani-card__text';
      textEl.textContent = info.text;
      frag.appendChild(textEl);
    }

    const foot = document.createElement('div');
    foot.className = 'gdh-mani-card__foot';
    const symbolEl = document.createElement('strong');
    symbolEl.className = 'gdh-mani-card__symbol';
    symbolEl.textContent = info.symbol || 'Token';
    foot.appendChild(symbolEl);
    if (info.usd) {
      const usdEl = document.createElement('span');
      usdEl.className = 'gdh-mani-card__usd';
      usdEl.textContent = `$${info.usd}`;
      foot.appendChild(usdEl);
    }
    const hint = document.createElement('span');
    hint.className = 'gdh-mani-card__hint';
    hint.textContent = 'Open token page →';
    foot.appendChild(hint);
    frag.appendChild(foot);

    return frag;
  }

  function maniInfoFromChip(chip) {
    return {
      avatar: chip.dataset.gdhManiAvatar || '',
      name: chip.dataset.gdhCallerName || '',
      handle: chip.dataset.gdhCallerHandle || '',
      verified: chip.dataset.gdhManiVerified === '1',
      multiplier: chip.dataset.gdhManiMult || '',
      timeMs: chip.dataset.gdhManiTime || '',
      text: chip.dataset.gdhManiText || '',
      symbol: chip.dataset.gdhManiSymbol || '',
      usd: chip.dataset.gdhManiUsd || '',
    };
  }

  function showManifestoToast(chip) {
    const href = manifestoTokenHref(chip);
    if (!href) return;

    const container = ensureManiContainer();
    while (container.children.length >= MANI_TOAST_MAX) {
      container.firstElementChild.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'gdh-mani-toast';
    toast.appendChild(buildManiCard(maniInfoFromChip(chip)));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-mani-toast__close';
    close.textContent = '×';
    close.title = 'Close';
    toast.appendChild(close);

    let dismissTimer = 0;
    const dismiss = () => {
      window.clearTimeout(dismissTimer);
      toast.remove();
      if (maniContainer && !maniContainer.children.length) {
        maniContainer.remove();
        maniContainer = null;
      }
    };
    const arm = () => {
      window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(dismiss, MANI_TOAST_MS);
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    toast.addEventListener('mouseenter', () => window.clearTimeout(dismissTimer));
    toast.addEventListener('mouseleave', arm);
    toast.addEventListener('click', () => {
      dismiss();
      if (chip.isConnected) chip.click();
      else gdhSpaNavigate(href);
    });
    arm();
    container.appendChild(toast);
  }

  const MANI_LIST_REFRESH_MS = 30000;
  const MANI_LIST_STALE_MS = 15000;
  let maniListOpen = false;
  let maniListTimer = 0;
  let maniListLoading = false;
  let maniListCache = { at: 0, list: [] };

  function formatRelTime(ms) {
    const diff = Math.max(0, Date.now() - Number(ms));
    if (diff < 60e3) return `${Math.max(1, Math.floor(diff / 1e3))}s ago`;
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)}m ago`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h ago`;
    return `${Math.floor(diff / 86400e3)}d ago`;
  }

  async function fetchManifestoSnapshot() {
    if (maniListLoading) return;
    maniListLoading = true;
    try {
      const res = await fetch(
        `https://gmgn.ai/api/v1/notification/callout/declaration/global_snapshot?${DEV_ATH_QS}&chains=bsc`,
        { credentials: 'include' },
      );
      const body = await res.json().catch(() => null);
      if (res.ok && body?.code === 0 && Array.isArray(body.data?.list)) {
        maniListCache = { at: Date.now(), list: body.data.list };
      }
    } catch {
    }
    maniListLoading = false;
    if (maniListOpen) scheduleScan();
  }

  function stopManiListTimer() {
    if (maniListTimer) {
      window.clearInterval(maniListTimer);
      maniListTimer = 0;
    }
  }

  function manifestoItemBlocked(item) {
    return isCallerBlocked({
      wallet: normalizeAddress(item.call_wallet),
      handle: normalizeHandle(item.twitter_username),
    });
  }

  function renderManifestoListModal(modal) {
    const items = [...maniListCache.list]
      .filter((item) => !manifestoItemBlocked(item))
      .sort((a, b) => Number(b.create_time) - Number(a.create_time));
    const key = `${maniListCache.at}|${items.map((it) => it.ulid || it.id).join(',')}|${Math.floor(Date.now() / MANI_LIST_REFRESH_MS)}`;
    if (modal.dataset.gdhManiListKey === key) return;
    modal.dataset.gdhManiListKey = key;

    const list = modal.querySelector('.gdh-mani-list__items');
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-mani-list__empty';
      empty.textContent = maniListCache.at ? 'No current manifestos' : 'Loading…';
      list.appendChild(empty);
      return;
    }

    for (const item of items) {
      const token = normalizeAddress(item.call_token);
      if (!token) continue;
      const row = document.createElement('a');
      row.className = 'gdh-mani-list__item';
      row.href = `/bsc/token/${token}`;
      row.appendChild(buildManiCard({
        avatar: /^https:\/\//.test(String(item.wallet_avatar || '')) ? item.wallet_avatar : '',
        name: String(item.twitter_name || '').trim(),
        handle: String(item.twitter_username || '').trim(),
        verified: String(item.is_blue_verified) === 'true',
        multiplier: item.multiplier,
        timeMs: item.create_time,
        text: String(item.call_thesis?.source_content || '').trim(),
        symbol: String(item.token_symbol || 'Token').slice(0, 24),
        usd: item.amount_usd || '',
      }));

      row.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = false;
        scheduleScan();
        const chip = item.ulid
          ? document.querySelector(`${MANIFESTO_SELECTOR}[data-gdh-mani-ulid="${item.ulid}"]`)
          : null;
        if (chip instanceof HTMLElement && chip.isConnected) chip.click();
        else gdhSpaNavigate(`/bsc/token/${token}`);
      });
      list.appendChild(row);
    }
  }

  function ensureManifestoListModal(context) {
    let modal = context.panel.querySelector(':scope > .gdh-mani-list-modal');
    if (!maniListOpen) {
      modal?.remove();
      stopManiListTimer();
      return;
    }

    context.panel.classList.add('gdh-callout-panel-host');
    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-mani-list-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const header = document.createElement('div');
      header.className = 'gdh-mani-list__header';
      const title = document.createElement('strong');
      title.textContent = 'Current manifestos · by time';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-mani-list__close';
      close.textContent = '×';
      close.title = 'Close manifesto list';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = false;
        modal.remove();
        stopManiListTimer();
        scheduleScan();
      });
      header.append(title, close);

      const list = document.createElement('div');
      list.className = 'gdh-mani-list__items';
      modal.append(header, list);
      context.panel.appendChild(modal);
    }

    try {
      const firstTab = context.panel.querySelector('button[data-sentry-component="renderTab"]');
      const rowRect = (firstTab?.parentElement || context.header).getBoundingClientRect();
      const panelRect = context.panel.getBoundingClientRect();
      const top = Math.max(40, Math.round(rowRect.bottom - panelRect.top) + 6);
      modal.style.top = `${top}px`;
    } catch {
      modal.style.top = '76px';
    }

    if (Date.now() - maniListCache.at > MANI_LIST_STALE_MS) fetchManifestoSnapshot();
    if (!maniListTimer) {
      maniListTimer = window.setInterval(fetchManifestoSnapshot, MANI_LIST_REFRESH_MS);
    }
    renderManifestoListModal(modal);
  }

  function ensureManifestoTab() {
    if (settings.enableManifestoTab === false) {
      document
        .querySelectorAll('.gdh-mani-tab-button, .gdh-mani-list-modal')
        .forEach((node) => node.remove());
      maniListOpen = false;
      stopManiListTimer();
      return;
    }
    const context = getCalloutPanelContext();
    if (!context) {
      if (maniListOpen) {
        maniListOpen = false;
        stopManiListTimer();
      }
      return;
    }
    const firstTab = context.panel.querySelector('button[data-sentry-component="renderTab"]');
    const tabsInner = firstTab?.parentElement;
    if (!(tabsInner instanceof HTMLElement)) return;

    let button = tabsInner.querySelector(':scope > .gdh-mani-tab-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-mani-tab-button';
      button.title = 'View current manifestos by time';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = !maniListOpen;
        if (maniListOpen) blacklistModalOpen = false;
        scheduleScan();
      });
      tabsInner.appendChild(button);
      if (!tabsInner.dataset.gdhManiTabWatch) {
        tabsInner.dataset.gdhManiTabWatch = '1';
        tabsInner.addEventListener(
          'click',
          (event) => {
            if (!maniListOpen) return;
            if (event.target.closest?.('button[data-sentry-component="renderTab"]')) {
              maniListOpen = false;
              scheduleScan();
            }
          },
          true,
        );
      }
    }
    const visible = maniListCache.list.filter((item) => !manifestoItemBlocked(item)).length;
    const label = maniListCache.at && visible ? `Manifestos ${visible}` : 'Manifestos';
    if (button.textContent !== label) button.textContent = label;
    button.classList.toggle('is-active', maniListOpen);
    ensureManifestoListModal(context);
  }

  function scanManifestoToasts() {
    if (settings.enableManifestoToast === false) {
      maniContainer?.remove();
      maniContainer = null;
      return;
    }
    if (!maniSeenLoaded) return;
    const chips = [...document.querySelectorAll(MANIFESTO_SELECTOR)];
    const railExists = chips.length > 0
      || !!document.querySelector('[data-sentry-component="ManifestoRailInner"]');
    if (!railExists) return;

    if (!maniBaselineDone) {
      if (!maniRailFirstSeenAt) maniRailFirstSeenAt = Date.now();
      const failsafeElapsed =
        Date.now() - maniRailFirstSeenAt >= MANI_BASELINE_FAILSAFE_MS;
      const snapshotReady =
        chips.length > 0 && chips.every((chip) => maniKeyFromChip(chip));
      if (!snapshotReady && !failsafeElapsed) return;
      chips.forEach((chip) => {
        const key = maniKeyFromChip(chip);
        if (key) rememberManiKey(key);
      });
      maniBaselineDone = true;
      return;
    }

    chips.forEach((chip) => {
      const key = maniKeyFromChip(chip);
      if (!key || maniSeen.has(key)) return;
      rememberManiKey(key);
      if (isCallerBlocked(getCallerFromElement(chip))) return;
      showManifestoToast(chip);
    });
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

  const FOMO_FEED_POLL_MS = 18000;
  const FOMO_FEED_RENDER_CAP = 40;
  const FOMO_FEED_HEAD_CAP = 6;
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
    swap: { label: 'Swap', cls: 'is-swap' },
    thesis: { label: 'Narrative', cls: 'is-thesis' },
    transferIn: { label: 'Transfer in', cls: 'is-transfer' },
    refund: { label: 'Refund / failed', cls: 'is-refund' },
  };
  const PUMP_FEED_DEFAULT_TOKEN_FILTERS = new Set([
    'SPCXB', 'SKHYB', 'SPYB', 'XAUT', 'QQQB', 'NVDAB', 'AAPLB', 'TSLAB',
    'MSFTB', 'GOOGLB', 'HOODB', 'BABAB', 'GMEB', 'NFLXB', 'MSTRB', 'DJTB',
  ]);
  let fomoFeedEvents = [];
  let pumpFeedEvents = [];
  const fomoFeedCards = new Map();
  const fomoFeedSeen = new Set();
  const FOMO_FEED_SEEN_MAX = 600;
  let fomoFeedLastPollAt = 0;
  let pumpFeedLastPollAt = 0;
  let pumpDefaultWallets = new Set();
  let monitorFomoCfg = {
    connected: false, muted: new Set(), prefs: {}, watch: new Set(), filters: {},
    tokenFilters: new Set(PUMP_FEED_DEFAULT_TOKEN_FILTERS), globalTradeMinUsd: 10,
    wallet: '', at: 0,
  };
  let monitorPumpCfg = {
    connected: false, muted: new Set(), prefs: {}, watch: new Set(), filters: {},
    tokenFilters: new Set(PUMP_FEED_DEFAULT_TOKEN_FILTERS), onlyMine: true,
    globalTradeMinUsd: 10, at: 0,
  };

  function loadMonitorFomoCfg(raw) {
    const muted = new Set(
      (Array.isArray(raw?.muted) ? raw.muted : []).map((h) => String(h || '').toLowerCase()).filter(Boolean),
    );
    const prefs = raw?.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs) ? raw.prefs : {};
    const watch = new Set(
      (Array.isArray(raw?.watch) ? raw.watch : []).map((h) => String(h || '').toLowerCase()).filter(Boolean),
    );
    const filters = raw?.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters) ? raw.filters : {};
    const tokenValues = Array.isArray(raw?.tokenFilters)
      ? raw.tokenFilters : [...PUMP_FEED_DEFAULT_TOKEN_FILTERS];
    const tokenFilters = new Set(tokenValues.map(pumpFeedTokenKey).filter(Boolean));
    const globalTradeMinUsd = Number(raw?.globalTradeMinUsd);
    monitorFomoCfg = {
      connected: raw?.connected === true,
      muted,
      prefs,
      watch,
      filters,
      tokenFilters,
      globalTradeMinUsd: Number.isFinite(globalTradeMinUsd) && globalTradeMinUsd >= 0 ? globalTradeMinUsd : 10,
      wallet: String(raw?.wallet || ''),
      at: Number(raw?.at) || 0,
    };
  }

  function pumpFeedTokenKey(raw) {
    const value = String(raw || '').trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(value)) return value.toLowerCase();
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return value;
    const symbol = value.replace(/^\$+/, '').toUpperCase();
    return /^[A-Z0-9._-]{1,20}$/.test(symbol) ? symbol : '';
  }

  function loadMonitorPumpCfg(raw) {
    const muted = new Set(
      (Array.isArray(raw?.muted) ? raw.muted : []).map((item) => String(item || '')).filter(Boolean),
    );
    const prefs = raw?.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs) ? raw.prefs : {};
    const watch = new Set(
      (Array.isArray(raw?.watch) ? raw.watch : []).map((item) => String(item || '')).filter(Boolean),
    );
    const filters = raw?.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters) ? raw.filters : {};
    const tokenValues = Array.isArray(raw?.tokenFilters)
      ? raw.tokenFilters : [...PUMP_FEED_DEFAULT_TOKEN_FILTERS];
    const tokenFilters = new Set(tokenValues.map(pumpFeedTokenKey).filter(Boolean));
    const globalTradeMinUsd = Number(raw?.globalTradeMinUsd);
    monitorPumpCfg = {
      connected: raw?.connected === true,
      muted,
      prefs,
      watch,
      filters,
      tokenFilters,
      onlyMine: raw?.onlyMine !== false,
      globalTradeMinUsd: Number.isFinite(globalTradeMinUsd) && globalTradeMinUsd >= 0 ? globalTradeMinUsd : 10,
      at: Number(raw?.at) || 0,
    };
  }

  function currentChainSlug() {
    const match = location.pathname.match(/^\/(sol|bsc|eth|base|tron|blast|monad|megaeth|hyperevm|xlayer|robinhood|arc|stable|arbitrum)(\/|$)/);
    if (match) return match[1];
    const q = new URLSearchParams(location.search).get('chain');
    return q ? String(q).toLowerCase() : '';
  }

  function fomoFeedEventAllowed(ev) {
    if (!monitorFomoCfg.connected) return false;
    const types = settings.fomoFeedTypes || DEFAULTS.fomoFeedTypes;
    if (types[ev.type] === false) return false;
    if (!monitorFomoCfg.watch.has(ev.handle)) return false;
    if (monitorFomoCfg.muted.has(ev.handle)) return false;
    const pref = monitorFomoCfg.prefs[ev.handle];
    if (pref?.types && pref.types[ev.type] === false) return false;
    if (ev.addr && isTokenBlocked(ev.addr)) return false;
    const symbolKey = pumpFeedTokenKey(ev.symbol);
    const addressKey = pumpFeedTokenKey(ev.addr);
    if ((symbolKey && monitorFomoCfg.tokenFilters.has(symbolKey))
      || (addressKey && monitorFomoCfg.tokenFilters.has(addressKey))) return false;
    const personal = Number(monitorFomoCfg.filters?.[ev.handle]?.minTradeUsd
      ?? monitorFomoCfg.filters?.[ev.handle]);
    const minUsd = Math.max(
      monitorFomoCfg.globalTradeMinUsd,
      Number.isFinite(personal) && personal > 0 ? personal : 0,
    );
    if (minUsd > 0 && Number(ev.usd) > 0 && Number(ev.usd) < minUsd) return false;
    return true;
  }

  function pumpFeedEventAllowed(ev) {
    if (!monitorPumpCfg.connected) return false;
    const wallet = String(ev?.pumpWallet || '');
    if (!wallet || monitorPumpCfg.muted.has(wallet)) return false;
    if (monitorPumpCfg.prefs?.[wallet]?.types?.[ev.type] === false) return false;
    if (ev.addr && isTokenBlocked(ev.addr)) return false;
    const symbolKey = pumpFeedTokenKey(ev.symbol);
    const addressKey = pumpFeedTokenKey(ev.addr);
    if ((symbolKey && monitorPumpCfg.tokenFilters.has(symbolKey))
      || (addressKey && monitorPumpCfg.tokenFilters.has(addressKey))) return false;
    const personal = Number(monitorPumpCfg.filters?.[wallet]?.minTradeUsd
      ?? monitorPumpCfg.filters?.[wallet]);
    const minUsd = Math.max(
      monitorPumpCfg.globalTradeMinUsd,
      Number.isFinite(personal) && personal > 0 ? personal : 0,
    );
    if (minUsd > 0 && Number(ev.usd) > 0 && Number(ev.usd) < minUsd) return false;
    if (monitorPumpCfg.onlyMine) {
      return monitorPumpCfg.watch.has(wallet) || pumpDefaultWallets.has(wallet);
    }
    return true;
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
    const tx = trackingFeedNormalizedTx(ev?.tx);
    if (tx) return `tx:${tx}`;
    const source = String(ev?.source || 'fomo');
    const addr = trackingFeedNormalizedAddress(ev?.addr);
    const side = String(ev?.type || '');
    const principal = trackingFeedNormalizedAddress(ev?.pumpWallet || ev?.handle);
    const ts = Math.round((Number(ev?.ts) || 0) / 1000);
    const usd = Math.round((Number(ev?.usd) || 0) * 100);
    if (addr && side && principal && ts) return `event:${source}:${addr}:${side}:${principal}:${ts}:${usd}`;
    return `key:${String(ev?.key || '')}`;
  }

  function nativeTrackingFeedRows(cards) {
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
    if (tx && row?.tx && tx === row.tx) return true;
    const addr = trackingFeedNormalizedAddress(ev?.addr);
    if (!addr || !row?.addr || addr !== row.addr || !row.side || side !== row.side) return false;
    const chain = String(ev?.chain || '').trim().toLowerCase();
    if (chain && row.chain && chain !== row.chain) return false;
    const ts = Number(ev?.ts) || 0;
    if (!ts || !row.ts || Math.abs(ts - row.ts) > 15000) return false;
    if (ev?.source === 'pump') {
      const wallet = trackingFeedNormalizedAddress(ev?.pumpWallet);
      if (!wallet || !row.maker || wallet !== row.maker) return false;
    }
    const usd = Number(ev?.usd) || 0;
    if (!usd || !row.usd) return false;
    return Math.abs(usd - row.usd) <= Math.max(1, Math.max(usd, row.usd) * 0.05);
  }

  function visibleTrackingFeedEvents(nativeRows = []) {
    const chain = settings.fomoFeedChainOnly === true ? currentChainSlug() : '';
    const out = [];
    if (settings.enableFomoFeed !== false) {
      for (const ev of fomoFeedEvents) {
        if (!ev?.key || !ev.ts || !fomoFeedEventAllowed(ev)) continue;
        if (chain && ev.chain && ev.chain !== chain) continue;
        out.push(ev);
      }
    }
    if (settings.enablePumpFeed !== false) {
      for (const ev of pumpFeedEvents) {
        if (!ev?.key || !ev.ts || !pumpFeedEventAllowed(ev)) continue;
        out.push(ev);
      }
    }
    const seen = new Set();
    return out.sort((a, b) => b.ts - a.ts).filter((ev) => {
      const identity = trackingFeedEventIdentity(ev);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return !nativeRows.some((row) => trackingFeedIsNativeDuplicate(ev, row));
    }).slice(0, FOMO_FEED_RENDER_CAP);
  }

  function pollFomoFeed() {
    if (!settings.enabled || settings.enableFomoFeed === false) return;
    if (!document.querySelector(TRACK_TAB_CELL) && !trackerCards().length) return;
    fomoFeedLastPollAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'fomo-feed' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (!resp?.ok) {
          if (resp?.reason === 'not-connected') { fomoFeedEvents = []; scheduleScan(); }
          return;
        }
        fomoFeedEvents = Array.isArray(resp.events) ? resp.events : [];
        scheduleScan();
      });
    } catch {
    }
  }

  function fomoFeedRelTime(ts) {
    const diff = Math.max(0, Date.now() - ts);
    if (diff < 60000) return `${Math.max(5, Math.ceil(diff / 5000) * 5)}s`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
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
    if (ev?.source === 'pump') {
      return { source: 'Pump', title: 'Open Pump profile', url: String(ev.profileUrl || '') };
    }
    return {
      source: 'fomo',
      title: `@${ev?.handle || ''} · Open FOMO profile`,
      url: ev?.handle ? `https://fomo.family/profile/${encodeURIComponent(ev.handle)}` : '',
    };
  }


  function buildFomoFeedTableRow(ev, card, tag) {
    const profile = trackingFeedProfileMeta(ev);
    const row = document.createElement('div');
    row.className = 'gdh-fomofeed__trow';

    const time = document.createElement('span');
    time.className = 'gdh-fomofeed__tcell gdh-fomofeed__ttime';
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
    name.textContent = ev.name || ev.handle || '?';
    name.title = profile.title;
    const openProfile = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (profile.url) window.open(profile.url, '_blank', 'noopener,noreferrer');
    };
    av.addEventListener('click', openProfile);
    name.addEventListener('click', openProfile);
    const src = document.createElement('span');
    src.className = 'gdh-fomofeed__src';
    src.textContent = profile.source;
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
    symText.textContent = ev.symbol || '';
    const act = document.createElement('span');
    act.className = 'gdh-fomofeed__tag';
    act.textContent = tag.label;
    sym.append(symText, act);

    const amt = document.createElement('span');
    amt.className = 'gdh-fomofeed__tcell gdh-fomofeed__tamt';
    amt.textContent = ev.usd > 0 ? fomoUsd(ev.usd) : '';

    const mc = document.createElement('span');
    mc.className = 'gdh-fomofeed__tcell gdh-fomofeed__tmc';
    mc.textContent = ev.mc > 0 ? fomoUsd(ev.mc) : '';

    row.append(time, who, sym, amt, mc);
    card.appendChild(row);

    if ((ev.type === 'thesis' || ev.type === 'refund') && ev.comment) {
      const text = document.createElement('div');
      text.className = 'gdh-fomofeed__thesis';
      text.textContent = ev.comment;
      card.appendChild(text);
      queueFomoTranslate(text, ev.comment);
    }
  }

  function buildFomoFeedCard(ev) {
    const tag = FOMO_FEED_TAGS[ev.type] || { label: 'fomo', cls: '' };
    const profile = trackingFeedProfileMeta(ev);
    const card = document.createElement('div');
    card.className = `gdh-fomofeed ${tag.cls}${ev.source === 'pump' ? ' is-pump' : ''}`;
    card.dataset.gdhFomoKey = ev.key;
    card.dataset.gdhFeedSource = ev.source || 'fomo';

    if (ev.chain) {
      const stripe = document.createElement('span');
      stripe.className = 'gdh-fomofeed__stripe';
      stripe.style.backgroundColor = fomoFeedChainColor(ev.chain);
      card.appendChild(stripe);
    }

    if (isTrackerTableMode()) {
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
    name.textContent = ev.name || ev.handle || '?';
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
    time.textContent = fomoFeedRelTime(ev.ts);

    r1.append(av, name, tagEl, src, time);
    card.appendChild(r1);

    const r2 = document.createElement('div');
    r2.className = 'gdh-fomofeed__r2';

    if (ev.usd > 0) {
      const usd = document.createElement('span');
      usd.className = 'gdh-fomofeed__usd';
      usd.textContent = fomoUsd(ev.usd);
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

    if (ev.symbol) {
      const sym = document.createElement('span');
      sym.className = 'gdh-fomofeed__sym';
      sym.textContent = ev.symbol;
      r2.appendChild(sym);
    }

    if (ev.mc > 0) {
      const mc = document.createElement('span');
      mc.className = 'gdh-fomofeed__mc';
      mc.textContent = `MC:${fomoUsd(ev.mc)}`;
      r2.appendChild(mc);
    }
    card.appendChild(r2);

    if ((ev.type === 'thesis' || ev.type === 'refund') && ev.comment) {
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
    if (ev.addr && ev.chain) {
      card.title = `${ev.symbol || ev.addr} · Open GMGN token page`;
      card.addEventListener('click', (event) => {
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

  function fomoFeedCardFor(ev) {
    let el = fomoFeedCards.get(ev.key);
    if (!el || !(el instanceof HTMLElement)) {
      el = buildFomoFeedCard(ev);
      fomoFeedCards.set(ev.key, el);
    }
    const timeEl = el.querySelector('.gdh-fomofeed__time');
    const next = fomoFeedRelTime(ev.ts);
    if (timeEl && timeEl.textContent !== next) timeEl.textContent = next;
    return el;
  }

  const FOMO_FEED_INLINE_CAP = 6;
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
    el.style.translate = `0px ${next}px`;
    return true;
  }

  function clearFomoFeedShifts() {
    for (const [el, state] of fomoFeedShifted) {
      if (el.isConnected) el.style.translate = state.originalTranslate;
    }
    fomoFeedShifted.clear();
  }

  function pollPumpFeed() {
    if (!settings.enabled || settings.enablePumpFeed === false) return;
    if (!document.querySelector(TRACK_TAB_CELL) && !trackerCards().length) return;
    pumpFeedLastPollAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'pump-feed' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (!resp?.ok) {
          if (resp?.reason === 'not-connected') { pumpFeedEvents = []; pumpDefaultWallets = new Set(); scheduleScan(); }
          return;
        }
        pumpFeedEvents = Array.isArray(resp.events) ? resp.events : [];
        pumpDefaultWallets = new Set(
          (Array.isArray(resp.defaultWallets) ? resp.defaultWallets : [])
            .map((item) => String(item || '')).filter(Boolean),
        );
        scheduleScan();
      });
    } catch {
    }
  }


  function fomoFeedInsertionShift(rowTop, inserts) {
    let shift = 0;
    for (const insert of inserts) {
      if (insert.afterTop <= rowTop + 0.25) shift += insert.height;
    }
    return shift;
  }


  function refreshFomoFeedFixedRowShifts() {
    const cards = trackerCards().filter((card) => card.isConnected);
    const rows = [];
    for (const card of cards) {
      const info = fomoFeedFixedRow(card);
      if (info) rows.push({ card, ...info });
    }
    if (!rows.length) return;
    rows.sort((a, b) => a.top - b.top);
    const spacer = rows[0].wrap.parentElement;
    if (!(spacer instanceof HTMLElement)) return;
    const inserts = [...fomoFeedCards.values()]
      .filter((el) => el.isConnected && el.parentElement === spacer && el.classList.contains('is-abs'))
      .map((el) => ({
        afterTop: Number.parseFloat(el.dataset.gdhFomoAfterTop),
        height: el.offsetHeight + 2,
      }))
      .filter((item) => Number.isFinite(item.afterTop) && item.height > 0);

    const stillShifted = new Set();
    let collapsed = 0;
    for (const row of rows) {
      const amount = fomoFeedInsertionShift(row.top, inserts) + collapsed;
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
    if (!document.querySelector('.gdh-fomofeed.is-abs, [data-gdh-token-blocked="1"]')) return;
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
            - Number(state?.amount || 0);
        }
        if (!Number.isFinite(top)) top = Number.parseFloat(wrap.style.top);
        const h = wrap.offsetHeight || Number.parseFloat(wrap.style.height);
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
    clearFomoFeedShifts();
  }

  let fomoFeedLastMode = null;

  function scanFomoFeed() {
    if (!settings.enabled) {
      teardownFomoFeed();
      return;
    }
    if (settings.enableFomoFeed === false && settings.enablePumpFeed === false) {
      teardownFomoFeed();
      collapseBlockedTrackerRows();
      return;
    }
    const mode = isTrackerTableMode() ? 'table' : 'card';
    if (fomoFeedLastMode !== null && fomoFeedLastMode !== mode) teardownFomoFeed();
    fomoFeedLastMode = mode;
    if (settings.enableFomoFeed !== false && Date.now() - fomoFeedLastPollAt > FOMO_FEED_POLL_MS) pollFomoFeed();
    if (settings.enablePumpFeed !== false && Date.now() - pumpFeedLastPollAt > FOMO_FEED_POLL_MS) pollPumpFeed();

    const cards = trackerCards().filter((c) => c.isConnected);
    const events = visibleTrackingFeedEvents(nativeTrackingFeedRows(cards));
    if (!events.length || !cards.length) {
      teardownFomoFeed();
      if (cards.length) layoutFomoFeedFixed(cards, new Map());
      return;
    }

    const withTs = cards
      .map((el) => ({ el, ts: Number(el.getAttribute('data-gdh-track-ts')) || 0 }))
      .filter((item) => item.ts > 0)
      .sort((a, b) => b.ts - a.ts);
    const oldest = withTs.length ? withTs[withTs.length - 1] : null;
    const headCard = withTs[0]?.el || cards[0];
    const fixedMode = !!fomoFeedFixedRow(headCard);

    const placements = new Map();
    let headCount = 0;
    let inlineCount = 0;
    for (const ev of events) {
      if (!withTs.length) {
        if (headCount < FOMO_FEED_HEAD_CAP) { placements.set(ev.key, { ev, anchor: 'head' }); headCount += 1; }
        continue;
      }
      let anchor = null;
      for (const item of withTs) {
        if (item.ts >= ev.ts) anchor = item;
        else break;
      }
      if (!anchor) {
        if (headCount < FOMO_FEED_HEAD_CAP) { placements.set(ev.key, { ev, anchor: 'head' }); headCount += 1; }
        continue;
      }
      if (anchor === oldest && withTs.length > 1) continue;
      if (fixedMode) {
        if (inlineCount >= FOMO_FEED_INLINE_CAP) continue;
        if (!fomoFeedFixedRow(anchor.el)) continue;
        placements.set(ev.key, { ev, anchor: anchor.el });
        inlineCount += 1;
        continue;
      }
      const parent = anchor.el.parentElement;
      if (!parent || parent.querySelectorAll(TRACKER_SYMBOL_CELL).length > 1) continue;
      placements.set(ev.key, { ev, anchor: anchor.el });
    }

    for (const [key, el] of fomoFeedCards) {
      if (!placements.has(key)) {
        el.remove();
        fomoFeedCards.delete(key);
      }
    }

    const byAnchor = new Map();
    const headItems = [];
    for (const it of placements.values()) {
      if (it.anchor === 'head') { headItems.push(it.ev); continue; }
      if (!byAnchor.has(it.anchor)) byAnchor.set(it.anchor, []);
      byAnchor.get(it.anchor).push(it.ev);
    }

    if (fixedMode) {
      layoutFomoFeedFixed(cards, byAnchor, headItems);
      return;
    }
    clearFomoFeedShifts();
    let headPrev = null;
    for (const ev of headItems) {
      const el = fomoFeedCardFor(ev);
      el.classList.remove('is-abs');
      delete el.dataset.gdhFomoAfterTop;
      if (el.style.top) el.style.top = '';
      if (!headPrev) {
        if (headCard.previousElementSibling !== el) headCard.insertAdjacentElement('beforebegin', el);
      } else if (headPrev.nextElementSibling !== el) {
        headPrev.insertAdjacentElement('afterend', el);
      }
      headPrev = el;
    }
    for (const [anchorEl, list] of byAnchor) {
      let prev = anchorEl;
      for (const ev of list) {
        const el = fomoFeedCardFor(ev);
        el.classList.remove('is-abs');
        delete el.dataset.gdhFomoAfterTop;
        if (el.style.top) el.style.top = '';
        if (prev.nextElementSibling !== el) prev.insertAdjacentElement('afterend', el);
        prev = el;
      }
    }
  }



  function collapseBlockedTrackerRows() {
    const cards = trackerCards().filter((c) => c.isConnected);
    if (cards.length) layoutFomoFeedFixed(cards, new Map());
  }

  function layoutFomoFeedFixed(cards, byAnchor, headItems = []) {
    const rows = [];
    for (const card of cards) {
      const info = fomoFeedFixedRow(card);
      if (info) rows.push({ card, wrap: info.wrap, top: info.top, h: info.h });
    }
    if (!rows.length) { clearFomoFeedShifts(); return; }
    rows.sort((a, b) => a.top - b.top);
    const spacer = rows[0].wrap.parentElement;
    if (!(spacer instanceof HTMLElement)) { clearFomoFeedShifts(); return; }

    const stillShifted = new Set();
    let cum = 0;
    let headInner = 0;
    for (const ev of headItems) {
      const el = fomoFeedCardFor(ev);
      el.classList.add('is-abs');
      if (el.parentElement !== spacer) spacer.appendChild(el);
      el.dataset.gdhFomoAfterTop = String(rows[0].top);
      const top = `${rows[0].top + headInner}px`;
      if (el.style.top !== top) el.style.top = top;
      headInner += el.offsetHeight + 2;
    }
    cum = headInner;
    for (const row of rows) {
      if (setFomoFeedRowShift(row.wrap, cum) && cum) stillShifted.add(row.wrap);
      if (row.card.dataset.gdhTokenBlocked === '1') {
        cum -= row.h;
        continue;
      }
      const group = byAnchor.get(row.card);
      if (!group) continue;
      let inner = 0;
      for (const ev of group) {
        const el = fomoFeedCardFor(ev);
        el.classList.add('is-abs');
        if (el.parentElement !== spacer) spacer.appendChild(el);
        el.dataset.gdhFomoAfterTop = String(row.top + row.h);
        const top = `${row.top + row.h + cum + inner}px`;
        if (el.style.top !== top) el.style.top = top;
        inner += el.offsetHeight + 2;
      }
      cum += inner;
    }
    for (const el of [...fomoFeedShifted.keys()]) {
      if (!stillShifted.has(el)) {
        setFomoFeedRowShift(el, 0);
      }
    }
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
    timed('mani', () => { scanManifestoToasts(); ensureManifestoTab(); });
    timed('special', scanSpecialWallets);
    timed('marked', () => { try { scanMarkedBadges(); } catch {  } });
    timed('flap', () => { try { scanFlapBadges(); } catch {  } });
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
    return target.closest(`${CARD_SELECTOR}[data-gdh-watched="1"]`);
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

  const GDH_SELF_SELECTOR = '[data-gdh-fomo-key], .gdh-flap-row, .gdh-flap, .gdh-marked, .gdh-remind-card, .gdh-notification-launcher, .gdh-notification-panel, .gdh-fomo, .gdh-tooltip, .gdh-tokenblock';
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

  chrome.storage.local.get({ monitorFomoConfig: null, monitorPumpConfig: null }, (stored) => {
    if (stored?.monitorFomoConfig) loadMonitorFomoCfg(stored.monitorFomoConfig);
    if (stored?.monitorPumpConfig) loadMonitorPumpCfg(stored.monitorPumpConfig);
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

  chrome.storage.local.get({ [MANI_SEEN_STORE_KEY]: [] }, (stored) => {
    mergeManiSeenKeys(stored[MANI_SEEN_STORE_KEY]);
    maniSeenLoaded = true;
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let fomoTokenArrived = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key === MANI_SEEN_STORE_KEY) {
        mergeManiSeenKeys(change.newValue);
        continue;
      }
      if (key === 'fomoToken') {
        fomoTokenArrived = !!change.newValue?.token;
        continue;
      }
      if (key === 'monitorFomoConfig') {
        loadMonitorFomoCfg(change.newValue);
        continue;
      }
      if (key === 'monitorPumpConfig') {
        loadMonitorPumpCfg(change.newValue);
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
    if (fomoTokenArrived && fomoPanelEl) {
      fomoLoadedKey = '';
      fomoErrKey = '';
      loadFomoData(true);
    }
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildBlockedTokenIndex();
    rebuildSpecialWalletSet();
    rebuildHoldingWatch();
    scheduleScan();
  });

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'gdh-fomo-push') {
        fomoFeedLastPollAt = 0;
        pollFomoFeed();
      }
      if (msg?.type === 'gdh-pump-push') {
        pumpFeedLastPollAt = 0;
        pollPumpFeed();
      }
    });
  } catch {
  }

  window.setInterval(() => {
    if (document.visibilityState !== 'hidden') scanVisibleCards();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dismissTooltipForLifecycle();
    else scheduleScan();
  });
})();
