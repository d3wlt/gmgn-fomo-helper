'use strict';

const MONITOR985_SYNC_ALARM = '985gmgn-account-sync';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(MONITOR985_SYNC_ALARM, { periodInMinutes: 5 });
  refreshMonitor985Config(true).then(() => restartFomoSse());
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(MONITOR985_SYNC_ALARM, { periodInMinutes: 5 });
  fomoKeepAlive(true);
  refreshMonitor985Config(true).then(() => restartFomoSse());
});

const FOMO_KEEPALIVE_ALARM = '985gmgn-fomo-keepalive';
chrome.alarms.get(FOMO_KEEPALIVE_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(FOMO_KEEPALIVE_ALARM, { periodInMinutes: 5 });
}).catch(() => {});
chrome.alarms.get(MONITOR985_SYNC_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(MONITOR985_SYNC_ALARM, { periodInMinutes: 5 });
}).catch(() => {});

const FOMO_REFRESH_AHEAD_MS = 20 * 60000;
const FOMO_KEEPER_URL = 'https://fomo.family/?gdh_keeper=1';
let fomoKeepAliveAt = 0;


async function fomoOpenTabs() {
  try {
    return await chrome.tabs.query({ url: ['https://fomo.family/*', 'https://*.fomo.family/*'] });
  } catch {
    return [];
  }
}

async function fomoPageAlive() {
  try {
    const { fomoPage } = await chrome.storage.local.get('fomoPage');
    return !!(fomoPage?.at && Date.now() - fomoPage.at < 45000);
  } catch {
    return false;
  }
}


async function fomoEnsureSdkOwner(requireDedicated = false) {
  try {
    const tabs = await fomoOpenTabs();
    const keepers = tabs.filter((tab) => String(tab.url || '').includes('gdh_keeper='));
    let owner = keepers.find((tab) => !tab.discarded) || keepers[0];
    let created = false;
    if (!owner && !requireDedicated) owner = tabs.find((tab) => !tab.discarded && tab.status === 'complete');
    if (!owner && !requireDedicated) owner = tabs.find((tab) => !tab.discarded);
    if (!owner) {
      owner = await chrome.tabs.create({ url: FOMO_KEEPER_URL, active: false, pinned: true });
      created = true;
      await fomoAuthNote('keeper-created');
    }
    const dedicated = String(owner.url || '').includes('gdh_keeper=');
    const wasDiscarded = !!owner.discarded;
    owner = await chrome.tabs.update(owner.id, {
      autoDiscardable: false,
      ...(dedicated ? { pinned: true } : {}),
    });
    if (wasDiscarded || (requireDedicated && dedicated && !created)) {
      await chrome.tabs.reload(owner.id);
      await fomoAuthNote(wasDiscarded ? 'keeper-reloaded' : 'keeper-woken');
    }
    return owner;
  } catch (error) {
    await fomoAuthNote('keeper-failed', { message: String(error?.message || '').slice(0, 80) });
    return null;
  }
}


async function fomoWaitMirror(prevToken, timeoutMs = 35000) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 1000));
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (fomoToken?.token && fomoToken.token !== prevToken) return fomoToken;
  }
  return null;
}

async function fomoKeepAlive(force) {
  try {
    if (!force && Date.now() - fomoKeepAliveAt < 60000) return;
    fomoKeepAliveAt = Date.now();
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (!fomoToken?.refresh) return;
    const exp = Number(fomoToken.exp) || 0;
    const left = exp ? exp - Date.now() : 0;
    if (exp && left > FOMO_REFRESH_AHEAD_MS) return;

    const owner = await fomoEnsureSdkOwner();
    if (!owner) return;
    if (await fomoPageAlive()) {
      await fomoAuthNote('defer-to-page', { leftMin: Math.round(left / 60000) });
      if (force) await fomoRefreshSession();
      return;
    }
    await fomoEnsureSdkOwner(true);
    if (force) await fomoRefreshSession();
  } catch {
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FOMO_KEEPALIVE_ALARM) fomoKeepAlive();
  if (alarm.name === MONITOR985_SYNC_ALARM) {
    refreshMonitor985Config(true).then(() => restartFomoSse());
  }
});

const FOMO_API = 'https://prod-api.fomo.family';
const FOMO_CHAINS = '1,56,143,4663,8453,1399811149';
const FOMO_CACHE_MS = 20000;
const FOMO_CACHE_MAX = 60;
const fomoCache = new Map();

function setBoundedMap(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}


function firstObjectArray(value, depth) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'object' && value[0] !== null && !Array.isArray(value[0])) {
      const inner = firstObjectArray(value[0], depth + 1);
      const keys = Object.keys(value[0]);
      if (inner && inner.length && keys.length <= 4) return inner;
      return value;
    }
    return null;
  }
  for (const key of Object.keys(value).slice(0, 30)) {
    const hit = firstObjectArray(value[key], depth + 1);
    if (hit && hit.length) return hit;
  }
  return null;
}

let fomoRefreshInFlight = null;

