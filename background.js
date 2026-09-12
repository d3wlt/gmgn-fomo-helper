'use strict';

importScripts('debug-log.js');

// Upgrade cleanup only: retired provider data cannot start collectors.
chrome.alarms.clear?.('985gmgn-j7tracker-sync')?.catch(() => {});
chrome.storage.local.remove(['j7TrackerSessionV1', 'j7TrackerSyncStateV1',
  'j7TrackerFomoConfigV1', 'j7TrackerPumpConfigV1', 'enablePumpFeed',
  'debotFomoPanelOpen', 'debotFomoPanelTab']).catch(() => {});
chrome.storage.session?.remove('j7TrackerCacheV1')?.catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove([
    'monitor985SessionV1', 'monitor985ClientIdV1', 'monitor985SyncStateV1',
    'monitorFomoConfig', 'monitorPumpConfig',
  ]).catch(() => {});
});

const FOMO_KEEPALIVE_ALARM = '985gmgn-fomo-keepalive';
// Remove legacy autonomous keeper scheduling on upgrade.
chrome.alarms.clear?.(FOMO_KEEPALIVE_ALARM)?.catch(() => {});

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
  const message = String(body?.error || body?.message || '').toLowerCase();
  return inner === 401 || inner === 403 || inner === 430 || inner === 431
    || message.includes('unauthorized') || message.includes('unauthenticated');
}

function fomoBodyFailed(body) {
  if (!body || typeof body !== 'object') return true;
  if (body.success === false) return true;
  if (!Object.prototype.hasOwnProperty.call(body, 'statusCode')) return false;
  const inner = Number(body.statusCode);
  return !Number.isFinite(inner) || inner !== 200;
}

function fomoActivitySide(raw) {
  const direct = String(raw?.side || raw?.tradeSide || raw?.tradeType || raw?.type || raw?.body?.type || raw?.action || '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
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

const FOMO_NETWORK_SLUG = {
  1: 'eth', 56: 'bsc', 143: 'monad', 4663: 'robinhood', 8453: 'base', 1399811149: 'sol',
};

function fomoNetworkSlug(raw) {
  const networkId = Number(raw?.networkId ?? raw?.chainId ?? raw?.body?.networkId);
  if (FOMO_NETWORK_SLUG[networkId]) return FOMO_NETWORK_SLUG[networkId];
  const direct = String(raw?.chainSlug || raw?.chain || raw?.network || '').trim().toLowerCase();
  const aliases = { bnb: 'bsc', solana: 'sol', ethereum: 'eth', robinhoodchain: 'robinhood' };
  return aliases[direct] || (/^[a-z0-9]{2,16}$/.test(direct) ? direct : '');
}

function fomoHttpsUrl(raw) {
  const value = String(raw || '').trim();
  return /^https:\/\//i.test(value) ? value.slice(0, 400) : '';
}

function slimFomoFollowedEvent(raw, followedIds) {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw.body && typeof raw.body === 'object' ? raw.body : {};
  const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
  const userId = String(raw.userId || raw.authorId || user.id || body.userId || body.authorId || '').trim();
  if (!userId || !(followedIds instanceof Set) || !followedIds.has(userId)) return null;
  const type = fomoActivitySide(raw);
  if (type !== 'buy' && type !== 'sell' && type !== 'thesis') return null;
  const ts = Date.parse(raw.createdAt || raw.timestamp || '') || Number(raw.ts) || 0;
  if (!ts) return null;
  const trade = raw.authorTrade && typeof raw.authorTrade === 'object' ? raw.authorTrade : {};
  const token = raw.token && typeof raw.token === 'object' ? raw.token : {};
  const addr = String(raw.tokenAddress || body.tokenAddress || token.address || '').trim();
  const networkId = Number(raw.networkId ?? body.networkId ?? token.networkId);
  const handle = String(raw.userHandle || raw.handle || user.userHandle || user.handle || body.userHandle || '').trim().replace(/^@/, '');
  const providerEventId = String(raw.id || raw.key || '').slice(0, 180);
  const swapId = String(raw.swapId || '').slice(0, 128);
  const commentId = type === 'thesis' ? String(raw.commentId || body.commentId || raw.comment?.id || raw.tradeComment?.id || (raw.type === 'thesis' && raw.dataSource !== 'trading-activity' ? raw.id : '') || '').slice(0, 128) : '';
  if (commentId && raw.tradeComment?.id != null && String(raw.tradeComment.id) !== commentId) return null;
  const key = commentId ? `comment:${commentId}` : swapId ? `swap:${swapId}` : providerEventId ? `event:${providerEventId}` : '';
  if (!key) return null;
  const rawComment = raw.comment && typeof raw.comment === 'object' ? raw.comment.comment : raw.comment;
  const comment = String(rawComment || raw.text || raw.thesis || body.comment || body.text || '').slice(0, 1500);
  const nativeUsd = type === 'thesis' ? trade.usdValue : raw.usdAmount;
  const nativeUsdValid = ['number','string'].includes(typeof nativeUsd) && String(nativeUsd).trim() !== '' && Number.isFinite(Number(nativeUsd));
  return {
    key: `fomo-followed:${key}`,
    source: 'fomo-followed',
    dataSource: raw.dataSource || 'fallback',
    usdSource: raw.dataSource === 'trading-activity' ? (type === 'thesis' ? 'authorTrade.usdValue' : 'usdAmount') : raw.usdSource || 'fallback',
    mcSource: raw.dataSource === 'trading-activity' ? (raw.fdv != null ? 'alerts-fdv' : raw.marketCap != null ? 'alerts-market-cap' : 'alerts-unavailable') : raw.mcSource || 'provider',
    type,
    position: fomoActivityPosition(raw, type),
    followed: true,
    userId: userId.slice(0, 100),
    handle: handle.toLowerCase().slice(0, 64),
    name: String(handle || raw.displayName || raw.userName || user.displayName || body.displayName || 'Followed user').slice(0, 48),
    avatar: fomoHttpsUrl(raw.profilePictureLink || raw.avatar || user.profilePictureLink || body.profilePictureLink),
    usd: raw.dataSource === 'trading-activity' ? (nativeUsdValid ? Math.abs(Number(nativeUsd)) : null)
      : fomoMetadataNumber(Math.abs(Number(raw.usdAmount ?? raw.usdValue ?? body.usdAmount ?? body.totalVolume ?? trade.usdValue))),
    comment,
    commentSegments: Array.isArray(raw.comment?.commentSegments ?? raw.comment?.shortCommentSegments) ? (raw.comment.commentSegments ?? raw.comment.shortCommentSegments).slice(0,100) : [],
    positionUsd: type === 'thesis' ? fomoMetadataNumber(trade.usdValue) : 0,
    pnlPercent: type === 'thesis' && Number.isFinite(Number(trade.closedAt ? trade.percentageRealizedPnl : trade.percentageUnrealizedPnl)) ? Number(trade.closedAt ? trade.percentageRealizedPnl : trade.percentageUnrealizedPnl) : null,
    addr: addr.slice(0, 80),
    chain: fomoNetworkSlug({ ...raw, networkId }),
    chainName: String(raw.networkName || raw.chainName || '').slice(0, 32),
    symbol: fomoMetadataText(raw.ticker, 32) || fomoMetadataText(raw.symbol, 32) || fomoMetadataText(body.ticker, 32) || fomoMetadataText(token.ticker, 32) || fomoMetadataText(token.symbol, 32),
    tokenName: fomoMetadataText(raw.tokenName || body.tokenName || token.name, 80),
    img: fomoHttpsUrl(raw.tokenImageUrl || raw.tokenImage || body.tokenImageUrl || token.imageUrl || token.image),
    mc: fomoMetadataNumber(raw.dataSource === 'trading-activity' ? raw.fdv ?? raw.marketCap : raw.fdv ?? raw.marketCap ?? body.fdv ?? body.marketCap),
    ts,
    providerEventId, swapId, commentId,
    tradeId: String(raw.tradeId || trade.id || '').slice(0, 128),
    transactionHash: String(raw.txHash || raw.transactionHash || body.txHash || '').trim().slice(0, 180),
    tx: String(raw.txHash || raw.transactionHash || body.txHash || '').trim().slice(0, 180),
  };
}

const FOMO_FOLLOWED_FEED_MIN_INTERVAL_MS = 5000;
const FOMO_FOLLOWING_IDS_CACHE_MS = 120000;
const FOMO_FEED_KEEP = 500;
// Bounded extension-only session persistence survives MV3 worker eviction.
const FOMO_FOLLOWED_FEED_PAGE_LIMIT = 100;
const FOMO_FOLLOWED_FEED_MAX_PAGES = 5;
function emptyFomoFollowedFeed() {
  return { events: [], updatedAt: 0, fetchedAt: 0, coverageGap: true, gapReason: 'restart-baseline' };
}
let fomoFollowedFeedCache = emptyFomoFollowedFeed();
let fomoFollowedFeedCheckpoint = null;
let fomoFollowingIdsCache = { ids: new Set(), fetchedAt: 0 };
let fomoFollowingIdsInflight = null;
let fomoFollowedFeedInflight = null;
let fomoAuthGeneration = 0;
let fomoApiRetryAt = 0;
let fomoApiFailures = 0;

function fomoFailure(reason, status, retryAt) {
  return Object.assign(new Error(reason), { reason, ...(status ? { status } : {}), ...(retryAt ? { retryAt } : {}) });
}

function fomoCheckResponse(res, body) {
  if ([401, 403, 430, 431].includes(res.status) || fomoBodyUnauthed(body)) {
    throw fomoFailure('not-connected', res.status);
  }
  if (!res.ok || fomoBodyFailed(body)) {
    throw fomoFailure('fetch-failed', res.status, fomoApiRetryAt);
  }
}

function fomoEventCheckpoint(raw) {
  // Only an actual event ID is a checkpoint; trade IDs can cover multiple swaps.
  const id = String(raw?.id || raw?.key || '').trim();
  const ts = Date.parse(raw?.createdAt || raw?.timestamp || '') || Number(raw?.ts) || 0;
  return id && ts ? { id, ts } : null;
}

function fomoAnnotateFollowing(items, ids) {
  return items.map((item) => ({
    ...item,
    followed: ids ? ids.has(String(item?.user?.id || item?.userId || item?.authorId || item?.body?.userId || item?.body?.authorId || '').trim()) : null,
  }));
}

function fomoAccountIdentity(record) {
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

async function fetchFomoFollowingIds(force = false) {
  if (!force && fomoFollowingIdsCache.fetchedAt && Date.now() - fomoFollowingIdsCache.fetchedAt < FOMO_FOLLOWING_IDS_CACHE_MS) {
    return fomoFollowingIdsCache.ids;
  }
  const generation = fomoAuthGeneration;
  if (fomoFollowingIdsInflight?.generation === generation) return fomoFollowingIdsInflight.promise;
  const promise = (async () => {
    try {
      const { res } = await fomoAuthedFetch('/v2/users/current/followingIds');
      const body = await res.json().catch(() => null);
      if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
      fomoCheckResponse(res, body);
      const values = body?.responseObject?.followingIds ?? body?.followingIds;
      if (!Array.isArray(values)) throw fomoFailure('invalid-response');
      const ids = new Set(values.map((value) => String(value || '').trim()).filter(Boolean));
      reconcileFomoRoster(ids);
      fomoFollowingIdsCache = { ids, fetchedAt: Date.now() };
      return ids;
    } finally {
      if (fomoFollowingIdsInflight?.promise === promise) fomoFollowingIdsInflight = null;
    }
  })();
  fomoFollowingIdsInflight = { generation, promise };
  return promise;
}

const FOMO_COLLECTOR_SESSION = 'fomoFollowingCollectorV1';
const FOMO_QUOTE_TOKENS = {
  1399811149: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  56: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  4663: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  143: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
};
function fomoMetadataText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && Array.from(text).length <= max && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '';
}
function fomoMetadataNumber(value) {
  if (!['number','string'].includes(typeof value) || String(value).trim() === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1e18 ? number : 0;
}
function emptyFomoCollector() { return { lanes: {}, positions: {}, watches: {}, profiles: {}, tokens: {}, profileRetry: {}, offset: 0, watchOffset: 0 }; }
let fomoCollector = emptyFomoCollector();
let fomoCollectorHydration = null;
let fomoCollectorSave = Promise.resolve();
let fomoRosterGeneration = 0;
async function fomoCollectorBinding() {
  const { fomoToken } = await chrome.storage.local.get('fomoToken');
  const identity = fomoAccountIdentity(fomoToken) || fomoToken?.token;
  if (!identity || typeof crypto === 'undefined' || !crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function hydrateFomoCollector() {
  if (!chrome.storage.session) return;
  if (fomoCollectorHydration) return fomoCollectorHydration;
  const generation = fomoAuthGeneration;
  const pending = (async () => {
    const binding = await fomoCollectorBinding();
    const saved = (await chrome.storage.session.get(FOMO_COLLECTOR_SESSION))[FOMO_COLLECTOR_SESSION];
    if (generation !== fomoAuthGeneration || !binding || saved?.binding !== binding || saved?.version !== 1) return;
    if (!Array.isArray(saved.cache?.events) || !saved.state?.lanes || !saved.state?.watches) return;
    fomoCollector = { ...emptyFomoCollector(), ...saved.state };
    for (const key of ['positions','profiles','tokens','profileRetry']) {
      if (!fomoCollector[key] || typeof fomoCollector[key] !== 'object' || Array.isArray(fomoCollector[key])) fomoCollector[key] = {};
    }
    // V1 snapshots predate metadata caches. Ignore corrupt/future retry clocks.
    fomoCollector.tokens = Object.fromEntries(Object.entries(fomoCollector.tokens).filter(([,row]) => row && typeof row === 'object').slice(-FOMO_FEED_KEEP)
      .map(([key,row]) => [key,{ symbol:fomoMetadataText(row.symbol,32), tokenName:fomoMetadataText(row.tokenName,80), img:fomoHttpsUrl(row.img),
        mc:fomoMetadataNumber(row.mc), mcUpdatedAt:Number(row.mcUpdatedAt) || 0, mcRetryAt:0,
        retryAt:Number.isFinite(row.retryAt) && row.retryAt <= Date.now()+300000 ? row.retryAt : 0 }]));
    for (const [id,at] of Object.entries(fomoCollector.profileRetry)) if (!Number.isFinite(at) || at > Date.now()+60000) delete fomoCollector.profileRetry[id];
    fomoFollowedFeedCache = { ...saved.cache, events: saved.cache.events.slice(0, FOMO_FEED_KEEP), fetchedAt: 0 };
    // Always refresh the roster on wake before making restored events visible.
  })();
  fomoCollectorHydration = pending;
  try { await pending; } catch { if (fomoCollectorHydration === pending) fomoCollectorHydration = null; }
}
function persistFomoCollector(clear = false) {
  if (!chrome.storage.session) return Promise.resolve();
  const generation = fomoAuthGeneration;
  const snapshot = clear ? null : JSON.parse(JSON.stringify({ version: 1, state: fomoCollector, cache: fomoFollowedFeedCache }));
  fomoCollectorSave = fomoCollectorSave.catch(() => {}).then(async () => {
    if (clear) { await chrome.storage.session.remove(FOMO_COLLECTOR_SESSION); return; }
    const binding = await fomoCollectorBinding();
    if (generation !== fomoAuthGeneration || !binding) return;
    await chrome.storage.session.set({ [FOMO_COLLECTOR_SESSION]: { ...snapshot, binding } });
  }).catch(() => {});
  return fomoCollectorSave;
}
function reconcileFomoRoster(ids) {
  const before = fomoFollowingIdsCache.ids;
  if (ids.size === before.size && [...ids].every(id => before.has(id))) return;
  fomoRosterGeneration += 1;
  fomoFollowedFeedCache = { ...fomoFollowedFeedCache, fetchedAt: 0, events: fomoFollowedFeedCache.events.filter(e => ids.has(e.userId)) };
  for (const id of Object.keys(fomoCollector.positions)) if (!ids.has(id)) delete fomoCollector.positions[id];
  for (const id of Object.keys(fomoCollector.profiles)) if (!ids.has(id)) delete fomoCollector.profiles[id];
  for (const id of Object.keys(fomoCollector.profileRetry)) if (!ids.has(id)) delete fomoCollector.profileRetry[id];
  for (const key of Object.keys(fomoCollector.lanes)) if (key.startsWith('swap:') && !ids.has(key.slice(5))) delete fomoCollector.lanes[key];
  for (const [key, watch] of Object.entries(fomoCollector.watches)) {
    watch.users = watch.users.filter(id => ids.has(id));
    if (!watch.users.length) delete fomoCollector.watches[key];
  }
}
async function fomoCollectorPool(jobs) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (next < jobs.length) { const job = jobs[next++]; await job(); }
  }));
}
function fomoSameToken(a, b, network) { return network === 1399811149 ? a === b : String(a).toLowerCase() === String(b).toLowerCase(); }
function fomoSwapEvent(raw, userId, ids, profile) {
  if (!raw?.id || (raw.userId && raw.userId !== userId)) return null;
  const quote = FOMO_QUOTE_TOKENS[raw.outNetworkId];
  if (!quote) return null;
  const sell = fomoSameToken(raw.outTokenAddress, quote, raw.outNetworkId);
  const networkId = sell ? raw.inNetworkId : raw.outNetworkId;
  const tokenAddress = sell ? raw.inTokenAddress : raw.outTokenAddress;
  if (!normalizeFomoTokenRef({ networkId, tokenAddress })) return null;
  const usdAmount = Number(sell ? raw.humanUsdAmountOut : raw.humanUsdAmountIn);
  if (!Number.isFinite(usdAmount) || usdAmount < 0) return null;
  return slimFomoFollowedEvent({ ...raw, ...profile, id: raw.id, swapId: raw.id, userId,
    type: sell ? 'swap_sell' : 'swap_buy', networkId, tokenAddress, usdAmount,
    dataSource: 'user-swaps', usdSource: sell ? 'humanUsdAmountOut' : 'humanUsdAmountIn',
    tradeId: sell ? raw.inTradeId : raw.outTradeId,
  }, ids);
}
// Never deduplicate by position/trade ID alone: one position has many swaps.
function fomoMergeFollowedEvents(rows) {
  const byKey = new Map();
  for (const e of rows) {
    const old = byKey.get(e.key);
    if (old?.dataSource !== 'trading-activity' || e.dataSource === 'trading-activity') byKey.set(e.key,e);
  }
  const nativeById = new Map();
  for (const e of byKey.values()) if (e.dataSource === 'trading-activity') {
    const identity = `${e.userId}:${e.providerEventId || e.key}`;
    const old = nativeById.get(identity);
    nativeById.set(identity, old ? { ...e, key:old.key } : e);
  }
  const native = [...nativeById.values()];
  const fallback = [...byKey.values()].filter(e => e.dataSource !== 'trading-activity');
  const aliases = (a,b) => {
    if (a.userId !== b.userId || a.type !== b.type || a.chain !== b.chain || a.addr !== b.addr) return false;
    if (a.key === b.key || (a.swapId && a.swapId === b.swapId) || (a.commentId && a.commentId === b.commentId)) return true;
    if (a.swapId && b.swapId && a.swapId !== b.swapId) return false;
    if (a.type === 'thesis') return false;
    return (a.transactionHash && a.transactionHash === b.transactionHash)
      || (a.tradeId && a.tradeId === b.tradeId && a.ts === b.ts);
  };
  const removed = new Set();
  const resolved = native.map(n => {
    const matches = fallback.filter(e => aliases(n,e));
    // Many swaps can share a transaction/timestamp. Ambiguity must not erase trades.
    if (matches.length !== 1 || native.filter(other => aliases(other,matches[0])).length !== 1) return n;
    const previous = matches[0]; removed.add(previous.key);
    return { ...previous, ...n, key:previous.key };
  });
  return [...fallback.filter(e => !removed.has(e.key)), ...resolved];
}
// Passive direct Following is memory-only: a restarted worker must observe native
// account + roster again, never hydrate a credential-bound legacy collector cache.
const FOMO_PASSIVE_TTL = 60000;
const fomoPassiveDocuments = new Map();
let fomoPassive = { owner: null, accountId: '', ids: null, events: [], pending: [], at: 0, connected: false, revision: 0 };
let fomoPassiveQueue = Promise.resolve();
let fomoPassiveQueued = 0;
function fomoPassiveUrl(value) {
  try { const u = new URL(value); return u.origin === 'https://fomo.family' && !u.username && !u.password; } catch { return false; }
}
function clearFomoPassive(disconnected = false) {
  for (const record of fomoPassiveDocuments.values()) record.retired = true;
  fomoPassive = { owner: null, accountId: '', ids: null, events: [], pending: [], at: 0, connected: false,
    disconnected, revision: fomoPassive.revision + 1 };
}
function passiveFomoSnapshot() {
  const p = fomoPassive;
  const live = !!p.owner && p.connected && Date.now() - p.at <= FOMO_PASSIVE_TTL;
  const fresh = !!p.owner && Date.now() - p.at <= FOMO_PASSIVE_TTL;
  const passiveStatus = !p.owner ? (p.disconnected ? 'disconnected' : 'waiting-for-fomo-tab')
    : !fresh ? 'disconnected' : !p.accountId ? 'waiting-for-account'
    : !p.ids ? 'waiting-for-following' : !live ? (p.everConnected ? 'disconnected' : 'waiting-for-activity')
    : !p.events.length ? 'waiting-for-activity' : 'connected';
  return { ok: live && !!p.ids, mode: 'passive', passiveStatus, reason: passiveStatus === 'connected' ? '' : passiveStatus,
    events: p.ids ? p.events.slice() : [], updatedAt: p.updatedAt || 0, fetchedAt: p.at,
    connected: live, stale: !live, followingKnown: !!p.ids, followingCount: p.ids?.size || 0,
    coverageGap: true, gapReason: live ? 'native-observed-only' : passiveStatus,
    coverage: { source: 'native-passive', complete: false }, source: 'native-passive' };
}
async function fetchFomoFollowedFeed() {
  const owner = fomoPassive;
  if (owner.owner && chrome.tabs?.get) {
    try { const tab = await chrome.tabs.get(owner.tabId); if (owner === fomoPassive && !fomoPassiveUrl(tab.url)) clearFomoPassive(true); }
    catch { if (owner === fomoPassive) clearFomoPassive(true); }
  }
  return passiveFomoSnapshot();
}
async function pushPassiveFomo() {
  const revision = fomoPassive.revision;
  const generation = fomoAuthGeneration;
  try {
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    const token = fomoToken?.token || '';
    const epoch = token ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('') : '';
    const tabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://*.gmgn.ai/*'] });
    if (revision !== fomoPassive.revision || generation !== fomoAuthGeneration) return;
    const data = passiveFomoSnapshot();
    for (const tab of tabs) void chrome.tabs.sendMessage(tab.id, { type: 'fomo-followed-feed-update', epoch, data }).catch(() => {});
  } catch {}
}
// Whitelist before normalization: never retain arbitrary body properties, auth,
// nested comment objects or prototype keys received from the page boundary.
function sanitizePassiveFomoItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = {};
  const fields = ['id','key','swapId','commentId','type','userId','authorId','createdAt','timestamp','ts','networkId','chainId','chain','chainSlug','tokenAddress','userHandle','handle','displayName','userName','profilePictureLink','avatar','usdAmount','usdValue','fdv','marketCap','ticker','symbol','tokenName','tokenImageUrl','tokenImage','tradeId','txHash','transactionHash','position','positionAction','action','text','thesis','networkName','chainName'];
  for (const key of fields) {
    const value = raw[key];
    if (typeof value === 'string') result[key] = value.slice(0, ['text','thesis'].includes(key) ? 1500 : 400);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
  }
  for (const [key, allowed] of Object.entries({ body: fields.concat('comment'), user: ['id','userHandle','handle','displayName','profilePictureLink'], token: ['address','networkId','ticker','symbol','name','imageUrl','image'], authorTrade: ['id','usdValue','closedAt','percentageRealizedPnl','percentageUnrealizedPnl'], tradeComment: ['id'] })) {
    if (!raw[key] || typeof raw[key] !== 'object') continue;
    result[key] = {};
    for (const field of allowed) {
      const v = raw[key][field];
      if (typeof v === 'string') result[key][field] = v.slice(0, field === 'comment' ? 1500 : 400);
      else if (typeof v === 'number' && Number.isFinite(v)) result[key][field] = v;
    }
  }
  if (typeof raw.comment === 'string') result.comment = raw.comment.slice(0, 1500);
  else if (raw.comment && typeof raw.comment === 'object') result.comment = { id: String(raw.comment.id || '').slice(0,128), comment: String(raw.comment.comment || '').slice(0,1500) };
  result.dataSource = 'trading-activity';
  return result;
}
function mergePassiveFomo(items) {
  const p = fomoPassive;
  if (!p.ids) { p.pending = [...p.pending, ...items].slice(-FOMO_FEED_KEEP); return; }
  const rows = items.map(row => slimFomoFollowedEvent(row, p.ids)).filter(Boolean);
  const merged = new Map(p.events.filter(e => p.ids.has(e.userId)).map(e => [e.key, e]));
  for (const row of rows) merged.set(row.key, { ...merged.get(row.key), ...row });
  p.events = fomoMergeFollowedEvents([...merged.values()]).sort((a,b) => b.ts-a.ts || a.key.localeCompare(b.key)).slice(0,FOMO_FEED_KEEP);
  if (rows.length) p.updatedAt = Date.now();
}
async function ingestPassiveFomo(data, sender) {
  const revision = fomoPassive.revision;
  if (!Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 || !fomoPassiveUrl(sender.url) || !fomoPassiveUrl(sender.tab.url) || sender.url !== sender.tab.url) return { ok:false, reason:'invalid-sender' };
  if (!data || data.source !== 'gdh-fomo-passive-v1' || !['account','following','activity','connection','logout'].includes(data.kind)
    || !Number.isSafeInteger(data.epoch) || data.epoch < 0 || !Number.isSafeInteger(data.seq) || data.seq < 1
    || typeof data.bridgeId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(data.bridgeId)) return {ok:false,reason:'invalid-envelope'};
  try {
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!fomoPassiveUrl(tab.url) || tab.url !== sender.tab.url) return {ok:false,reason:'stale-tab'};
    if (chrome.webNavigation?.getFrame && sender.documentId) {
      const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
      if (!frame || frame.documentId !== sender.documentId || frame.url !== sender.url) return {ok:false,reason:'stale-document'};
    }
  } catch { return {ok:false,reason:'closed-tab'}; }
  if (revision !== fomoPassive.revision) return {ok:false,reason:'stale-lifecycle'};
  if (data.kind === 'following') {
      if (!Array.isArray(data.followingIds) || data.followingIds.length > 10000 || data.followingIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(id))) return {ok:false,reason:'invalid-roster'};
  }
  if (data.kind === 'activity') {
      if (!Array.isArray(data.items) || data.items.length > 100 || JSON.stringify(data.items).length > 250000) return {ok:false,reason:'invalid-items'};
  }
  const key = `${sender.tab.id}:${sender.documentId || data.bridgeId}`;
  let record = fomoPassiveDocuments.get(key);
  if (record && (record.bridgeId !== data.bridgeId || data.seq <= record.seq || data.epoch < record.epoch || (record.retired && data.epoch <= record.epoch))) return {ok:false,reason:'stale-epoch'};
  const accountId = typeof data.accountId === 'string' && /^[a-zA-Z0-9:_-]{1,100}$/.test(data.accountId) ? data.accountId : '';
  if (!record) {
    if (fomoPassiveDocuments.size >= 32) return {ok:false,reason:'document-limit'};
    record = { bridgeId: data.bridgeId, seq: 0, epoch: -1, retired:false };
    fomoPassiveDocuments.set(key, record);
  }
  if (data.kind === 'account') {
    if (!accountId) return {ok:false,reason:'invalid-account'};
    if (fomoPassive.owner && fomoPassive.owner !== key && Date.now() - fomoPassive.at <= FOMO_PASSIVE_TTL) {
      record.seq = data.seq; record.epoch = data.epoch;
      return {ok:false,reason:'other-active-tab'};
    }
    if (fomoPassive.owner !== key || fomoPassive.accountId !== accountId || record.epoch !== data.epoch) {
      if (fomoPassive.owner === key && record.epoch === data.epoch && fomoPassive.accountId !== accountId) return {ok:false,reason:'account-epoch-required'};
      for (const [other, r] of fomoPassiveDocuments) if (other !== key) r.retired = true;
      fomoPassive = { owner:key, tabId:sender.tab.id, accountId, ids:null, events:[], pending:[], at:Date.now(), connected:false, revision:fomoPassive.revision+1 };
    }
    record.retired = false;
  } else if (fomoPassive.owner !== key || (data.kind === 'logout' ? data.epoch < record.epoch : record.epoch !== data.epoch) || (data.kind !== 'logout' && accountId !== fomoPassive.accountId)) {
    return {ok:false,reason:'account-not-bound'};
  }
  record.seq = data.seq; record.epoch = data.epoch;
  const p = fomoPassive;
  if (data.kind === 'logout') { clearFomoPassive(true); }
  else {
    p.at = Date.now(); p.revision++;
    if (data.kind === 'connection') {
      p.connected = data.connected === true;
      if (p.connected) p.everConnected = true;
    }
    if (data.kind === 'following') {

      p.ids = new Set(data.followingIds);
      mergePassiveFomo(p.pending); p.pending = [];
    }
    if (data.kind === 'activity') {

      mergePassiveFomo(data.items.map(sanitizePassiveFomoItem).filter(Boolean));
    }
  }
  globalThis.gdhDebug?.record('passive', { event:data.kind, status:passiveFomoSnapshot().passiveStatus, received:data.items?.length || 0, retained:fomoPassive.events.length });
  void pushPassiveFomo();
  return {ok:true, passiveStatus:passiveFomoSnapshot().passiveStatus};
}
chrome.tabs?.onRemoved?.addListener(tabId => {
  if (fomoPassive.tabId === tabId) { clearFomoPassive(true); void pushPassiveFomo(); }
  for (const key of fomoPassiveDocuments.keys()) if (key.startsWith(`${tabId}:`)) fomoPassiveDocuments.delete(key);
});
chrome.tabs?.onUpdated?.addListener((tabId, change) => {
  if (fomoPassive.tabId === tabId && (change.status === 'loading' || change.url)) { clearFomoPassive(true); void pushPassiveFomo(); }
});