async function fomoAuthNote(what, extra) {
  try {
    const { fomoAuthLog } = await chrome.storage.local.get('fomoAuthLog');
    const log = Array.isArray(fomoAuthLog) ? fomoAuthLog : [];
    log.unshift({ at: Date.now(), what, ...(extra || {}) });
    await chrome.storage.local.set({ fomoAuthLog: log.slice(0, 20) });
  } catch {
  }
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

async function fomoRefreshSession() {
  if (fomoRefreshInFlight) return fomoRefreshInFlight;
  fomoRefreshInFlight = (async () => {
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (!fomoToken?.refresh) return null;
    const owner = await fomoEnsureSdkOwner(!(await fomoPageAlive()));
    if (!owner) return null;
    const adopted = await fomoWaitMirror(fomoToken.token);
    if (adopted) {
      await fomoAuthNote('adopt-from-page', { expMin: Math.round((adopted.exp - Date.now()) / 60000) });
      return adopted;
    }
    const latest = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
    if (latest?.token && Number(latest.exp) > Date.now()) return latest;
    await fomoAuthNote('page-refresh-timeout');
    return null;
  })().catch(() => null);
  try {
    return await fomoRefreshInFlight;
  } finally {
    fomoRefreshInFlight = null;
  }
}

function fomoBodyUnauthed(body) {
  const inner = Number(body?.statusCode);
  return inner === 401 || inner === 403;
}


async function fomoAuthedFetch(path) {
  let stored = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
  if (stored?.refresh && stored.exp && stored.exp - Date.now() < 10000) {
    stored = (await fomoRefreshSession())
      || (await chrome.storage.local.get('fomoToken')).fomoToken
      || null;
  }
  const send = (token) => {
    const headers = { Accept: 'application/json', 'X-Supported-Chains': FOMO_CHAINS };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${FOMO_API}${path}`, { headers, credentials: 'include' });
  };
  let res = await send(stored?.token);
  let renewed = false;
  let bodyUnauthed = false;
  if (res.ok) {
    const probe = await res.clone().json().catch(() => null);
    bodyUnauthed = fomoBodyUnauthed(probe);
  }
  if ((res.status === 401 || bodyUnauthed) && stored?.refresh) {
    const next = await fomoRefreshSession();
    if (next?.token && next.token !== stored?.token) {
      renewed = true;
      stored = next;
      res = await send(next.token);
    } else if (!(await chrome.storage.local.get('fomoToken')).fomoToken) {
      stored = null;
    }
  }
  return { res, stored, renewed };
}

async function fomoFetchToken({ tokenAddress, networkId, kind }) {
  const key = `${kind}|${networkId}|${tokenAddress}`;
  const hit = fomoCache.get(key);
  if (hit && Date.now() - hit.at < FOMO_CACHE_MS) return hit.data;

  let token;

  let path;
  if (kind === 'thesis') {
    path = `/feed/token/thesis?tokenAddress=${tokenAddress}&networkId=${networkId}&threshold=0&limit=50`;
  } else if (kind === 'holders') {
    const tokens = encodeURIComponent(JSON.stringify([{ address: tokenAddress, networkId }]));
    path = `/hodlers/top?tokens=${tokens}`;
  } else {
    path = `/feed/token?tokenAddress=${tokenAddress}&networkId=${networkId}&excludeThesis=true&limit=50`;
  }
  try {
    const { res, stored, renewed } = await fomoAuthedFetch(path);
    token = stored?.token;
    if (!res.ok && res.status === 401 && !token) {
      return { ok: false, reason: 'no-token', status: 401, tokenAt: 0 };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const blocked = /cloudflare|cf-ray|<!DOCTYPE html/i.test(text);
      return {
        ok: false,
        reason: blocked ? 'blocked' : (res.status === 401 ? 'expired' : `http-${res.status}`),
        status: res.status,
        tokenAt: stored?.at || 0,
        renewed,
      };
    }
    const body = await res.json().catch(() => null);
    const inner = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(inner) && inner !== 200)) {
      const unauth = inner === 401 || inner === 403;
      return {
        ok: false,
        reason: unauth ? (token ? 'expired' : 'no-token') : `api-${inner || 'error'}`,
        status: inner || res.status,
        message: String(body?.message || '').slice(0, 120),
        tokenAt: stored?.at || 0,
        renewed,
      };
    }
    const ro = body?.responseObject;
    //   /hodlers/top -> responseObject[0] = { totalHolders, topHolders: [...] }
    //   /feed/token* -> responseObject   = { items: [...], hasNextPage, count }
    let items;
    let total;
    if (kind === 'holders') {
      const box = Array.isArray(ro) ? ro[0] : ro;
      items = box?.topHolders;
      total = Number(box?.totalHolders);
    } else {
      items = Array.isArray(ro) ? ro : ro?.items;
    }
    if (!Array.isArray(items)) items = firstObjectArray(ro, 0) || [];
    const data = { ok: true, items, count: items.length };
    if (Number.isFinite(total)) data.total = total;
    setBoundedMap(fomoCache, key, { at: Date.now(), data }, FOMO_CACHE_MAX);
    return data;
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: String(error?.message || '').slice(0, 80),
    };
  }
}

const FOMO_PNL_TTL = 10 * 60 * 1000;
const FOMO_PNL_CACHE_MAX = 500;
const fomoPnlCache = new Map();

async function fomoUserPnl7d({ userId }) {
  if (!userId) return { ok: false, reason: 'no-user' };
  const hit = fomoPnlCache.get(userId);
  if (hit && Date.now() - hit.at < FOMO_PNL_TTL) return hit.data;

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const path = `/v2/userTokens/aggregatedSnapshot?userId=${encodeURIComponent(userId)}&timestamp=${encodeURIComponent(since)}`;
  try {
    const { res } = await fomoAuthedFetch(path);
    if (!res.ok) return { ok: false, reason: res.status === 401 ? 'expired' : `http-${res.status}` };
    const body = await res.json().catch(() => null);
    const inner = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(inner) && inner !== 200)) {
      return { ok: false, reason: inner === 401 ? 'expired' : `api-${inner || 'error'}` };
    }
    const rows = (Array.isArray(body?.responseObject) ? body.responseObject : [])
      .filter((r) => r && Number.isFinite(Number(r.pnl)))
      .sort((a, b) => Number(a.snapshotId) - Number(b.snapshotId));
    if (rows.length < 2) {
      const data = { ok: true, pnl: null, equity: Number(rows[0]?.equity) || 0, points: rows.length };
      setBoundedMap(fomoPnlCache, userId, { at: Date.now(), data }, FOMO_PNL_CACHE_MAX);
      return data;
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const data = {
      ok: true,
      pnl: Number(last.pnl) - Number(first.pnl),
      equity: Number(last.equity) || 0,
      points: rows.length,
    };
    setBoundedMap(fomoPnlCache, userId, { at: Date.now(), data }, FOMO_PNL_CACHE_MAX);
    return data;
  } catch (error) {
    return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 80) };
  }
}

//                          / mainPool() / dividendContract() / quoteToken()
const FLAP_SEL = {
  getPoolStateData: '0x65761b95',
  taxRate: '0x771a3a1d',
  taxProcessor: '0xf3635019',
  mainPool: '0xa5a302d3',
  dividendContract: '0x6124e4e7',
  quoteToken: '0x217a4b70',
  feeConfigV3: '0x46e62d07',
  symbol: '0x95d89b41',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
};
const FLAP_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];

const SUPPLY_RPCS = {
  bsc: [...FLAP_RPCS, 'https://bsc-rpc.publicnode.com'],
  eth: ['https://ethereum-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
};
const FLAP_TTL = 60000;
const FLAP_CACHE_MAX = 400;
const FLAP_SYMBOL_CACHE_MAX = 600;
const flapCache = new Map();


function flapWords(hex) {
  const body = String(hex || '').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}
const flapNum = (word) => (word ? Number(BigInt('0x' + word)) : 0);


function flapString(hex) {
  const w = flapWords(hex);
  if (w.length < 3) return '';
  const len = Number(BigInt('0x' + w[1]));
  if (!len || len > 64) return '';
  const bytes = w.slice(2).join('').slice(0, len * 2);
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = parseInt(bytes.slice(i, i + 2), 16);
    if (code) out += String.fromCharCode(code);
  }
  return out.trim();
}

const flapSymbolCache = new Map();
const flapBig = (word) => (word ? BigInt('0x' + word).toString() : '0');
const flapAddr = (word) => (word ? '0x' + word.slice(24) : '');

async function flapRpc(rpc, calls) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calls.map((c, i) => ({
      jsonrpc: '2.0', id: i + 1, method: 'eth_call',
      params: [{ to: c.to, data: c.data }, 'latest'],
    }))),
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : [body];
  const byId = new Map(list.map((x) => [x.id, x]));
  return calls.map((_, i) => {
    const hit = byId.get(i + 1);
    if (!hit || hit.error) throw new Error(hit?.error?.message || 'rpc-error');
    return hit.result;
  });
}

async function flapTokenInfo({ token, rpc }) {
  const address = String(token || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return { ok: false, reason: 'bad-token' };
  const hit = flapCache.get(address);
  if (hit && Date.now() - hit.at < FLAP_TTL) return hit.data;

  const endpoints = [rpc, ...FLAP_RPCS].filter(Boolean);
  let lastError = '';
  for (const endpoint of endpoints) {
    try {
      const first = await flapRpc(endpoint, [
        { to: address, data: FLAP_SEL.getPoolStateData },
        { to: address, data: FLAP_SEL.taxRate },
        { to: address, data: FLAP_SEL.taxProcessor },
        { to: address, data: FLAP_SEL.mainPool },
        { to: address, data: FLAP_SEL.dividendContract },
        { to: address, data: FLAP_SEL.quoteToken },
      ]);
      const pool = flapWords(first[0]);
      if (!pool.length) throw new Error('not-flap');
      const processor = flapAddr(flapWords(first[2])[0]);

      let dist = null;
      if (/^0x[a-f0-9]{40}$/i.test(processor) && !/^0x0{40}$/i.test(processor)) {
        try {
          const [cfg] = await flapRpc(endpoint, [{ to: processor, data: FLAP_SEL.feeConfigV3 }]);
          const w = flapWords(cfg);
          if (w.length >= 15) {
            dist = {
              vault: [0, 1, 2, 3].map((i) => ({
                bps: flapNum(w[i]), address: flapAddr(w[11 + i]),
              })).filter((x) => x.bps > 0 || (x.address && !/^0x0{40}$/.test(x.address))),
              deflationBps: flapNum(w[4]),
              lpBps: flapNum(w[5]),
              dividendBps: flapNum(w[6]),
              feeRateBps: flapNum(w[7]),
              commissionBps: flapNum(w[9]),
              dividendToken: flapAddr(w[10]),
            };
          }
        } catch {
        }
      }

      const quoteAddr = flapAddr(flapWords(first[5])[0]);
      const divToken = dist?.dividendToken || '';
      const wanted = [address, quoteAddr, divToken]
        .filter((a) => a && !/^0x0{40}$/i.test(a));
      const missing = [...new Set(wanted)].filter((a) => !flapSymbolCache.has(a));
      if (missing.length) {
        try {
          const syms = await flapRpc(endpoint, missing.map((a) => ({ to: a, data: FLAP_SEL.symbol })));
          missing.forEach((a, i) => setBoundedMap(flapSymbolCache, a, flapString(syms[i]), FLAP_SYMBOL_CACHE_MAX));
        } catch {
        }
      }
      const symbolOf = (a) => (a && flapSymbolCache.get(a)) || '';
      const dividendSymbol = symbolOf(divToken);

      const data = {
        ok: true,
        token: address,
        dividendSymbol,
        tokenSymbol: symbolOf(address),
        quoteSymbol: symbolOf(quoteAddr),
        state: flapNum(pool[0]),
        buyTaxBps: flapNum(pool[1]),
        sellTaxBps: flapNum(pool[2]),
        taxBps: flapNum(flapWords(first[1])[0]),
        liqThreshold: flapBig(pool[3]),
        taxExpiry: flapNum(pool[4]),
        processor,
        mainPool: flapAddr(flapWords(first[3])[0]),
        dividendContract: flapAddr(flapWords(first[4])[0]),
        quoteToken: flapAddr(flapWords(first[5])[0]),
        dist,
        rpc: endpoint,
      };
      setBoundedMap(flapCache, address, { at: Date.now(), data }, FLAP_CACHE_MAX);
      return data;
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 80);
      if (lastError === 'not-flap' || /revert|invalid opcode|execution error/i.test(lastError)) {
        lastError = 'not-flap';
        break;
      }
    }
  }
  const data = { ok: false, reason: lastError === 'not-flap' ? 'not-flap' : 'rpc-failed', message: lastError };
  setBoundedMap(flapCache, address, { at: Date.now(), data }, FLAP_CACHE_MAX);
  return data;
}

const supplyCache = new Map();
const SUPPLY_CACHE_MAX = 500;

async function gmgnTokenSupply(chain, address, apiQuery) {
  if (!apiQuery) return 0;
  try {
    const res = await fetch(`https://gmgn.ai/api/v1/mutil_window_token_info?${apiQuery}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain, addresses: [address] }),
    });
    if (!res.ok) return 0;
    const body = await res.json().catch(() => null);
    const item = body?.data?.[0];
    const raw = item?.total_supply ?? item?.max_supply ?? item?.circulating_supply;
    const supply = Number(raw);
    return Number.isFinite(supply) && supply > 0 ? supply : 0;
  } catch {
    return 0;
  }
}