// Reference-only legacy collector. Never called by runtime, timers or passive ingestion.
async function legacyFetchFomoFollowedFeed() {
  await hydrateFomoCollector();
  if (fomoFollowedFeedInflight?.generation === fomoAuthGeneration) return fomoFollowedFeedCache.events.length ? { ok: !fomoFollowedFeedCache.reason, ...fomoFollowedFeedCache, refreshing: true } : fomoFollowedFeedInflight.promise;
  if (fomoFollowedFeedCache.fetchedAt && Date.now() - fomoFollowedFeedCache.fetchedAt < FOMO_FOLLOWED_FEED_MIN_INTERVAL_MS) {
    return { ok: !fomoFollowedFeedCache.reason, ...fomoFollowedFeedCache };
  }
  const generation = fomoAuthGeneration;
  const promise = (async () => {
    let ids;
    try { ids = await fetchFomoFollowingIds(); }
    catch (error) {
      if (generation !== fomoAuthGeneration) return { ok: false, reason: 'not-connected', ...emptyFomoFollowedFeed() };
      if (error.reason === 'not-connected') resetFomoAccountCaches();
      return { ...fomoFollowedFeedCache, ok: false, stale: true, followingKnown: false, coverageGap: true, gapReason: error.reason || 'fetch-failed', reason: error.reason || 'fetch-failed' };
    }
    const rosterGeneration = fomoRosterGeneration;
    const valid = () => generation === fomoAuthGeneration && rosterGeneration === fomoRosterGeneration;
    // Content checks the credential digest, not the account cache binding. This
    // prevents a queued push from a previous login from repopulating the page.
    let pushEpoch = '';
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const stored = (await chrome.storage.local.get('fomoToken')).fomoToken;
      const token = String(stored?.token || '').trim();
      if (token) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
        pushEpoch = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      }
    }
    if (!valid()) return { ok:false, reason:'not-connected', ...emptyFomoFollowedFeed() };
    const state = JSON.parse(JSON.stringify(fomoCollector));
    const collected = new Map();
    const failures = [];
    const coverage = { attempted: 0, succeeded: 0, rejected: 0, unsupported: 0, usersAttempted: 0, usersTotal: ids.size, tokenRequests: 0 };
    const request = async (path, options = {}) => {
      if (!valid()) throw fomoFailure('not-connected');
      coverage.attempted++;
      const { res } = await fomoAuthedFetch(path, { ...options, collector: true });
      const body = await res.json().catch(() => null);
      if (!valid()) throw fomoFailure('not-connected');
      fomoCheckResponse(res, body);
      coverage.succeeded++;
      return body?.responseObject ?? body;
    };
    const watch = (ref, userId) => {
      const normalized = normalizeFomoTokenRef(ref);
      if (!normalized) return;
      const key = `${normalized.networkId}:${normalized.address}`;
      const old = state.watches[key];
      state.watches[key] = { ...old, ...normalized, until: Date.now() + 86400000, users: [...new Set([...(old?.users || []), userId])] };
    };
    let publishQueued = false;
    const publish = () => {
      if (publishQueued) return;
      publishQueued = true;
      queueMicrotask(() => {
        publishQueued = false;
        if (!valid()) return;
        const merged = new Map(fomoFollowedFeedCache.events.filter(e => ids.has(e.userId)).map(e => [e.key, e]));
        for (const [key, event] of collected) merged.set(key, event);
        fomoFollowedFeedCache = { ...fomoFollowedFeedCache, events: fomoMergeFollowedEvents([...merged.values()]).sort((a,b) => b.ts-a.ts || a.key.localeCompare(b.key)).slice(0,FOMO_FEED_KEEP),
          updatedAt: Date.now(), followingKnown: true, coverageGap: true, gapReason: 'refreshing', refreshing: true };
        void persistFomoCollector();
        if (chrome.tabs?.query) void chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://*.gmgn.ai/*'] }).then(tabs => {
          if (!valid()) return;
          for (const tab of tabs) void chrome.tabs.sendMessage(tab.id, { type: 'fomo-followed-feed-update', epoch: pushEpoch, data: { ok: true, ...fomoFollowedFeedCache } }).catch(() => {});
        }).catch(() => {});
      });
    };
    const ingest = event => {
      if (!event || !valid()) return;
      const previous = collected.get(event.key) || fomoFollowedFeedCache.events.find(e => e.key === event.key);
      if (previous?.userId === event.userId && previous.chain === event.chain && previous.addr === event.addr) {
        for (const field of ['handle','avatar','symbol','tokenName','img']) if (!event[field] && previous[field]) event[field] = previous[field];
        if (event.name === 'Followed user' && previous.name) event.name = previous.name;
        if (previous.dataSource === 'trading-activity' && event.dataSource !== 'trading-activity') return;
      }
      publish();
      collected.set(event.key, event);
      if (event.handle) state.profiles[event.userId] = { userHandle: event.handle, profilePictureLink: event.avatar || state.profiles[event.userId]?.profilePictureLink };
      if (event.type === 'buy' || event.type === 'thesis') watch({ networkId: Number(Object.keys(FOMO_NETWORK_SLUG).find(k => FOMO_NETWORK_SLUG[k] === event.chain)), address: event.addr }, event.userId);
    };
    const safely = fn => async () => { try { await fn(); } catch (error) { failures.push(error); if (error.reason === 'not-connected' && valid()) resetFomoAccountCaches(); } };
    // Every pass reads a fresh head. Historical gap repair has a separate persisted cursor;
    // a provider-deleted predecessor can never block new events or advance verified coverage.
    const scan = async (key, fetchPage, normalize) => {
      const endpoint = key === 'alerts' ? 'trading-activity' : key === 'social' ? 'social-feed' : 'user-swaps';
      let pages = 0, received = 0, hasMore = false, cursorAdvanced = false, reason = 'page-cap';
      const pageAt = async cursor => {
        const box = await fetchPage(cursor);
        pages++; received += Array.isArray(box.rows) ? box.rows.length : 0; hasMore = !!box.more;
        const next = String(box.rows?.at(-1)?.id || '');
        cursorAdvanced = !!next && next !== cursor;
        return box;
      };
      try {
      const lane = state.lanes[key] || { head: '', gap: false };
      let cursor = '', head = '', overlap = false, exhausted = false;
      const seen = new Set();
      state.lanes[key] = lane;
      for (let page = 0; page < (key === 'alerts' ? 4 : 2); page++) {
        const box = await pageAt(cursor);
        if (!Array.isArray(box.rows)) throw fomoFailure('invalid-response');
        for (const row of box.rows) {
          const id = String(row?.id || '');
          if (!id) { coverage.rejected++; continue; }
          if (!head) head = id;
          if (id === lane.head) overlap = true;
          const event = normalize(row);
          if (event) ingest(event); else if (row?.type !== 'manual' && key.startsWith('swap:')) coverage.rejected++;
        }
        const next = String(box.rows.at(-1)?.id || '');
        exhausted = !box.more;
        if (exhausted || overlap || (!lane.head && key !== 'alerts')) { reason = exhausted ? 'exhausted' : overlap ? 'overlap' : 'baseline'; cursor = next; break; }
        if (!next || next === cursor || seen.has(next)) { reason = 'pagination-stalled'; lane.gap = true; break; }
        seen.add(next); cursor = next;
      }
      if (lane.head && !overlap) {
        if (!lane.target) { lane.target = lane.head; lane.cursor = cursor; }
        lane.gap = true;
      }
      if (lane.target) {
        const repair = await pageAt(lane.cursor || '');
        if (!Array.isArray(repair.rows)) throw fomoFailure('invalid-response');
        for (const row of repair.rows) ingest(normalize(row));
        if (repair.rows.some(row => String(row.id) === lane.target)) { lane.target = ''; lane.cursor = ''; lane.gap = false; }
        else {
          const next = String(repair.rows.at(-1)?.id || '');
          lane.cursor = repair.more && next !== lane.cursor ? next : '';
        }
      } else if (overlap || (!lane.head && exhausted)) lane.gap = false;
      else if (!lane.head) lane.gap = true;
      if (key === 'alerts') {
        if (!lane.head && !exhausted) { lane.baselinePending = true; lane.baselineCursor = cursor; }
        if (lane.baselinePending && lane.baselineCursor && pages < 5) {
          const repair = await pageAt(lane.baselineCursor);
          if (!Array.isArray(repair.rows)) throw fomoFailure('invalid-response');
          for (const row of repair.rows) ingest(normalize(row));
          const next = String(repair.rows.at(-1)?.id || '');
          if (!repair.more) { lane.baselinePending = false; lane.baselineCursor = ''; reason = 'complete'; }
          else if (!next || next === lane.baselineCursor) { reason = 'cursor-stalled'; cursorAdvanced = false; }
          else lane.baselineCursor = next;
        }
        if (lane.baselinePending) lane.gap = true;
        else if (!lane.target && exhausted) lane.gap = false;
      }
      if (head) lane.head = head;
      state.lanes[key] = lane;
      } catch (error) { reason = error.reason || 'fetch-failed'; throw error; }
      finally { globalThis.gdhDebug?.record('pagination', { endpoint, pages, received, hasMore, cursorAdvanced, reason }); }
    };
    // Native Alerts is the primary lane; social and per-user history are recovery.
    await safely(() => scan('alerts', async cursor => {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('lastId', cursor);
      const box = await request(`/feed/tradingActivity?${params}`);
      if (!Array.isArray(box.items) || typeof box.hasNextPage !== 'boolean') throw fomoFailure('invalid-response');
      return { rows: box.items, more: box.hasNextPage };
    }, row => {
      if (!['swap_buy','swap_sell','thesis'].includes(row?.type)) { coverage.unsupported++; return null; }
      if (!normalizeFomoTokenRef(row)) { coverage.rejected++; return null; }
      return slimFomoFollowedEvent({ ...row, dataSource: 'trading-activity' }, ids);
    }))();
    const nativeHealthy = !failures.length && !coverage.rejected && !coverage.unsupported && state.lanes.alerts && !state.lanes.alerts.gap;
    const users = [...ids].sort();
    const chosen = Array.from({ length: nativeHealthy ? 0 : Math.min(12, users.length) }, (_, i) => users[(state.offset + i) % users.length]);
    state.offset = users.length ? (state.offset + chosen.length) % users.length : 0;
    coverage.usersAttempted = chosen.length;
    const jobs = nativeHealthy ? [] : [safely(() => scan('social', async cursor => {
      const params = new URLSearchParams({ limit: '50' });
      params.append('feedTypes', 'thesis_created'); params.append('feedTypes', 'user_trade_profit_milestone');
      if (cursor) params.set('lastFeedId', cursor);
      const box = await request(`/feed?${params}`);
      return { rows: box.feed, more: box.hasNextPage ?? (box.feed?.length >= 50) };
    }, row => slimFomoFollowedEvent(row, ids)))];
    const recoveryJobs = [];
    for (const userId of chosen) {
      jobs.push(safely(() => scan(`swap:${userId}`, async cursor => {
        const box = await request(`/v2/users/${encodeURIComponent(userId)}/swaps${cursor ? `?lastSwapIdV2=${encodeURIComponent(cursor)}` : ''}`);
        if (typeof box.hasNextPage !== 'boolean') throw fomoFailure('invalid-response');
        if ((!box.user?.id || box.user.id === userId) && box.user?.userHandle) state.profiles[userId] = { userHandle: box.user.userHandle, profilePictureLink: box.user.profilePictureLink };
        return { rows: box.swaps, more: box.hasNextPage };
      }, row => fomoSwapEvent(row, userId, ids, state.profiles[userId]))));
      recoveryJobs.push(safely(async () => {
        const box = await request(`/v2/users/${encodeURIComponent(userId)}/balances`);
        if (!Array.isArray(box.balances) || box.balances.length > 2000) throw fomoFailure('invalid-response');
        const previous = state.positions[userId];
        const positions = {};
        for (const row of box.balances) {
          const trade = row?.activeTrade, token = row?.userToken;
          if (!trade || trade.closedAt !== null || !(token?.humanAmountRemaining > 0)) continue;
          if ((trade.userId && trade.userId !== userId) || (token.userId && token.userId !== userId)
            || trade.networkId !== token.networkId || !fomoSameToken(trade.tokenAddress, token.tokenAddress, trade.networkId)
            || !normalizeFomoTokenRef({ networkId: trade.networkId, tokenAddress: trade.tokenAddress }) || !trade.id) throw fomoFailure('invalid-response');
          const old = previous?.[trade.id];
          // The bot's balances schema carries metadata in tokenFilterResult,
          // not userToken. Require its own chain/address to match the position.
          const metadata = row.tokenFilterResult?.token;
          if (metadata && metadata.networkId === trade.networkId && fomoSameToken(metadata.address,trade.tokenAddress,trade.networkId)) {
            const ref = normalizeFomoTokenRef(metadata), symbol = fomoMetadataText(metadata.symbol,32);
            if (ref && symbol) {
              const key = `${ref.networkId}:${ref.address}`;
              state.tokens[key] = { ...state.tokens[key], symbol,
                mc:fomoMetadataNumber(row.tokenFilterResult.marketCap), mcUpdatedAt:Date.now(),
                mcRetryAt:Date.now()+(fomoMetadataNumber(row.tokenFilterResult.marketCap) ? 5000 : 30000),
                tokenName:fomoMetadataText(metadata.name,80) || state.tokens[key]?.tokenName || '',
                img:fomoHttpsUrl(metadata.info?.imageSmallUrl) || fomoHttpsUrl(metadata.info?.imageThumbUrl) || fomoHttpsUrl(metadata.info?.imageLargeUrl) || state.tokens[key]?.img || '', retryAt:Date.now()+300000 };
            }
          }
          positions[trade.id] = { networkId: trade.networkId, tokenAddress: trade.tokenAddress, commentId: trade.commentId || '', pending: old?.pending || '', observedAt: old?.observedAt || Date.now() };
          if (previous && trade.commentId && old?.commentId !== trade.commentId) {
            positions[trade.id].pending = trade.commentId; positions[trade.id].observedAt = Date.now();
          }
          // Initial census silently baselines old comments, but watches open tokens so
          // new theses are discoverable even with no recent buy (including later edits).
          watch({ networkId: trade.networkId, tokenAddress: trade.tokenAddress }, userId);
        }
        state.positions[userId] = positions;
      }));
    }
    await fomoCollectorPool(jobs);
    // Recover positions/theses before enrichment so late rows are included too.
    await fomoCollectorPool(recoveryJobs);
    const watches = Object.entries(state.watches).filter(([, w]) => w.until > Date.now() && w.users.some(id => ids.has(id))).slice(-200);
    state.watches = Object.fromEntries(watches);
    const selected = Array.from({ length: nativeHealthy ? 0 : Math.min(6, watches.length) }, (_, i) => watches[(state.watchOffset + i) % watches.length]);
    state.watchOffset = watches.length ? (state.watchOffset + selected.length) % watches.length : 0;
    await fomoCollectorPool(selected.map(([key, ref]) => safely(async () => {
      let cursor = '';
      let freshCursor = '';
      let pages = 0, received = 0, hasMore = false, cursorAdvanced = false, reason = 'page-limit';
      try {
      const afterTime = Date.now() - 630000;
      for (let page = 0; page < 2; page++) {
        const params = new URLSearchParams({ networkId: String(ref.networkId), tokenAddress: ref.address, limit: '80', afterTime: String(afterTime) });
        if (cursor) params.set('lastId', cursor);
        coverage.tokenRequests++;
        const box = await request(`/feed/token/thesis?${params}`);
        if (!Array.isArray(box.items) || typeof box.hasNextPage !== 'boolean') throw fomoFailure('invalid-response');
        pages++; received += box.items.length; hasMore = box.hasNextPage;
        cursorAdvanced = !!box.items.at(-1)?.id && String(box.items.at(-1).id) !== cursor;
        for (const row of box.items) {
          if (row.networkId !== ref.networkId || !fomoSameToken(row.tokenAddress, ref.address, ref.networkId)) { coverage.rejected++; continue; }
          const event = slimFomoFollowedEvent(row, ids);
          if (event?.type === 'thesis' && event.ts >= Date.now() - 600000) {
            const position = state.positions[event.userId]?.[event.tradeId];
            // A tracker is recent history, not a bot's no-replay notification baseline.
            // Every provider-timestamped recent thesis remains eligible on first load.
            ingest(event);
            if (position?.pending === event.commentId) position.pending = '';
          }
        }
        if (!box.hasNextPage) {
          reason = 'complete';
          state.watches[key].gap = page > 0 && !!ref.cursor && ref.cursor !== freshCursor;
          state.watches[key].cursor = '';
          // Retire an unseen expected comment only after a successful exhausted
          // fresh-window scan and the overlap grace, never on failure/page cap.
          if (!state.watches[key].gap) for (const userId of ref.users) for (const position of Object.values(state.positions[userId] || {})) {
            if (position.networkId === ref.networkId && fomoSameToken(position.tokenAddress, ref.address, ref.networkId) && position.pending && position.observedAt < Date.now() - 630000) position.pending = '';
          }
          break;
        }
        state.watches[key].gap = true;
        const next = String(box.items.at(-1)?.id || '');
        if (!next || next === cursor) throw fomoFailure('pagination-stalled');
        if (page === 0) freshCursor = next;
        cursor = page === 0 && ref.cursor ? ref.cursor : next;
        state.watches[key].cursor = next;
      }
      } catch (error) { reason = error.reason || 'error'; throw error; }
      finally { globalThis.gdhDebug?.record('pagination', { endpoint:'token-thesis', pages, received, hasMore, cursorAdvanced, reason }); }
    })));
    // Optional, bounded metadata. Swaps/social/late thesis ingestion is already published.
    // Include retained rows: a transient miss must recover even if its swap leaves page one.
    const fetchedEventCount = collected.size;
    const metadataRows = new Map(fomoFollowedFeedCache.events.filter(e => ids.has(e.userId)).map(e => [e.key, { ...e }]));
    for (const [key, event] of collected) metadataRows.set(key, event);
    const tokenRef = event => normalizeFomoTokenRef({ address: event.addr,
      networkId: Number(Object.keys(FOMO_NETWORK_SLUG).find(k => FOMO_NETWORK_SLUG[k] === event.chain)) });
    const tokenKey = ref => `${ref.networkId}:${ref.address}`;
    const refs = [...new Map([...metadataRows.values()].map(tokenRef).filter(Boolean).map(ref => [tokenKey(ref), ref])).values()]
      .filter(ref => !(state.tokens[tokenKey(ref)]?.retryAt > Date.now() && state.tokens[tokenKey(ref)]?.mcRetryAt > Date.now()))
      .sort((a,b) => (state.tokens[tokenKey(a)]?.retryAt || 0) - (state.tokens[tokenKey(b)]?.retryAt || 0)).slice(0,30);
    const optional = async (fn, timeout = 750) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try { await fn(controller.signal); }
      catch (error) { if (error.reason === 'not-connected') { failures.push(error); if (valid()) resetFomoAccountCaches(); } }
      finally { clearTimeout(timer); }
    };
    await fomoCollectorPool([
      ...(refs.length ? [() => optional(async signal => {
        // Mark misses as well as successes to bound retries; older misses get priority.
        for (const ref of refs) state.tokens[tokenKey(ref)] = { ...state.tokens[tokenKey(ref)], retryAt: Date.now() + 30000, mcRetryAt:Date.now()+30000 };
        const rows = await request('/proxy/filterTokens', { method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify(refs.map(ref => `${ref.address}:${ref.networkId}`)), signal });
        if (!Array.isArray(rows) || rows.length > 30) return;
        const requested = new Set(refs.map(tokenKey)), seen = new Set(), accepted = [];
        for (const row of rows) {
          const ref = normalizeFomoTokenRef(row?.token);
          if (!ref || !requested.has(tokenKey(ref)) || seen.has(tokenKey(ref))) return;
          seen.add(tokenKey(ref));
          const token = row.token;
          accepted.push([tokenKey(ref), { mc:fomoMetadataNumber(row.marketCap), symbol:fomoMetadataText(token.symbol,32), tokenName:fomoMetadataText(token.name,80),
            img:fomoHttpsUrl(token.info?.imageSmallUrl) || fomoHttpsUrl(token.info?.imageThumbUrl) || fomoHttpsUrl(token.info?.imageLargeUrl) }]);
        }
        for (const [key, data] of accepted) {
          const old = state.tokens[key] || {};
          state.tokens[key] = { ...old, ...Object.fromEntries(Object.entries(data).filter(([,value]) => value)),
            mc:data.mc, mcUpdatedAt:Date.now(), mcRetryAt:Date.now() + (data.mc ? 5000 : 30000),
            retryAt:Date.now() + (data.symbol ? 300000 : 30000) };
        }
      }), () => optional(async signal => {
        const boxes = await request('/hodlers/friends', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tokens:refs}), signal });
        if (!Array.isArray(boxes)) return;
        for (const box of boxes.slice(0,30)) for (const raw of (Array.isArray(box.topHolders) ? box.topHolders.slice(0,100) : [])) {
          const user = slimFomoFollowedHolder(raw);
          if (ids.has(user.userId) && user.handle) state.profiles[user.userId] = { userHandle:user.handle, profilePictureLink:user.avatar };
        }
      })] : []),
    ]);
    // Current holders cannot resolve exited users. Recover the native following
    // roster by the actual FOMO user ID (JWT sub may instead be a Privy DID).
    if ([...metadataRows.values()].some(e => !e.handle && !state.profiles[e.userId]?.userHandle)
        && !(state.rosterRetryAt > Date.now())) {
      await optional(async signal => {
        let pages = 0, received = 0, hasMore = true, cursorAdvanced = false, reason = 'page-limit';
        try {
          state.rosterRetryAt = Date.now() + 60000;
          const current = await request('/v2/users/current', { signal });
          if (!current?.id || typeof current.id !== 'string') throw fomoFailure('invalid-response');
          let cursor = state.profileRosterCursor || '';
          const seen = new Set([cursor]);
          for (let page = 0; page < 3; page++) {
            const box = await request(`/v2/users/${encodeURIComponent(current.id)}/followingPaginate${cursor ? `?lastId=${encodeURIComponent(cursor)}` : ''}`, { signal });
            if (!Array.isArray(box.users)) throw fomoFailure('invalid-response');
            pages++; received += box.users.length;
            if (!box.users.length) { hasMore = false; state.profileRosterCursor = ''; reason = 'complete'; break; }
            for (const raw of box.users) {
              const user = slimFomoFollowedHolder(raw);
              if (ids.has(user.userId) && user.handle) state.profiles[user.userId] = { userHandle:user.handle, profilePictureLink:user.avatar };
            }
            const next = String(box.users.at(-1)?.id || '');
            if (!next || seen.has(next)) { cursorAdvanced = false; reason = 'cursor-stalled'; state.profileRosterCursor = ''; break; }
            cursorAdvanced = next !== cursor; seen.add(next); cursor = next; state.profileRosterCursor = next;
          }
        } catch (error) { reason = error.reason === 'invalid-response' ? 'invalid-response' : 'error'; throw error; }
        finally { globalThis.gdhDebug?.record('pagination', { endpoint:'following-profiles', pages, received, hasMore, cursorAdvanced, reason }); }
      }, 3000);
    }
    // Direct ID lookup has no trade-ID eligibility gate. Retry misses fairly.
    const missingProfiles = [...new Map([...metadataRows.values()]
      .filter(e => !state.profiles[e.userId]?.userHandle && !e.handle && !(state.profileRetry[e.userId] > Date.now()))
      .map(e => [e.userId,e])).values()]
      .sort((a,b) => (state.profileRetry[a.userId] || 0) - (state.profileRetry[b.userId] || 0)).slice(0,12);
    await fomoCollectorPool(missingProfiles.map(event => () => optional(async signal => {
      state.profileRetry[event.userId] = Date.now() + 60000;
      const box = await request(`/v2/users/${encodeURIComponent(event.userId)}`, { signal });
      if (box?.id !== event.userId) return;
      const user = slimFomoFollowedHolder(box);
      if (user.handle) state.profiles[event.userId] = { userHandle:user.handle, profilePictureLink:user.avatar };
    })));
    for (const event of metadataRows.values()) {
      const profile = state.profiles[event.userId];
      if (!event.handle && profile?.userHandle) { event.handle = String(profile.userHandle).trim().replace(/^@/,'').toLowerCase().slice(0,64); event.name = event.handle.slice(0,48); }
      if (!event.avatar) event.avatar = fomoHttpsUrl(profile?.profilePictureLink);
      const ref = tokenRef(event), data = ref && state.tokens[tokenKey(ref)];
      for (const field of ['symbol','tokenName','img']) if (!event[field] && data?.[field]) event[field] = data[field];
      if (event.dataSource !== 'trading-activity' && (!event.mc || event.mcSource === 'current-token')) {
        const fresh = data?.mcUpdatedAt > Date.now()-15000 && data?.mcUpdatedAt <= Date.now();
        event.mc = fresh ? fomoMetadataNumber(data.mc) : 0;
        event.mcSource = 'current-token';
        event.mcUpdatedAt = fresh ? data.mcUpdatedAt : 0;
      }
      collected.set(event.key,event);
    }
    state.tokens = Object.fromEntries(Object.entries(state.tokens).sort((a,b) => b[1].retryAt-a[1].retryAt).slice(0,FOMO_FEED_KEEP));
    publish();
    await Promise.resolve(); // Flush incremental publication before authoritative coverage.
    if (!valid()) return { ok: false, reason: generation !== fomoAuthGeneration ? 'not-connected' : 'roster-changed', ...emptyFomoFollowedFeed() };
    if (failures.some(error => error.reason === 'not-connected')) {
      resetFomoAccountCaches();
      await fomoCollectorSave;
      return { ok: false, reason: 'not-connected', ...emptyFomoFollowedFeed() };
    }
    fomoCollector = state;
    const merged = new Map(fomoFollowedFeedCache.events.filter(event => ids.has(event.userId)).map(event => [event.key, event]));
    for (const [key, event] of collected) merged.set(key, event);
    const pending = Object.values(state.positions).some(rows => Object.values(rows).some(row => row.pending));
    const nativeComplete = state.lanes.alerts && !state.lanes.alerts.gap && !failures.length && !coverage.rejected && !coverage.unsupported;
    const gap = !nativeComplete && (failures.length > 0 || coverage.rejected > 0 || coverage.unsupported > 0 || chosen.length < users.length || pending
      || Object.values(state.lanes).some(lane => lane.gap) || Object.values(state.watches).some(ref => ref.gap));
    fomoFollowedFeedCache = {
      events: fomoMergeFollowedEvents([...merged.values()]).sort((a, b) => b.ts - a.ts || a.key.localeCompare(b.key)).slice(0, FOMO_FEED_KEEP),
      fetchedAt: Date.now(), updatedAt: coverage.succeeded ? Date.now() : fomoFollowedFeedCache.updatedAt,
      coverageGap: gap, gapReason: failures.length ? 'partial-failure' : gap ? 'bounded-recovery' : '',
      followingKnown: true, historyLimited: true, stale: failures.length > 0, partial: failures.length > 0,
      coverage, ...(failures.length ? { reason: failures[0].reason || 'fetch-failed' } : {}),
    };
    globalThis.gdhDebug?.record('collector', {
      received:fetchedEventCount, retained:fomoFollowedFeedCache.events.length,
      missingProfiles:fomoFollowedFeedCache.events.filter(e=>!e.handle).length,
      missingSymbols:fomoFollowedFeedCache.events.filter(e=>!e.symbol).length,
      missingMC:fomoFollowedFeedCache.events.filter(e=>!e.mc).length,
      buy:fomoFollowedFeedCache.events.filter(e=>e.type==='buy').length,
      sell:fomoFollowedFeedCache.events.filter(e=>e.type==='sell').length,
      thesis:fomoFollowedFeedCache.events.filter(e=>e.type==='thesis').length,
      coverageGap:gap, attempted:coverage.attempted, succeeded:coverage.succeeded,
      rejected:coverage.rejected, unsupported:coverage.unsupported, usersAttempted:chosen.length, usersTotal:users.length,
    });
    await persistFomoCollector();
    return { ok: failures.length === 0, ...fomoFollowedFeedCache };
  })().finally(() => { if (fomoFollowedFeedInflight?.promise === promise) fomoFollowedFeedInflight = null; });
  fomoFollowedFeedInflight = { generation, promise };
  return promise;
}

function fomoDebugEndpoint(path) {
  const base=String(path).split('?')[0];
  if (base==='/v2/users/current/followingIds') return 'current-following';
  if (/^\/v2\/users\/[^/]+\/swaps$/.test(base)) return 'user-swaps';
  if (/^\/v2\/users\/[^/]+\/balances$/.test(base)) return 'user-balances';
  if (base==='/feed') return 'social-feed';
  if (base==='/feed/tradingActivity') return 'trading-activity';
  if (/^\/v2\/users\/[^/]+\/followingPaginate$/.test(base)) return 'following-profiles';
  if (/^\/v2\/users\/[^/]+$/.test(base)) return 'user-profile';
  if (base==='/feed/token/thesis') return 'token-thesis';
  if (base==='/proxy/filterTokens') return 'token-metadata';
  if (base==='/hodlers/friends') return 'friends';
  if (/^\/trades\/[^/]+$/.test(base)) return 'trade-profile';
  return 'other';
}
async function fomoAuthedFetch(path, options) {
  const started=Date.now();
  try {
    const result=await fomoAuthedFetchImpl(path,options);
    let reason=result.res.ok ? 'success' : 'http-error';
    if (globalThis.gdhDebug?.enabled && result.res.ok) {
      const body=await result.res.clone().json().catch(()=>null);
      if (fomoBodyUnauthed(body)) reason='not-connected';
      else if (fomoBodyFailed(body)) reason='invalid-response';
    }
    globalThis.gdhDebug?.record('request',{endpoint:fomoDebugEndpoint(path),status:result.res.status,durationMs:Date.now()-started,reason});
    return result;
  } catch(error) {
    globalThis.gdhDebug?.record('request',{endpoint:fomoDebugEndpoint(path),status:error.status || 0,durationMs:Date.now()-started,reason:error.reason || 'error'});
    throw error;
  }
}
async function fomoAuthedFetchImpl(path, options) {
  options = options || {};
  const generation = fomoAuthGeneration;
  if (Date.now() < fomoApiRetryAt) throw fomoFailure('backoff', undefined, fomoApiRetryAt);
  let stored = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
  if (stored?.refresh && stored.exp && stored.exp - Date.now() < 10000) {
    stored = (await fomoRefreshSession())
      || (await chrome.storage.local.get('fomoToken')).fomoToken
      || null;
  }
  const send = async (token) => {
    if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
    if (Date.now() < fomoApiRetryAt) throw fomoFailure('backoff', undefined, fomoApiRetryAt);
    const headers = {
      Accept: 'application/json',
      'X-Supported-Chains': FOMO_CHAINS,
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${FOMO_API}${path}`, { ...options, headers, credentials: 'include', signal: controller.signal });
      // Keep the deadline alive until the body is drained, not merely until
      // headers arrive. Otherwise a stalled body strands every coalesced retry.
      await response.clone().text();
      if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
      if (response.status === 429 || (response.status >= 500 && !options.collector)) {
        fomoApiFailures += 1;
        const retry = response.headers?.get('Retry-After');
        const seconds = retry == null ? NaN : Number(retry);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(retry || '') || 0) - Date.now();
        fomoApiRetryAt = Date.now() + Math.min(300000, Math.max(15000, delay, 15000 * (2 ** Math.min(fomoApiFailures - 1, 4))));
      } else if (response.ok && Date.now() >= fomoApiRetryAt) {
        fomoApiFailures = 0;
      }
      return response;
    } catch (error) {
      if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
      if (!options.collector) {
        fomoApiFailures += 1;
        fomoApiRetryAt = Math.max(fomoApiRetryAt, Date.now() + Math.min(300000, 15000 * (2 ** Math.min(fomoApiFailures - 1, 4))));
      }
      throw fomoFailure('network', undefined, fomoApiRetryAt);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  };
  let res = await send(stored?.token);
  let renewed = false;
  let bodyUnauthed = false;
  if (res.ok) {
    const probe = await res.clone().json().catch(() => null);
    bodyUnauthed = fomoBodyUnauthed(probe);
  }
  if ((res.status === 401 || res.status === 403 || res.status === 430 || res.status === 431 || bodyUnauthed)
    && stored?.refresh) {
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

const FOMO_FOLLOWED_HOLDERS_TTL_MS = 60000;
const FOMO_FOLLOWED_HOLDERS_CACHE_MAX = 30;
const fomoFollowedHoldersCache = new Map();

function normalizeFomoTokenRef(raw) {
  const networkId = Number(raw?.networkId);
  const source = String(raw?.address || raw?.tokenAddress || '').trim();
  const evm = /^0x[a-fA-F0-9]{40}$/.test(source);
  const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(source);
  if (!FOMO_NETWORK_SLUG[networkId] || (!evm && !sol)) return null;
  return { address: evm ? source.toLowerCase() : source, networkId };
}

function slimFomoFollowedHolder(raw) {
  const user = raw?.user && typeof raw.user === 'object' ? raw.user : raw || {};
  const handle = String(user.userHandle || user.handle || raw?.userHandle || '').trim().replace(/^@/, '');
  const display = String(user.displayName || raw?.displayName || '').trim();
  const userId = String(user.id || raw?.userId || '').trim();
  return {
    userId: userId.slice(0, 100),
    handle: handle.slice(0, 64),
    name: (handle || display || 'Followed user').slice(0, 64),
    avatar: fomoHttpsUrl(user.profilePictureLink || raw?.profilePictureLink),
  };
}

async function fetchFomoFollowedHolders(payload) {
  const tokens = payload?.tokens;
  const normalized = (Array.isArray(tokens) ? tokens : [])
    .map(normalizeFomoTokenRef)
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((other) => (
      other.networkId === item.networkId && other.address === item.address
    )) === index)
    .slice(0, 100);
  if (!normalized.length) return { ok: true, holdings: [] };
  const key = normalized
    .map((item) => `${item.networkId}:${item.address}`)
    .sort()
    .join('|');
  const hit = fomoFollowedHoldersCache.get(key);
  if (hit && Date.now() - hit.at < FOMO_FOLLOWED_HOLDERS_TTL_MS) return hit.data;

  try {
    const generation = fomoAuthGeneration;
    const { res } = await fomoAuthedFetch('/hodlers/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens: normalized }),
    });
    const body = await res.json().catch(() => null);
    if (generation !== fomoAuthGeneration) {
      return { ok: false, reason: 'not-connected', holdings: [] };
    }
    if (!res.ok || fomoBodyUnauthed(body) || fomoBodyFailed(body)) {
      const unauthorized = [401, 403, 430, 431].includes(res.status) || fomoBodyUnauthed(body);
      if (unauthorized) fomoFollowedHoldersCache.clear();
      return { ok: false, reason: unauthorized ? 'not-connected' : 'fetch-failed', holdings: [] };
    }
    const response = body?.responseObject;
    const boxes = Array.isArray(response?.tokens) ? response.tokens : Array.isArray(response) ? response : null;
    if (!boxes) return { ok: false, reason: 'invalid-response', holdings: [] };
    const holdings = boxes.map((box) => {
      const ref = normalizeFomoTokenRef(box);
      if (!ref || !normalized.some(token => token.address === ref.address && token.networkId === ref.networkId)) return null;
      const users = (Array.isArray(box?.topHolders) ? box.topHolders : [])
        .map(slimFomoFollowedHolder);
      const count = Number(box?.totalHolders);
      return {
        ...ref,
        count: Number.isFinite(count) && count >= 0 ? count : users.length,
        users,
      };
    }).filter(Boolean);
    const data = { ok: true, holdings };
    setBoundedMap(fomoFollowedHoldersCache, key, { at: Date.now(), data }, FOMO_FOLLOWED_HOLDERS_CACHE_MAX);
    return data;
  } catch (error) {
    return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 80), holdings: [] };
  }
}

const FOMO_TRADE_DETAIL_TTL_MS = 60000;
const FOMO_TRADE_DETAIL_CACHE_MAX = 500;
const FOMO_TOKEN_TRADE_HOLDER_LIMIT = 50;
const FOMO_TOKEN_TRADE_FALLBACK_TTL_MS = 120000;
const FOMO_TOKEN_TRADE_FALLBACK_CACHE_MAX = 100;
const fomoTradeDetailCache = new Map();
const fomoTokenTradeFallbackCache = new Map();
const fomoTradeDetailInflight = new Map();
const fomoTokenTradeFallbackInflight = new Map();

async function fomoMapLimit(values, limit, worker) {
  const items = Array.from(values || []);
  const output = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return output;
}

async function fetchFomoTradeDetail(tradeId) {
  const id = String(tradeId || '').trim();
  if (!/^[0-9a-f-]{20,80}$/i.test(id)) return null;
  const hit = fomoTradeDetailCache.get(id);
  if (hit && Date.now() - hit.at < FOMO_TRADE_DETAIL_TTL_MS) return hit.data;
  const generation = fomoAuthGeneration;
  const active = fomoTradeDetailInflight.get(id);
  if (active?.generation === generation) return active.promise;
  const promise = (async () => {
    try {
      const { res } = await fomoAuthedFetch(`/trades/${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => null);
      if (generation !== fomoAuthGeneration) return null;
      if (!res.ok || fomoBodyUnauthed(body) || fomoBodyFailed(body)) return null;
      const value = body?.responseObject;
      const data = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.swaps) ? value : null;
      if (data) setBoundedMap(fomoTradeDetailCache, id, { at: Date.now(), data }, FOMO_TRADE_DETAIL_CACHE_MAX);
      return data;
    } catch {
      return null;
    } finally {
      if (fomoTradeDetailInflight.get(id)?.promise === promise) fomoTradeDetailInflight.delete(id);
    }
  })();
  fomoTradeDetailInflight.set(id, { generation, promise });
  return promise;
}