async function tokenSupply({ chain, address, rpc, apiQuery }) {
  const chainKey = String(chain || '').toLowerCase();
  const chainRpcs = SUPPLY_RPCS[chainKey];
  const looksEvm = /^0x[a-fA-F0-9]{40}$/i.test(address || '');
  const looksSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || '');
  if (!chainKey || (!looksEvm && !looksSol)) {
    return { ok: false, reason: 'unsupported-chain' };
  }
  const normalizedAddress = looksEvm ? String(address).toLowerCase() : String(address);
  const key = `${chainKey}:${normalizedAddress}`;
  if (supplyCache.has(key)) return { ok: true, supply: supplyCache.get(key) };

  const viaGmgn = await gmgnTokenSupply(chain, address, apiQuery);
  if (viaGmgn > 0) {
    setBoundedMap(supplyCache, key, viaGmgn, SUPPLY_CACHE_MAX);
    return { ok: true, supply: viaGmgn };
  }

  if (!chainRpcs || !looksEvm) return { ok: false, reason: 'unsupported-chain' };
  const endpoints = [chain === 'bsc' ? rpc : '', ...chainRpcs].filter(Boolean);
  let lastError = '';
  for (const endpoint of endpoints) {
    try {
      const [rawSupply, rawDec] = await flapRpc(endpoint, [
        { to: address, data: FLAP_SEL.totalSupply },
        { to: address, data: FLAP_SEL.decimals },
      ]);
      const raw = BigInt(rawSupply || '0x0');
      const dec = Number(BigInt(rawDec || '0x12'));
      if (!raw || !Number.isFinite(dec) || dec > 36) return { ok: false, reason: 'bad-data' };
      const supply = Number(raw) / Math.pow(10, dec);
      if (!Number.isFinite(supply) || supply <= 0) return { ok: false, reason: 'bad-data' };
      setBoundedMap(supplyCache, key, supply, SUPPLY_CACHE_MAX);
      return { ok: true, supply };
    } catch (error) {
      lastError = String(error?.message || '').slice(0, 80);
    }
  }
  return { ok: false, reason: 'rpc', message: lastError };
}