function slimFomoTokenSwap(raw, detail, tokenAddress, positionAction) {
  if (!raw || typeof raw !== 'object') return null;
  const target = String(tokenAddress || '').toLowerCase();
  const inAddress = String(raw.inTokenAddress || '').toLowerCase();
  const outAddress = String(raw.outTokenAddress || '').toLowerCase();
  const side = outAddress === target ? 'buy' : inAddress === target ? 'sell' : '';
  if (!side) return null;
  const trade = detail?.trade && typeof detail.trade === 'object' ? detail.trade : {};
  const user = detail?.user && typeof detail.user === 'object' ? detail.user : {};
  const usdAmount = Number(side === 'buy' ? raw.humanUsdAmountIn : raw.humanUsdAmountOut);
  const fallbackUsd = Math.max(
    Math.abs(Number(raw.humanUsdAmountIn) || 0),
    Math.abs(Number(raw.humanUsdAmountOut) || 0),
  );
  return {
    id: String(raw.id || `${trade.id || 'trade'}:${raw.txHash || raw.createdAt || ''}`).slice(0, 180),
    type: side === 'buy' ? 'swap_buy' : 'swap_sell',
    side,
    positionAction,
    isBuy: side === 'buy',
    isSell: side === 'sell',
    isFirstTrade: positionAction === 'First',
    isFullExit: positionAction === 'All',
    createdAt: raw.createdAt || trade.openedAt || '',
    txHash: String(raw.txHash || '').slice(0, 180),
    tradeId: String(trade.id || '').slice(0, 100),
    tokenAddress,
    networkId: Number(trade.networkId),
    usdAmount: Number.isFinite(usdAmount) && usdAmount !== 0 ? Math.abs(usdAmount) : fallbackUsd,
    user: {
      id: String(user.id || trade.userId || '').slice(0, 100),
      userHandle: String(user.userHandle || '').trim().replace(/^@/, '').slice(0, 64),
      displayName: String(user.displayName || '').slice(0, 64),
      profilePictureLink: fomoHttpsUrl(user.profilePictureLink),
    },
    authorTrade: {
      id: String(trade.id || '').slice(0, 100),
      openedAt: trade.openedAt || '',
      closedAt: trade.closedAt || '',
      usdValue: Number(trade.usdValue) || 0,
      realizedPnlUsd: Number(trade.realizedPnlUsd) || 0,
      unrealizedPnlUsd: Number(trade.unrealizedPnlUsd) || 0,
    },
  };
}

function fomoSwapsFromTrade(detail, tokenAddress) {
  const trade = detail?.trade && typeof detail.trade === 'object' ? detail.trade : {};
  const target = String(tokenAddress || '').toLowerCase();
  const swaps = (Array.isArray(detail?.swaps) ? detail.swaps : [])
    .filter((swap) => {
      const input = String(swap?.inTokenAddress || '').toLowerCase();
      const output = String(swap?.outTokenAddress || '').toLowerCase();
      return input === target || output === target;
    })
    .sort((a, b) => (Date.parse(a?.createdAt || '') || 0) - (Date.parse(b?.createdAt || '') || 0));
  let sawBuy = false;
  return swaps.map((swap, index) => {
    const side = String(swap?.outTokenAddress || '').toLowerCase() === target ? 'buy' : 'sell';
    let positionAction;
    if (side === 'buy') {
      positionAction = sawBuy ? 'More' : 'First';
      sawBuy = true;
    } else {
      const isLast = index === swaps.length - 1;
      positionAction = trade.closedAt && isLast ? 'All' : 'Partial';
    }
    return slimFomoTokenSwap(swap, detail, tokenAddress, positionAction);
  }).filter(Boolean);
}

async function fetchFomoTokenTradeFallback(tokenAddress, holders) {
  const generation = fomoAuthGeneration;
  if (!Array.isArray(holders)) return { ok: false, reason: 'invalid-response' };
  const seen = new Set();
  let missingTrade = false;
  const candidates = holders.map((item) => ({
    id: String(item?.tradeId || item?.authorTrade?.id || '').trim(),
    user: item?.user && typeof item.user === 'object' ? item.user : {},
  })).filter((item) => {
    if (!item.id) { missingTrade = true; return false; }
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const trades = candidates.slice(0, FOMO_TOKEN_TRADE_HOLDER_LIMIT);
  const cacheKey = `${String(tokenAddress || '')}|${trades.map((item) => item.id).sort().join(',')}|${candidates.length}|${missingTrade}`;
  const cached = fomoTokenTradeFallbackCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FOMO_TOKEN_TRADE_FALLBACK_TTL_MS) return cached.data;
  const active = fomoTokenTradeFallbackInflight.get(cacheKey);
  if (active?.generation === generation) return active.promise;
  const promise = (async () => {
    try {
      const details = await fomoMapLimit(trades, 6, async (item) => {
        if (generation !== fomoAuthGeneration) return null;
        const detail = await fetchFomoTradeDetail(item.id);
        if (!detail || !Array.isArray(detail.swaps)) return null;
        const detailUser = detail.user && typeof detail.user === 'object' ? detail.user : {};
        return {
          ...detail,
          user: {
            ...item.user, ...detailUser,
            id: detailUser.id || item.user.id || '',
            userHandle: detailUser.userHandle || item.user.userHandle || '',
            displayName: detailUser.displayName || item.user.displayName || '',
            profilePictureLink: detailUser.profilePictureLink || item.user.profilePictureLink || '',
          },
        };
      });
      if (generation !== fomoAuthGeneration) return { ok: false, reason: 'not-connected' };
      const succeeded = details.filter(Boolean).length;
      if ((trades.length && !succeeded) || (!trades.length && missingTrade)) return { ok: false, reason: 'detail-failed', ...(fomoApiRetryAt > Date.now() ? { retryAt: fomoApiRetryAt } : {}) };
      const items = [...new Map(details.flatMap((detail) => fomoSwapsFromTrade(detail, tokenAddress)).map((item) => [item.id, item])).values()]
        .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0) || a.id.localeCompare(b.id));
      const data = {
        ok: true, items, count: items.length, source: 'holder-history', fetchedAt: Date.now(),
        partial: missingTrade || succeeded !== trades.length,
        coverage: { attempted: trades.length, succeeded, limit: FOMO_TOKEN_TRADE_HOLDER_LIMIT, truncated: candidates.length > trades.length },
      };
      // A successful subset must NEVER poison either this cache or the outer token cache.
      if (details.every(Boolean) && !data.partial) {
        setBoundedMap(fomoTokenTradeFallbackCache, cacheKey, { at: Date.now(), data }, FOMO_TOKEN_TRADE_FALLBACK_CACHE_MAX);
      }
      return data;
    } finally {
      if (fomoTokenTradeFallbackInflight.get(cacheKey)?.promise === promise) fomoTokenTradeFallbackInflight.delete(cacheKey);
    }
  })();
  fomoTokenTradeFallbackInflight.set(cacheKey, { generation, promise });
  return promise;
}