const MONITOR985_ORIGIN = 'https://www.985monitor.xyz';
const MONITOR985_CONFIG_URL = `${MONITOR985_ORIGIN}/api/extension/config`;
const FOMO_FEED_URL = `${MONITOR985_ORIGIN}/api/extension/fomo-events?limit=150`;
const PUMP_FEED_URL = `${MONITOR985_ORIGIN}/api/extension/pump-trade-events?limit=150`;
const MONITOR985_CONFIG_TTL_MS = 3 * 60 * 1000;
let monitor985ConfigInflight = null;

async function monitor985Session() {
  const stored = await chrome.storage.local.get({ monitor985SessionV1: null });
  const session = stored.monitor985SessionV1;
  if (!session?.token || Number(session.expiresAt) <= Date.now()) return null;
  return session;
}

function monitor985AuthHeaders(session, extra = {}) {
  return { ...extra, Authorization: `Bearer ${session.token}` };
}

function resetMonitor985EventCaches() {
  fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
  fomoFeedEtag = '';
  pumpFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
  pumpDefaultWatchCache = { wallets: [], fetchedAt: 0 };
}

async function markMonitor985Disconnected(reason, clearSession = false) {
  resetMonitor985EventCaches();
  const patch = {
    monitorFomoConfig: { connected: false, at: Date.now() },
    monitorPumpConfig: { connected: false, at: Date.now() },
    monitor985SyncStateV1: { connected: false, reason, checkedAt: Date.now() },
  };
  if (clearSession) patch.monitor985SessionV1 = null;
  await chrome.storage.local.set(patch);
}

async function applyMonitor985Config(config, session) {
  if (!config?.connected || !config?.account?.userId) return false;
  const stored = await chrome.storage.local.get({ monitor985SyncStateV1: null });
  const previousAccount = String(stored.monitor985SyncStateV1?.accountId || '');
  if (previousAccount && previousAccount !== String(config.account.userId)) resetMonitor985EventCaches();
  const at = Date.now();
  await chrome.storage.local.set({
    monitorFomoConfig: { ...(config.fomo || {}), wallet: config.account.userId, connected: true, revision: config.revision, at },
    monitorPumpConfig: { ...(config.pump || {}), wallet: config.account.userId, connected: true, revision: config.revision, at },
    monitor985SyncStateV1: {
      connected: true,
      accountId: config.account.userId,
      displayName: String(config.account.displayName || ''),
      syncedAt: at,
      expiresAt: Number(session?.expiresAt || config.sessionExpiresAt) || 0,
    },
  });
  return true;
}

async function refreshMonitor985Config(force = false) {
  if (monitor985ConfigInflight) return monitor985ConfigInflight;
  monitor985ConfigInflight = (async () => {
    const stored = await chrome.storage.local.get({ monitor985SessionV1: null, monitor985SyncStateV1: null });
    const session = stored.monitor985SessionV1;
    if (!session?.token || Number(session.expiresAt) <= Date.now()) {
      await markMonitor985Disconnected('login-required', Boolean(session));
      return false;
    }
    if (!force && stored.monitor985SyncStateV1?.connected
      && Date.now() - Number(stored.monitor985SyncStateV1.syncedAt) < MONITOR985_CONFIG_TTL_MS) return true;
    try {
      const response = await fetch(MONITOR985_CONFIG_URL, {
        headers: monitor985AuthHeaders(session, { Accept: 'application/json' }),
        cache: 'no-store',
      });
      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
        return false;
      }
      if (!response.ok || body?.ok !== true || !body?.config) throw new Error(`HTTP ${response.status}`);
      return applyMonitor985Config(body.config, session);
    } catch {
      return Boolean(stored.monitor985SyncStateV1?.connected);
    }
  })().finally(() => { monitor985ConfigInflight = null; });
  return monitor985ConfigInflight;
}

const FOMO_FEED_MIN_INTERVAL_MS = 15000;
const FOMO_FEED_KEEP = 150;
let fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
let fomoFeedEtag = '';
let fomoFeedFailCount = 0;
let fomoFeedBackoffUntil = 0;
let fomoFeedInflight = null;

const FOMO_FEED_TYPE = {
  FOMO_BUY: 'buy',
  FOMO_SELL: 'sell',
  FOMO_SWAP: 'swap',
  FOMO_THESIS: 'thesis',
  FOMO_TRANSFER_IN: 'transferIn',
  FOMO_REFUND: 'refund',
};

const FOMO_CHAIN_SLUG = { bnb: 'bsc', bsc: 'bsc', sol: 'sol', solana: 'sol', eth: 'eth', ethereum: 'eth', base: 'base', robinhood: 'robinhood', 'chain 143': 'monad' };

function slimFomoEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = FOMO_FEED_TYPE[String(raw.eventType || '')];
  if (!type) return null;
  const ts = Number(raw.ts) || Date.parse(raw.createdAt || '') || 0;
  if (!ts) return null;
  const chainName = String(raw.chainName || '').trim();
  const content = raw.content && typeof raw.content === 'object' ? raw.content : {};
  return {
    key: String(raw.key || '').slice(0, 120),
    source: 'fomo',
    type,
    handle: String(raw.handle || '').toLowerCase().slice(0, 64),
    name: String(raw.userName || raw.handle || '').slice(0, 48),
    avatar: String(raw.avatar || '').slice(0, 300),
    usd: Number(raw.usd) || 0,
    comment: String(raw.comment || content.comment || content.text
      || (type === 'refund' ? `On-chain transaction failed · ${String(raw.failReason || 'Refunded')}` : '')).slice(0, 1500),
    addr: String(raw.tokenAddress || '').slice(0, 64),
    chain: FOMO_CHAIN_SLUG[chainName.toLowerCase()] || chainName.toLowerCase(),
    chainName,
    symbol: String(raw.symbol || '').slice(0, 24),
    img: String(raw.tokenImage || '').slice(0, 300),
    mc: Number(raw.marketCap) || 0,
    ts,
    tx: String(raw.txHash || raw.transactionHash || raw.transaction_hash
      || content.txHash || content.transactionHash || content.transaction_hash || '').trim().slice(0, 180),
  };
}

async function fetchFomoFeed() {
  if (fomoFeedInflight) return fomoFeedInflight;
  const session = await monitor985Session();
  if (!session) return { ok: false, reason: 'not-connected', events: [] };
  await refreshMonitor985Config(false);
  const now = Date.now();
  if (now - fomoFeedCache.fetchedAt < FOMO_FEED_MIN_INTERVAL_MS || now < fomoFeedBackoffUntil) {
    return { ok: true, ...fomoFeedCache, stale: true };
  }
  fomoFeedInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const headers = monitor985AuthHeaders(session, fomoFeedEtag ? { 'If-None-Match': fomoFeedEtag } : {});
      let response;
      try {
        response = await fetch(FOMO_FEED_URL, { headers, cache: 'no-store', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 304) {
        fomoFeedCache.fetchedAt = Date.now();
        fomoFeedFailCount = 0;
        return { ok: true, ...fomoFeedCache };
      }
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
        return { ok: false, reason: 'not-connected', events: [] };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const events = (Array.isArray(body?.events) ? body.events : [])
        .map(slimFomoEvent)
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, FOMO_FEED_KEEP);
      fomoFeedCache = { events, updatedAt: Number(body?.updatedAt) || Date.now(), fetchedAt: Date.now() };
      fomoFeedEtag = response.headers.get('ETag') || '';
      fomoFeedFailCount = 0;
      fomoFeedBackoffUntil = 0;
      return { ok: true, ...fomoFeedCache };
    } catch (error) {
      fomoFeedFailCount += 1;
      fomoFeedBackoffUntil = Date.now() + Math.min(15 * 60000, 60000 * Math.pow(2, fomoFeedFailCount - 1));
      if (fomoFeedCache.events.length) return { ok: true, ...fomoFeedCache, stale: true };
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    } finally {
      fomoFeedInflight = null;
    }
  })();
  return fomoFeedInflight;
}


const PUMP_FEED_MIN_INTERVAL_MS = 15000;
const PUMP_FEED_KEEP = 150;
let pumpFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
let pumpFeedFailCount = 0;
let pumpFeedBackoffUntil = 0;
let pumpFeedInflight = null;
let pumpDefaultWatchCache = { wallets: [], fetchedAt: 0 };

function pumpFeedHttpsUrl(raw, allowLocalAvatar = false) {
  const value = String(raw || '').trim();
  if (allowLocalAvatar && value.startsWith('/pump-avatars/')) {
    return `https://www.985monitor.xyz${value}`.slice(0, 400);
  }
  return /^https:\/\//i.test(value) ? value.slice(0, 400) : '';
}

function pumpFeedChainSlug(trade) {
  const direct = String(trade?.chainSlug || trade?.chain || '').trim().toLowerCase();
  if (/^(sol|bsc|base|eth|robinhood|hyperevm)$/.test(direct)) return direct;
  const byName = {
    sol: 'sol', solana: 'sol', bnb: 'bsc', bsc: 'bsc', binance: 'bsc',
    base: 'base', eth: 'eth', ethereum: 'eth', robinhood: 'robinhood',
    hyperliquid: 'hyperevm', hyperevm: 'hyperevm',
  };
  const named = byName[String(trade?.chainName || '').trim().toLowerCase()];
  if (named) return named;
  return ({ 1: 'eth', 56: 'bsc', 8453: 'base', 1399811149: 'sol' })[Number(trade?.chainId)] || '';
}