const fomoTokenInflight = new Map();
async function fomoFetchToken({ tokenAddress, networkId, kind }) {
  const ref = normalizeFomoTokenRef({ address: tokenAddress, networkId });
  if (!ref || !['holders', 'thesis', 'swaps'].includes(kind)) return { ok: false, reason: 'bad-request' };
  tokenAddress = ref.address;
  networkId = ref.networkId;
  const key = `${kind}|${networkId}|${tokenAddress}`;
  const hit = fomoCache.get(key);
  if (hit && Date.now() - hit.at < FOMO_CACHE_MS) return hit.data;
  const generation = fomoAuthGeneration;
  const active = fomoTokenInflight.get(key);
  if (active?.generation === generation) return active.promise;
  const promise = (async () => {
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
      const { res, stored } = await fomoAuthedFetch(path);
      const body = await res.json().catch(() => null);
      if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
      if ([401, 403, 430, 431].includes(res.status) || fomoBodyUnauthed(body)) {
        throw fomoFailure(stored?.token ? 'expired' : 'no-token', res.status);
      }
      fomoCheckResponse(res, body);
      const ro = body?.responseObject;
      // Only known arrays qualify as empty. A missing/malformed payload is failure.
      const box = kind === 'holders' && Array.isArray(ro) ? ro[0] : ro;
      let items = kind === 'holders' ? box?.topHolders : (Array.isArray(ro) ? ro : ro?.items);
      if (!Array.isArray(items)) throw fomoFailure('invalid-response');
      const total = kind === 'holders' && box?.totalHolders != null ? Number(box.totalHolders) : undefined;
      let data = {
        ok: true, items, count: items.length,
        source: kind === 'swaps' ? 'token-feed' : kind,
        fetchedAt: Date.now(), partial: false,
        coverage: {
          attempted: 1, succeeded: 1, limit: kind === 'holders' ? items.length : 50,
          truncated: kind === 'holders' ? Number.isFinite(total) && total > items.length
            : (typeof ro?.hasNextPage === 'boolean' ? ro.hasNextPage : items.length >= 50),
        },
      };
      if (Number.isFinite(total) && total >= 0) data.total = total;
      if (kind === 'swaps' && !items.length) {
        const holders = await fomoFetchToken({ tokenAddress, networkId, kind: 'holders' });
        if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
        if (!holders.ok) return holders;
        const fallback = await fetchFomoTokenTradeFallback(tokenAddress, holders.items);
        if (!fallback.ok) return fallback;
        data = { ...fallback, coverage: { ...fallback.coverage, truncated: fallback.coverage.truncated || holders.coverage.truncated } };
      }
      const followedIds = await fetchFomoFollowingIds().catch(() => null);
      if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
      data = { ...data, items: fomoAnnotateFollowing(data.items, followedIds), followingKnown: followedIds !== null };
      // Unknown follows and partial detail successes must be retried, not authoritative hits.
      if (!data.partial && data.followingKnown) setBoundedMap(fomoCache, key, { at: Date.now(), data }, FOMO_CACHE_MAX);
      return data;
    } catch (error) {
      if (generation !== fomoAuthGeneration) return { ok: false, reason: 'not-connected' };
      return {
        ok: false, reason: error.reason || 'network',
        ...(error.status ? { status: error.status } : {}),
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      };
    }
  })().finally(() => {
    if (fomoTokenInflight.get(key)?.promise === promise) fomoTokenInflight.delete(key);
  });
  fomoTokenInflight.set(key, { generation, promise });
  return promise;
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
    if (!res.ok) {
      return { ok: false, reason: [401, 403, 430, 431].includes(res.status) ? 'expired' : `http-${res.status}` };
    }
    const body = await res.json().catch(() => null);
    const inner = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(inner) && inner !== 200)) {
      return { ok: false, reason: fomoBodyUnauthed(body) ? 'expired' : `api-${inner || 'error'}` };
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
const SUPPLY_SEL = { totalSupply: '0x18160ddd', decimals: '0x313ce567' };
const BSC_SUPPLY_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];