function slimPumpEvent(raw) {
  if (!raw || String(raw.eventType || '').toUpperCase() !== 'PUMP_TRADE') return null;
  const trade = raw?.content?.pumpTrade;
  if (!trade || typeof trade !== 'object') return null;
  const type = String(trade.side || '').trim().toLowerCase();
  if (type !== 'buy' && type !== 'sell') return null;
  const ts = Date.parse(trade.tradeTime || raw.createdAt || '') || Number(raw.ts) || 0;
  const chain = pumpFeedChainSlug(trade);
  const addr = String(trade.mint || trade.tokenAddress || trade.contractAddress || '').trim();
  const wallet = String(trade.wallet || '').trim();
  const key = String(raw.key || (trade.tx ? `pump:trade:${trade.tx}` : '')).slice(0, 180);
  if (!key || !ts || !chain || !addr || !wallet) return null;
  return {
    key,
    source: 'pump',
    type,
    handle: String(trade.username || trade.watchName || trade.walletName || '').trim().toLowerCase().slice(0, 64),
    name: String(trade.watchName || trade.walletName || trade.username || wallet).slice(0, 48),
    avatar: pumpFeedHttpsUrl(trade.avatar, true),
    usd: Number(trade.amountUsd) || 0,
    comment: '',
    addr: addr.slice(0, 80),
    chain,
    chainName: String(trade.chainName || '').slice(0, 32),
    symbol: String(trade.symbol || '').slice(0, 24),
    img: pumpFeedHttpsUrl(trade.image),
    mc: Number(trade.marketCapUsd) || 0,
    ts,
    tx: String(trade.tx || '').trim().slice(0, 180),
    pumpWallet: wallet.slice(0, 48),
    profileUrl: `https://pump.fun/profile/${encodeURIComponent(wallet)}`,
  };
}

async function fetchPumpFeed() {
  if (pumpFeedInflight) return pumpFeedInflight;
  const session = await monitor985Session();
  if (!session) return { ok: false, reason: 'not-connected', events: [], defaultWallets: [] };
  await refreshMonitor985Config(false);
  const now = Date.now();
  if (now - pumpFeedCache.fetchedAt < PUMP_FEED_MIN_INTERVAL_MS || now < pumpFeedBackoffUntil) {
    return { ok: true, ...pumpFeedCache, defaultWallets: [], stale: true };
  }
  pumpFeedInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      let response;
      try {
        response = await fetch(PUMP_FEED_URL, {
          headers: monitor985AuthHeaders(session),
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
        return { ok: false, reason: 'not-connected', events: [], defaultWallets: [] };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const events = (Array.isArray(body?.events) ? body.events : [])
        .map(slimPumpEvent)
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, PUMP_FEED_KEEP);
      pumpFeedCache = { events, updatedAt: Number(body?.updatedAt) || Date.now(), fetchedAt: Date.now() };
      pumpFeedFailCount = 0;
      pumpFeedBackoffUntil = 0;
      return { ok: true, ...pumpFeedCache, defaultWallets: [] };
    } catch (error) {
      pumpFeedFailCount += 1;
      pumpFeedBackoffUntil = Date.now() + Math.min(15 * 60000, 60000 * Math.pow(2, pumpFeedFailCount - 1));
      if (pumpFeedCache.events.length) {
        return { ok: true, ...pumpFeedCache, defaultWallets: [], stale: true };
      }
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    } finally {
      pumpFeedInflight = null;
    }
  })();
  return pumpFeedInflight;
}


const FOMO_SSE_URL = `${MONITOR985_ORIGIN}/api/extension/events-stream`;
let fomoSseAbort = null;
let fomoSseBackoff = 5000;
let fomoSseReconnectTimer = 0;
let fomoSseGeneration = 0;
let monitor985LastEventId = '';

function restartFomoSse() {
  fomoSseGeneration += 1;
  if (fomoSseReconnectTimer) clearTimeout(fomoSseReconnectTimer);
  fomoSseReconnectTimer = 0;
  try { fomoSseAbort?.abort(); } catch {}
  fomoSseAbort = null;
  setTimeout(connectFomoSse, 0);
}

function trackingFeedComparableId(ev) {
  const tx = String(ev?.tx || '').trim();
  if (tx) return `tx:${tx.startsWith('0x') ? tx.toLowerCase() : tx}`;
  const key = String(ev?.key || '').trim();
  return key ? `key:${key}` : '';
}

function fomoSseNotifyTabs() {
  try {
    chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://debot.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'gdh-fomo-push' }, () => void chrome.runtime.lastError);
      }
    });
  } catch {
  }
}

function fomoSseIngest(raw) {
  const ev = slimFomoEvent(raw);
  if (!ev) return;
  const comparableId = trackingFeedComparableId(ev);
  const duplicate = fomoFeedCache.events.some((item) => item.key === ev.key
    || (comparableId && trackingFeedComparableId(item) === comparableId));
  const rest = fomoFeedCache.events.filter((item) => item.key !== ev.key
    && (!comparableId || trackingFeedComparableId(item) !== comparableId));
  rest.unshift(ev);
  rest.sort((a, b) => b.ts - a.ts);
  fomoFeedCache = { ...fomoFeedCache, events: rest.slice(0, FOMO_FEED_KEEP), updatedAt: Date.now() };
  if (!duplicate) fomoSseNotifyTabs();
}

function pumpSseNotifyTabs() {
  try {
    chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://debot.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'gdh-pump-push' }, () => void chrome.runtime.lastError);
      }
    });
  } catch {
  }
}

function pumpSseIngest(raw) {
  const ev = slimPumpEvent(raw);
  if (!ev) return;
  const comparableId = trackingFeedComparableId(ev);
  const duplicate = pumpFeedCache.events.some((item) => item.key === ev.key
    || (comparableId && trackingFeedComparableId(item) === comparableId));
  const rest = pumpFeedCache.events.filter((item) => item.key !== ev.key
    && (!comparableId || trackingFeedComparableId(item) !== comparableId));
  rest.unshift(ev);
  rest.sort((a, b) => b.ts - a.ts);
  pumpFeedCache = { ...pumpFeedCache, events: rest.slice(0, PUMP_FEED_KEEP), updatedAt: Date.now() };
  if (!duplicate) pumpSseNotifyTabs();
}

async function connectFomoSse() {
  if (fomoSseAbort) return;
  const session = await monitor985Session();
  if (!session || fomoSseAbort) return;
  await refreshMonitor985Config(false);
  const generation = fomoSseGeneration;
  const controller = new AbortController();
  fomoSseAbort = controller;
  try {
    const response = await fetch(FOMO_SSE_URL, {
      headers: monitor985AuthHeaders(session, {
        Accept: 'text/event-stream',
        ...(monitor985LastEventId ? { 'Last-Event-ID': monitor985LastEventId } : {}),
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 401) {
      await markMonitor985Disconnected('unauthorized', true);
      return;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    fomoSseBackoff = 5000;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let eventId = '';
    let dataLines = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') {
          if ((eventType === 'fomo' || eventType === 'pump-trade') && dataLines.length) {
            try {
              const payload = JSON.parse(dataLines.join('\n'));
              if (payload?.event && eventType === 'fomo') fomoSseIngest(payload.event);
              if (payload?.event && eventType === 'pump-trade') pumpSseIngest(payload.event);
            } catch {
            }
          }
          if (eventId) monitor985LastEventId = eventId;
          eventType = '';
          eventId = '';
          dataLines = [];
          continue;
        }
        if (line.startsWith('id:')) eventId = line.slice(3).trim();
        else if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    }
  } catch {
  } finally {
    if (fomoSseAbort === controller) fomoSseAbort = null;
  }
  if (generation !== fomoSseGeneration || !(await monitor985Session())) return;
  fomoSseReconnectTimer = setTimeout(() => {
    fomoSseReconnectTimer = 0;
    connectFomoSse();
  }, fomoSseBackoff);
  fomoSseBackoff = Math.min(120000, fomoSseBackoff * 2);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.monitor985SessionV1) return;
  resetMonitor985EventCaches();
  monitor985LastEventId = '';
  fomoSseBackoff = 5000;
  restartFomoSse();
});


const MARKED_FEED_URL = 'https://www.985monitor.xyz/marked-holdings.json';
const MARKED_FEED_MIN_INTERVAL_MS = 120000;
let markedFeedCache = { doc: null, fetchedAt: 0 };
let markedFeedEtag = '';
let markedFeedFailCount = 0;
let markedFeedBackoffUntil = 0;
let markedFeedInflight = null;

async function fetchMarkedFeed() {
  if (markedFeedInflight) return markedFeedInflight;
  const now = Date.now();
  if ((now - markedFeedCache.fetchedAt < MARKED_FEED_MIN_INTERVAL_MS || now < markedFeedBackoffUntil)) {
    return markedFeedCache.doc ? { ok: true, ...markedFeedCache.doc, stale: true } : { ok: false, reason: 'not-ready' };
  }
  markedFeedInflight = (async () => {
    try {
      const headers = markedFeedEtag ? { 'If-None-Match': markedFeedEtag } : {};
      const response = await fetch(MARKED_FEED_URL, { headers, cache: 'no-store' });
      if (response.status === 304) {
        markedFeedCache.fetchedAt = Date.now();
        markedFeedFailCount = 0;
        return { ok: true, ...markedFeedCache.doc };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = await response.json();
      if (!doc || !Array.isArray(doc.holdings)) throw new Error('bad-body');
      markedFeedCache = { doc, fetchedAt: Date.now() };
      markedFeedEtag = response.headers.get('ETag') || '';
      markedFeedFailCount = 0;
      markedFeedBackoffUntil = 0;
      return { ok: true, ...doc };
    } catch (error) {
      markedFeedFailCount += 1;
      markedFeedBackoffUntil = Date.now() + Math.min(15 * 60000, 60000 * Math.pow(2, markedFeedFailCount - 1));
      if (markedFeedCache.doc) return { ok: true, ...markedFeedCache.doc, stale: true };
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    } finally {
      markedFeedInflight = null;
    }
  })();
  return markedFeedInflight;
}

const HOLDING_WATCH_PER_CHAIN_MAX = 100;
let holdingWatchWriteQueue = Promise.resolve();

function normalizeHoldingWatchItem(raw, forcedChain = '') {
  const chain = String(forcedChain || raw?.chain || '').trim().toLowerCase();
  const sourceAddress = String(raw?.address || '').trim();
  const evm = /^0x[a-fA-F0-9]{40}$/.test(sourceAddress);
  const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sourceAddress);
  if (!/^[a-z0-9]{2,16}$/.test(chain) || (!evm && !sol)) return null;
  const address = evm ? sourceAddress.toLowerCase() : sourceAddress;
  const cost = Number(raw?.cost);
  return {
    chain,
    address,
    symbol: String(raw?.symbol || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24),
    cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    at: Number(raw?.at) > 0 ? Number(raw.at) : Date.now(),
  };
}

function mergeHoldingWatchList(current, chain, incoming, replace) {
  const normalizedChain = String(chain || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,16}$/.test(normalizedChain)) return Array.isArray(current) ? current : [];
  const map = new Map();
  for (const raw of (Array.isArray(current) ? current : [])) {
    const item = normalizeHoldingWatchItem(raw);
    if (!item || (replace && item.chain === normalizedChain)) continue;
    map.set(`${item.chain}:${item.address}`, item);
  }
  for (const raw of (Array.isArray(incoming) ? incoming : [])) {
    const item = normalizeHoldingWatchItem(raw, normalizedChain);
    if (!item) continue;
    map.set(`${item.chain}:${item.address}`, item);
  }
  const counts = new Map();
  return [...map.values()]
    .sort((a, b) => b.at - a.at)
    .filter((item) => {
      const count = counts.get(item.chain) || 0;
      if (count >= HOLDING_WATCH_PER_CHAIN_MAX) return false;
      counts.set(item.chain, count + 1);
      return true;
    });
}

function updateHoldingWatchList(payload) {
  const chain = String(payload?.chain || '').trim().toLowerCase();
  const items = Array.isArray(payload?.items) ? payload.items.slice(0, HOLDING_WATCH_PER_CHAIN_MAX) : [];
  const replace = payload?.replace === true;
  holdingWatchWriteQueue = holdingWatchWriteQueue.then(async () => {
    const { holdingWatchList } = await chrome.storage.local.get({ holdingWatchList: [] });
    const next = mergeHoldingWatchList(holdingWatchList, chain, items, replace);
    await chrome.storage.local.set({ holdingWatchList: next });
    return { ok: true, count: next.length };
  });
  return holdingWatchWriteQueue;
}