const SUPPLY_RPCS = {
  bsc: [...BSC_SUPPLY_RPCS, 'https://bsc-rpc.publicnode.com'],
  eth: ['https://ethereum-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
};
async function supplyRpc(rpc, calls) {
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

async function tokenSupply({ chain, address, apiQuery }) {
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
  const endpoints = chainRpcs;
  let lastError = '';
  for (const endpoint of endpoints) {
    try {
      const [rawSupply, rawDec] = await supplyRpc(endpoint, [
        { to: address, data: SUPPLY_SEL.totalSupply },
        { to: address, data: SUPPLY_SEL.decimals },
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

function resetFomoAccountCaches(preservePassive = false) {
  if (!preservePassive) clearFomoPassive(true);
  fomoAuthGeneration += 1;
  void pushPassiveFomo();
  fomoCollector = emptyFomoCollector();
  fomoCollectorHydration = null;
  void persistFomoCollector(true);
  fomoApiRetryAt = 0;
  fomoApiFailures = 0;
  fomoFollowedFeedCache = emptyFomoFollowedFeed();
  fomoFollowedFeedCheckpoint = null;
  fomoFollowingIdsCache = { ids: new Set(), fetchedAt: 0 };
  fomoFollowingIdsInflight = null;
  fomoFollowedFeedInflight = null;
  fomoCache.clear();
  fomoFollowedHoldersCache.clear();
  fomoTradeDetailCache.clear();
  fomoTokenTradeFallbackCache.clear();
  fomoTradeDetailInflight.clear();
  fomoTokenTradeFallbackInflight.clear();
  fomoTokenInflight.clear();
  fomoPnlCache.clear();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.debugLogging) void globalThis.gdhDebug?.setEnabled(changes.debugLogging.newValue === true);
  if (changes.fomoToken) {
    const previousAccount = fomoAccountIdentity(changes.fomoToken.oldValue);
    const nextAccount = fomoAccountIdentity(changes.fomoToken.newValue);
    if (previousAccount !== nextAccount || (!nextAccount && changes.fomoToken.oldValue?.token !== changes.fomoToken.newValue?.token)) {
      // Native observation may precede the legacy session mirror at document_idle.
      // Preserve only an EXACT account match already observed in this document.
      resetFomoAccountCaches(!!nextAccount && nextAccount === fomoPassive.accountId);
    }
  }

});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fomo-passive-event') {
    if (fomoPassiveQueued >= 64) { sendResponse({ok:false,reason:'bridge-busy'}); return false; }
    fomoPassiveQueued++;
    fomoPassiveQueue = fomoPassiveQueue.catch(() => {}).then(() => ingestPassiveFomo(message.data, sender));
    fomoPassiveQueue.then(sendResponse).catch(() => sendResponse({ok:false,reason:'invalid-payload'})).finally(() => {fomoPassiveQueued--;});
    return true;
  }
  if (['debug-export','debug-clear','debug-render'].includes(message?.type)) {
    const popup = sender?.url === chrome.runtime.getURL('popup.html');
    let site = '';
    try { site = new URL(sender?.url || '').hostname; } catch {}
    if (message.type === 'debug-render') {
      if (site === 'gmgn.ai') globalThis.gdhDebug?.record('render', message.fields);
      sendResponse({ok:true}); return false;
    }
    if (!popup || !globalThis.gdhDebug) { sendResponse({ok:false}); return false; }
    (message.type === 'debug-clear' ? globalThis.gdhDebug.clear() : globalThis.gdhDebug.export())
      .then(data => sendResponse({ok:message.type!=='debug-clear' || data===true,data})).catch(() => sendResponse({ok:false}));
    return true;
  }
  if (message?.type === 'fomo-page-heartbeat') {
    recordFomoPageHeartbeat(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

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

  if (message?.type === 'fomo-followed-feed') {
    fetchFomoFollowedFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'fomo-followed-holders') {
    fetchFomoFollowedHolders(message.payload || {})
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