const NOTIFICATION_HISTORY_KEY = 'notificationHistoryV1';
const NOTIFICATION_HISTORY_READ_AT_KEY = 'notificationHistoryReadAtV1';
const NOTIFICATION_HISTORY_MAX = 100;
let notificationHistoryWriteQueue = Promise.resolve();

function cleanNotificationText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function normalizeNotificationHistoryItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at) > 0 ? Number(raw.at) : Date.now();
  const tag = cleanNotificationText(raw.tag, 24);
  const symbol = cleanNotificationText(raw.symbol, 32);
  const label = cleanNotificationText(raw.label, 32);
  const value = cleanNotificationText(raw.value, 96);
  const bell = cleanNotificationText(raw.bell, 8);
  const dir = raw.dir === 'up' || raw.dir === 'down' ? raw.dir : '';
  const rawHref = cleanNotificationText(raw.href, 512);
  const href = /^\/[a-z0-9]+\/token\/[A-Za-z0-9]+(?:[/?#].*)?$/.test(rawHref) ? rawHref : '';
  if (!tag && !symbol && !label && !value) return null;
  const fallbackId = `${at}-${tag}-${symbol}-${value}`.slice(0, 160);
  const id = cleanNotificationText(raw.id, 160) || fallbackId;
  return { id, at, tag, symbol, label, value, bell, dir, href };
}

function notificationHistoryFingerprint(item) {
  return [item.tag, item.symbol, item.label, item.value, item.dir, item.href].join('\n');
}

function mergeNotificationHistory(current, incoming) {
  const next = normalizeNotificationHistoryItem(incoming);
  const normalized = (Array.isArray(current) ? current : [])
    .map(normalizeNotificationHistoryItem)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  if (!next) return normalized.slice(0, NOTIFICATION_HISTORY_MAX);
  const duplicate = normalized.find((item) => (
    Math.abs(next.at - item.at) < 5000
    && notificationHistoryFingerprint(item) === notificationHistoryFingerprint(next)
  ));
  const combined = duplicate ? normalized : [next, ...normalized];
  const seen = new Set();
  return combined.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, NOTIFICATION_HISTORY_MAX);
}

function appendNotificationHistory(payload) {
  notificationHistoryWriteQueue = notificationHistoryWriteQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get({ [NOTIFICATION_HISTORY_KEY]: [] });
    const next = mergeNotificationHistory(stored[NOTIFICATION_HISTORY_KEY], {
      ...payload,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
    });
    await chrome.storage.local.set({ [NOTIFICATION_HISTORY_KEY]: next });
    return { ok: true, count: next.length };
  });
  return notificationHistoryWriteQueue;
}

function markNotificationHistoryRead() {
  notificationHistoryWriteQueue = notificationHistoryWriteQueue.catch(() => {}).then(async () => {
    const readAt = Date.now();
    await chrome.storage.local.set({ [NOTIFICATION_HISTORY_READ_AT_KEY]: readAt });
    return { ok: true, readAt };
  });
  return notificationHistoryWriteQueue;
}

function clearNotificationHistory() {
  notificationHistoryWriteQueue = notificationHistoryWriteQueue.catch(() => {}).then(async () => {
    const readAt = Date.now();
    await chrome.storage.local.set({
      [NOTIFICATION_HISTORY_KEY]: [],
      [NOTIFICATION_HISTORY_READ_AT_KEY]: readAt,
    });
    return { ok: true, readAt };
  });
  return notificationHistoryWriteQueue;
}

async function recordFomoPageHeartbeat(message, sender) {
  try {
    const tabId = Number(sender?.tab?.id);
    const pageUrl = new URL(String(sender?.tab?.url || ''));
    if (!Number.isInteger(tabId) || !(pageUrl.hostname === 'fomo.family' || pageUrl.hostname.endsWith('.fomo.family'))) return;
    const keeper = message?.keeper === true || pageUrl.searchParams.has('gdh_keeper');
    await chrome.storage.local.set({
      fomoPage: { at: Date.now(), visible: message?.visible === true, tabId, keeper },
    });
    if (!keeper) {
      const tabs = await fomoOpenTabs();
      const extraIds = tabs
        .filter((tab) => tab.id !== tabId && String(tab.url || '').includes('gdh_keeper='))
        .map((tab) => tab.id)
        .filter(Number.isInteger);
      if (extraIds.length) {
        await chrome.tabs.remove(extraIds);
        await fomoAuthNote('keeper-closed-for-page', { tabs: extraIds.length });
      }
    }
  } catch {
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === '985-monitor-session-updated') {
    refreshMonitor985Config(true)
      .then((ok) => { restartFomoSse(); sendResponse({ ok: Boolean(ok) }); })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'fomo-page-heartbeat') {
    recordFomoPageHeartbeat(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  fomoKeepAlive();

  if (message?.type === 'fomo-force-refresh') {
    fomoKeepAlive(true)
      .then(() => chrome.storage.local.get('fomoToken'))
      .then(({ fomoToken }) => {
        const exp = Number(fomoToken?.exp) || 0;
        sendResponse({ ok: !!fomoToken?.token && exp > Date.now(), exp });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'marked-holdings') {
    fetchMarkedFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'holding-watch-update') {
    updateHoldingWatchList(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'notification-history-add') {
    appendNotificationHistory(message.payload || {})
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'notification-history-read') {
    markNotificationHistoryRead()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'notification-history-clear') {
    clearNotificationHistory()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'fomo-feed') {
    connectFomoSse();
    fetchFomoFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'pump-feed') {
    connectFomoSse();
    fetchPumpFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'token-supply') {
    tokenSupply(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'flap-token-info') {
    flapTokenInfo(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'fomo-user-pnl') {
    fomoUserPnl7d(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'fomo-token-feed') {
    fomoFetchToken(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  return false;
});
