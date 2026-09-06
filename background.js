'use strict';

importScripts('vendor/socket.io.min.js');

const J7TRACKER_SYNC_ALARM = '985gmgn-j7tracker-sync';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(J7TRACKER_SYNC_ALARM, { periodInMinutes: 5 });
  chrome.storage.local.remove([
    'monitor985SessionV1', 'monitor985ClientIdV1', 'monitor985SyncStateV1',
    'monitorFomoConfig', 'monitorPumpConfig',
  ]).catch(() => {});
  refreshJ7TrackerState(true);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(J7TRACKER_SYNC_ALARM, { periodInMinutes: 5 });
  fomoKeepAlive(true);
  refreshJ7TrackerState(true);
});

const FOMO_KEEPALIVE_ALARM = '985gmgn-fomo-keepalive';
chrome.alarms.get(FOMO_KEEPALIVE_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(FOMO_KEEPALIVE_ALARM, { periodInMinutes: 5 });
}).catch(() => {});
chrome.alarms.get(J7TRACKER_SYNC_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(J7TRACKER_SYNC_ALARM, { periodInMinutes: 5 });
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
  if (alarm.name === J7TRACKER_SYNC_ALARM) refreshJ7TrackerState(true);
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
  const key = String(raw.id || raw.key || raw.tradeId || `${type}:${userId}:${addr}:${ts}`).slice(0, 180);
  const rawComment = raw.comment && typeof raw.comment === 'object' ? raw.comment.comment : raw.comment;
  const comment = String(rawComment || raw.text || raw.thesis || body.comment || body.text || '').slice(0, 1500);
  return {
    key: `fomo-followed:${key}`,
    source: 'fomo-followed',
    type,
    position: fomoActivityPosition(raw, type),
    followed: true,
    userId: userId.slice(0, 100),
    handle: handle.toLowerCase().slice(0, 64),
    name: String(handle || raw.displayName || raw.userName || user.displayName || 'Followed user').slice(0, 48),
    avatar: fomoHttpsUrl(raw.profilePictureLink || raw.avatar || user.profilePictureLink),
    usd: Math.abs(Number(raw.usdAmount ?? raw.usdValue ?? body.totalVolume ?? trade.usdValue)) || 0,
    comment,
    addr: addr.slice(0, 80),
    chain: fomoNetworkSlug({ ...raw, networkId }),
    chainName: String(raw.networkName || raw.chainName || '').slice(0, 32),
    symbol: String(raw.ticker || raw.symbol || body.ticker || token.ticker || token.symbol || '').slice(0, 24),
    img: fomoHttpsUrl(raw.tokenImageUrl || raw.tokenImage || token.imageUrl || token.image),
    mc: Number(raw.fdv ?? raw.marketCap ?? body.fdv ?? body.marketCap) || 0,
    ts,
    tx: String(raw.txHash || raw.transactionHash || raw.tradeId || body.txHash || '').trim().slice(0, 180),
  };
}

const FOMO_FOLLOWED_FEED_MIN_INTERVAL_MS = 15000;
const FOMO_FOLLOWING_IDS_CACHE_MS = 120000;
const FOMO_FEED_KEEP = 150;
// Checkpoints are intentionally memory-only: a worker restart is NOT continuous coverage.
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
      fomoFollowingIdsCache = { ids, fetchedAt: Date.now() };
      return ids;
    } finally {
      if (fomoFollowingIdsInflight?.promise === promise) fomoFollowingIdsInflight = null;
    }
  })();
  fomoFollowingIdsInflight = { generation, promise };
  return promise;
}

async function fetchFomoFollowedFeed() {
  if (fomoFollowedFeedInflight?.generation === fomoAuthGeneration) return fomoFollowedFeedInflight.promise;
  if (fomoFollowedFeedCache.fetchedAt && Date.now() - fomoFollowedFeedCache.fetchedAt < FOMO_FOLLOWED_FEED_MIN_INTERVAL_MS) {
    return { ok: !fomoFollowedFeedCache.reason, ...fomoFollowedFeedCache };
  }
  const generation = fomoAuthGeneration;
  const promise = (async () => {
    let followedIds;
    const collected = new Map();
    let pages = 0;
    let head = null;
    let overlap = false;
    let caughtUp = false;
    let gapReason = '';
    let failure = null;
    const checkpoint = fomoFollowedFeedCheckpoint;
    try {
      followedIds = await fetchFomoFollowingIds();
      if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
      // Checkpoints come from the GLOBAL feed, even with zero follows.
      for (let page = 0; page < FOMO_FOLLOWED_FEED_MAX_PAGES; page += 1) {
        const { res } = await fomoAuthedFetch(`/feed/tradingActivity?limit=${FOMO_FOLLOWED_FEED_PAGE_LIMIT}&page=${page}`);
        const body = await res.json().catch(() => null);
        if (generation !== fomoAuthGeneration) throw fomoFailure('not-connected');
        fomoCheckResponse(res, body);
        const box = body?.responseObject ?? body;
        const rawItems = Array.isArray(box) ? box : box?.items;
        if (!Array.isArray(rawItems)) throw fomoFailure('invalid-response');
        pages += 1;
        const anchors = rawItems.map(fomoEventCheckpoint).filter(Boolean);
        if (page === 0) head = anchors.reduce((best, item) => !best || item.ts > best.ts ? item : best, null);
        if (checkpoint && anchors.some((item) => item.id === checkpoint.id && item.ts === checkpoint.ts)) overlap = true;
        for (const raw of rawItems) {
          const event = slimFomoFollowedEvent(raw, followedIds);
          if (event) collected.set(event.key, event);
        }
        const hasNext = typeof box?.hasNextPage === 'boolean' ? box.hasNextPage
          : typeof body?.hasNextPage === 'boolean' ? body.hasNextPage : rawItems.length >= FOMO_FOLLOWED_FEED_PAGE_LIMIT;
        // Read past the checkpoint's timestamp bucket so ties on a later page aren't lost.
        caughtUp = !!checkpoint && overlap && (!hasNext || anchors.some((item) => item.ts < checkpoint.ts));
        if (!checkpoint) { gapReason = 'restart-baseline'; break; }
        if (caughtUp) break;
        if (!hasNext) { gapReason = 'checkpoint-missing'; break; }
        if (!rawItems.length) { gapReason = 'pagination-stalled'; break; }
        if (page === FOMO_FOLLOWED_FEED_MAX_PAGES - 1) gapReason = 'page-cap';
      }
    } catch (error) {
      // A rejected old request must not return or overwrite the NEW account's data.
      if (generation !== fomoAuthGeneration) return { ok: false, reason: 'not-connected', events: [], ...emptyFomoFollowedFeed() };
      failure = error;
      gapReason = pages ? 'pagination-failed' : (error?.message === 'not-connected' ? 'not-connected' : 'fetch-failed');
    }
    if (generation !== fomoAuthGeneration) return { ok: false, reason: 'not-connected', ...emptyFomoFollowedFeed() };
    if (failure?.reason === 'not-connected' || failure?.message === 'not-connected') {
      fomoFollowedFeedCache = emptyFomoFollowedFeed();
      fomoFollowedFeedCheckpoint = null;
      fomoFollowingIdsCache = { ids: new Set(), fetchedAt: 0 };
      return { ok: false, reason: 'not-connected', ...fomoFollowedFeedCache };
    }
    const previous = fomoFollowedFeedCache;
    const retained = previous.events.filter((event) => !followedIds || followedIds.has(event.userId));
    const merged = new Map(retained.map((event) => [event.key, event]));
    for (const [key, event] of collected) merged.set(key, event);
    const events = [...merged.values()].sort((a, b) => b.ts - a.ts || a.key.localeCompare(b.key)).slice(0, FOMO_FEED_KEEP);
    // On a gap keep the last verified checkpoint so the next poll can repair it.
    if (head && (!checkpoint || caughtUp)) fomoFollowedFeedCheckpoint = head;
    fomoFollowedFeedCache = {
      events,
      fetchedAt: pages ? Date.now() : previous.fetchedAt,
      updatedAt: pages ? Date.now() : previous.updatedAt,
      coverageGap: !caughtUp || Boolean(failure),
      // Coverage describes continuity since our baseline, never lifetime history.
      gapReason: gapReason || (caughtUp ? '' : 'restart-baseline'),
      historyLimited: true,
      stale: Boolean(failure),
      followingKnown: !!followedIds,
      ...(failure ? { reason: failure.reason || 'fetch-failed' } : {}),
      ...(failure?.status ? { status: failure.status } : {}),
      ...(failure?.retryAt ? { retryAt: failure.retryAt } : {}),
    };
    if (failure) {
      return {
        ok: false, ...fomoFollowedFeedCache, stale: true,
        reason: failure.reason || 'fetch-failed',
        ...(failure.status ? { status: failure.status } : {}),
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      };
    }
    return { ok: true, ...fomoFollowedFeedCache };
  })().finally(() => {
    if (fomoFollowedFeedInflight?.promise === promise) fomoFollowedFeedInflight = null;
  });
  fomoFollowedFeedInflight = { generation, promise };
  return promise;
}


async function fomoAuthedFetch(path, options) {
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
      if (response.status === 429 || response.status >= 500) {
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
      fomoApiFailures += 1;
      fomoApiRetryAt = Math.max(fomoApiRetryAt, Date.now() + Math.min(300000, 15000 * (2 ** Math.min(fomoApiFailures - 1, 4))));
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

const FOMO_FOLLOWED_HOLDERS_TTL_MS = 30000;
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
    const boxes = Array.isArray(body?.responseObject) ? body.responseObject : [];
    const holdings = boxes.map((box) => {
      const ref = normalizeFomoTokenRef(box);
      if (!ref) return null;
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


function notifyTrackerTabs(messageType) {
  try {
    chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://debot.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: messageType }, () => void chrome.runtime.lastError);
      }
    });
  } catch {
  }
}

const J7TRACKER_API_ORIGIN = 'https://nj.j7tracker.io/wallets';
const J7TRACKER_SOCKET_ORIGIN = 'https://nj.j7tracker.io';
const J7TRACKER_SOCKET_PATH = '/wallets/socket.io/';
const J7TRACKER_CONFIG_TTL_MS = 3 * 60000;
const J7TRACKER_HISTORY_TTL_MS = 12000;
const J7TRACKER_HISTORY_LIMIT = 500;
const J7TRACKER_REQUEST_TIMEOUT_MS = 12000;
const J7TRACKER_RETRY_MS = 15000;
let j7TrackerConfigAt = 0;
let j7TrackerConfigPromise = null;
let j7TrackerConfigPromiseGeneration = -1;
let j7TrackerHistoryAt = 0;
let j7TrackerHistoryPromise = null;
let j7TrackerHistoryPromiseGeneration = -1;
let j7TrackerFomoCache = [];
let j7TrackerPumpCache = [];
let j7TrackerHistoryError = '';
let j7TrackerSessionGeneration = 0;
let j7TrackerRetryAt = 0;
let j7TrackerFomoTrackedCount = 0;
let j7TrackerPumpTrackedCount = 0;
let j7TrackerLiveSocket = null;
let j7TrackerLiveToken = '';
let j7TrackerLiveGeneration = -1;

async function readJ7TrackerSession() {
  const stored = await chrome.storage.local.get(['j7TrackerSessionV1']);
  const session = stored.j7TrackerSessionV1;
  const token = String(session?.token || '').trim();
  if (!token || token.length > 4096) return null;
  return {
    token,
    accountId: String(session?.accountId || '').trim().slice(0, 160),
    displayName: String(session?.displayName || '').trim().slice(0, 100),
  };
}

function resetJ7TrackerCaches() {
  j7TrackerSessionGeneration += 1;
  try { j7TrackerLiveSocket?.disconnect(); } catch {}
  j7TrackerLiveSocket = null;
  j7TrackerLiveToken = '';
  j7TrackerLiveGeneration = -1;
  j7TrackerConfigAt = 0;
  j7TrackerHistoryAt = 0;
  j7TrackerFomoCache = [];
  j7TrackerPumpCache = [];
  j7TrackerHistoryError = '';
  j7TrackerRetryAt = 0;
  j7TrackerFomoTrackedCount = 0;
  j7TrackerPumpTrackedCount = 0;
}

async function setJ7TrackerDisconnected(reason = 'login-required') {
  resetJ7TrackerCaches();
  const checkedAt = Date.now();
  await chrome.storage.local.set({
    j7TrackerSyncStateV1: { connected: false, reason, checkedAt },
    j7TrackerFomoConfigV1: { connected: false, trackedCount: 0, at: checkedAt },
    j7TrackerPumpConfigV1: { connected: false, trackedCount: 0, at: checkedAt },
  });
}

async function fetchJ7TrackerJson(url, session) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), J7TRACKER_REQUEST_TIMEOUT_MS);
  try {
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
    cache: 'no-store',
    signal: controller.signal,
  });
  const body = await resp.json();
  if (!resp.ok || !body || typeof body !== 'object' || body?.error) {
    const error = new Error(`J7Tracker request failed (${resp.status || 0})`);
    error.status = Number(resp.status || 0);
    error.body = body;
    throw error;
  }
  return body;
  } finally {
    clearTimeout(deadline);
  }
}

function j7TrackerListCount(body, key) {
  const list = Array.isArray(body?.[key]) ? body[key] : (Array.isArray(body) ? body : null);
  return list ? list.length : null;
}

async function refreshJ7TrackerState(force = false) {
  if (!force && Date.now() - j7TrackerConfigAt < J7TRACKER_CONFIG_TTL_MS) return true;
  if (!force && Date.now() < j7TrackerRetryAt) return false;
  const generation = j7TrackerSessionGeneration;
  if (j7TrackerConfigPromise && j7TrackerConfigPromiseGeneration === generation) return j7TrackerConfigPromise;
  const work = (async () => {
    const session = await readJ7TrackerSession();
    if (!session) {
      await setJ7TrackerDisconnected('login-required');
      j7TrackerHistoryError = 'not-connected';
      return false;
    }
    try {
      const [fomo, pump] = await Promise.all([
        fetchJ7TrackerJson(`${J7TRACKER_API_ORIGIN}/api/fomo/list`, session),
        fetchJ7TrackerJson(`${J7TRACKER_API_ORIGIN}/api/pump/list`, session),
      ]);
      const current = await readJ7TrackerSession();
      if (generation !== j7TrackerSessionGeneration || current?.token !== session.token) return false;
      const fomoTrackedCount = j7TrackerListCount(fomo, 'fomo_users');
      const pumpTrackedCount = j7TrackerListCount(pump, 'pump_users');
      if (!Number.isInteger(fomoTrackedCount) || !Number.isInteger(pumpTrackedCount)) {
        throw new Error('J7Tracker config response is invalid');
      }
      j7TrackerFomoTrackedCount = fomoTrackedCount;
      j7TrackerPumpTrackedCount = pumpTrackedCount;
      const at = Date.now();
      await chrome.storage.local.set({
        j7TrackerSyncStateV1: {
          connected: true,
          accountId: session.accountId,
          displayName: session.displayName,
          fomoTrackedCount,
          pumpTrackedCount,
          verifiedAt: at,
        },
        j7TrackerFomoConfigV1: { connected: true, trackedCount: fomoTrackedCount, at },
        j7TrackerPumpConfigV1: { connected: true, trackedCount: pumpTrackedCount, at },
      });
      j7TrackerConfigAt = at;
      ensureJ7TrackerLiveSocket(session, generation);
      return true;
    } catch (error) {
      const current = await readJ7TrackerSession();
      if (generation !== j7TrackerSessionGeneration || current?.token !== session.token) return false;
      if (error?.status === 401 || error?.status === 403) {
        await chrome.storage.local.set({ j7TrackerSessionV1: null });
        await setJ7TrackerDisconnected('session-expired');
        j7TrackerHistoryError = 'not-connected';
      } else {
        j7TrackerHistoryError = 'network';
        j7TrackerRetryAt = Date.now() + J7TRACKER_RETRY_MS;
        await chrome.storage.local.set({
          j7TrackerSyncStateV1: { connected: false, reason: 'network', checkedAt: Date.now() },
        });
      }
      return false;
    }
  })();
  j7TrackerConfigPromise = work;
  j7TrackerConfigPromiseGeneration = generation;
  try {
    return await work;
  } finally {
    if (j7TrackerConfigPromise === work) {
      j7TrackerConfigPromise = null;
      j7TrackerConfigPromiseGeneration = -1;
    }
  }
}

function j7TrackerSocialHistory(session) {
  return new Promise((resolve, reject) => {
    if (typeof io !== 'function') {
      reject(new Error('J7Tracker Socket.IO client is unavailable'));
      return;
    }
    let settled = false;
    let socket = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.disconnect(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('J7Tracker history timed out')), 12000);
    try {
      socket = io(J7TRACKER_SOCKET_ORIGIN, {
        path: J7TRACKER_SOCKET_PATH,
        transports: ['websocket'],
        upgrade: false,
        reconnection: false,
        timeout: 8000,
        auth: { token: session.token },
      });
      socket.on('connect', () => {
        socket.emit('social_history', { limit: J7TRACKER_HISTORY_LIMIT }, (response) => {
          if (response?.error) {
            const error = new Error(String(response.error));
            error.status = /invalid token|unauthor/i.test(error.message) ? 401 : 0;
            finish(error);
            return;
          }
          if (!Array.isArray(response?.events)) {
            finish(new Error('J7Tracker history response is invalid'));
            return;
          }
          finish(null, response.events);
        });
      });
      socket.on('connect_error', (cause) => {
        const error = new Error(String(cause?.message || 'J7Tracker connection failed'));
        error.status = /invalid token|unauthor/i.test(error.message) ? 401 : 0;
        finish(error);
      });
      socket.on('error', (cause) => finish(new Error(String(cause?.message || cause || 'J7Tracker socket failed'))));
    } catch (error) {
      finish(error);
    }
  });
}

function j7TrackerHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' ? parsed.href.slice(0, 1000) : '';
  } catch {
    return '';
  }
}

function j7TrackerChain(data, token) {
  const raw = String(
    token?.network || token?.chain || token?.chainName || data?.network || data?.chain || data?.chainName || '',
  ).toLowerCase();
  const networkId = Number(token?.networkId ?? data?.networkId ?? NaN);
  if (raw.includes('sol') || networkId === 1399811149) return 'sol';
  if (raw.includes('base') || networkId === 8453) return 'base';
  if (raw.includes('bsc') || raw.includes('bnb') || networkId === 56) return 'bsc';
  if (raw.includes('robin') || networkId === 4663) return 'robinhood';
  if (raw.includes('mono') || networkId === 143) return 'monad';
  if (raw.includes('eth') || networkId === 1) return 'eth';
  return raw.replace(/[^a-z0-9_-]/g, '').slice(0, 30);
}

function j7TrackerTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function slimJ7TrackerFomoEvent(record) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : record;
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const kind = String(payload?.kind || data?.kind || '').toLowerCase();
  if (!['trade', 'thesis'].includes(kind)) return null;
  const token = data?.token && typeof data.token === 'object' ? data.token : {};
  const id = String(data?.id || data?.tradeId || data?.thesisId || record?.id || '').trim().slice(0, 180);
  const ts = j7TrackerTimestamp(data?.timestamp || data?.createdAt || payload?.received_at || record?.received_at);
  if (!id || !Number.isFinite(ts) || ts <= 0) return null;
  const side = String(data?.side || data?.type || '').toLowerCase();
  const type = kind === 'thesis' ? 'thesis' : (side === 'sell' ? 'sell' : 'buy');
  const handle = String(data?.userHandle || data?.username || data?.displayName || '').replace(/^@/, '').trim().slice(0, 120);
  return {
    key: `j7:fomo:${id}`,
    id,
    source: 'j7-fomo',
    type,
    ts,
    chain: j7TrackerChain(data, token),
    addr: String(token?.address || token?.contractAddress || data?.tokenAddress || data?.address || '').trim().slice(0, 160),
    symbol: String(token?.symbol || data?.symbol || '').trim().slice(0, 40),
    name: String(data?.displayName || handle || 'J7 FOMO').trim().slice(0, 120),
    tokenName: String(token?.name || data?.tokenName || '').trim().slice(0, 120),
    avatar: j7TrackerHttpsUrl(data?.userImageUrl || data?.avatarUrl),
    img: j7TrackerHttpsUrl(token?.tokenImageUrl || token?.imageUrl || data?.tokenImageUrl),
    usd: Math.max(0, Number(data?.usdAmount || data?.amountUsd || 0) || 0),
    mc: Math.max(0, Number(token?.marketCapUsd || data?.marketCapUsd || 0) || 0),
    handle,
    displayName: String(data?.displayName || handle || 'J7 FOMO').trim().slice(0, 120),
    profileUrl: handle ? `https://fomo.family/profile/${encodeURIComponent(handle)}` : '',
    tx: String(data?.txHash || data?.transactionHash || '').trim().slice(0, 180),
    comment: String(data?.thesis || data?.text || '').trim().slice(0, 500),
  };
}

function slimJ7TrackerPumpEvent(record) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : record;
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const kind = String(payload?.kind || data?.kind || '').toLowerCase();
  if (!['callout', 'reply'].includes(kind)) return null;
  const token = data?.token && typeof data.token === 'object' ? data.token : {};
  const author = data?.author && typeof data.author === 'object' ? data.author : {};
  const id = String(data?.id || data?.calloutId || data?.replyId || record?.id || '').trim().slice(0, 180);
  const ts = j7TrackerTimestamp(data?.timestamp || data?.createdAt || payload?.received_at || record?.received_at);
  if (!id || !Number.isFinite(ts) || ts <= 0) return null;
  const wallet = String(author?.wallet || data?.wallet || '').trim().slice(0, 160);
  const handle = String(author?.username || data?.username || wallet).replace(/^@/, '').trim().slice(0, 120);
  return {
    key: `j7:pump:${id}`,
    id,
    source: 'j7-pump',
    type: kind,
    ts,
    chain: j7TrackerChain(data, token),
    addr: String(token?.address || token?.contractAddress || data?.tokenAddress || data?.address || '').trim().slice(0, 160),
    symbol: String(token?.symbol || data?.symbol || '').trim().slice(0, 40),
    name: String(author?.displayName || author?.username || data?.displayName || handle || 'J7 Pump').trim().slice(0, 120),
    tokenName: String(token?.name || data?.tokenName || '').trim().slice(0, 120),
    avatar: j7TrackerHttpsUrl(author?.profileImage || author?.avatarUrl || author?.avatar || data?.avatarUrl),
    img: j7TrackerHttpsUrl(token?.tokenImageUrl || token?.imageUrl || data?.tokenImageUrl),
    usd: 0,
    mc: Math.max(0, Number(token?.marketCapUsd || data?.marketCapUsd || data?.calledOutAtMcap || 0) || 0),
    handle,
    displayName: String(author?.displayName || author?.username || data?.displayName || handle || 'J7 Pump').trim().slice(0, 120),
    pumpWallet: wallet,
    profileUrl: j7TrackerHttpsUrl(author?.profileUrl) || (wallet ? `https://pump.fun/profile/${encodeURIComponent(wallet)}` : ''),
    tx: '',
    comment: String(data?.text || data?.comment || '').trim().slice(0, 500),
  };
}

function normalizeJ7TrackerHistory(records) {
  const fomo = [];
  const pump = [];
  for (const record of Array.isArray(records) ? records : []) {
    const channel = String(record?.channel || '').toLowerCase();
    const event = channel === 'fomo_event'
      ? slimJ7TrackerFomoEvent(record)
      : (channel === 'pump_event' ? slimJ7TrackerPumpEvent(record) : null);
    if (!event) continue;
    (event.source === 'j7-fomo' ? fomo : pump).push(event);
  }
  const finalize = (events) => Array.from(new Map(events.map((event) => [event.key, event])).values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, J7TRACKER_HISTORY_LIMIT);
  return { fomo: finalize(fomo), pump: finalize(pump) };
}

async function acceptJ7TrackerLiveEvent(channel, payload, generation, token) {
  const current = await readJ7TrackerSession();
  if (generation !== j7TrackerSessionGeneration || current?.token !== token) return false;
  const record = { channel, payload };
  const event = channel === 'fomo_event' ? slimJ7TrackerFomoEvent(record) : slimJ7TrackerPumpEvent(record);
  if (!event) return false;
  const cache = event.source === 'j7-fomo' ? j7TrackerFomoCache : j7TrackerPumpCache;
  const merged = [event, ...cache.filter((item) => item.key !== event.key)]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, J7TRACKER_HISTORY_LIMIT);
  if (event.source === 'j7-fomo') {
    j7TrackerFomoCache = merged;
    notifyTrackerTabs('gdh-fomo-push');
  } else {
    j7TrackerPumpCache = merged;
    notifyTrackerTabs('gdh-pump-push');
  }
  return true;
}

function ensureJ7TrackerLiveSocket(session, generation) {
  if (typeof io !== 'function' || !session?.token) return;
  if (j7TrackerLiveSocket && j7TrackerLiveToken === session.token && j7TrackerLiveGeneration === generation) return;
  try { j7TrackerLiveSocket?.disconnect(); } catch {}
  const socket = io(J7TRACKER_SOCKET_ORIGIN, {
    path: J7TRACKER_SOCKET_PATH,
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    timeout: 8000,
    auth: { token: session.token },
  });
  j7TrackerLiveSocket = socket;
  j7TrackerLiveToken = session.token;
  j7TrackerLiveGeneration = generation;
  socket.on('fomo_event', (payload) => { void acceptJ7TrackerLiveEvent('fomo_event', payload, generation, session.token); });
  socket.on('pump_event', (payload) => { void acceptJ7TrackerLiveEvent('pump_event', payload, generation, session.token); });
  socket.on('connect_error', async (cause) => {
    if (!/invalid token|unauthor/i.test(String(cause?.message || ''))) return;
    const current = await readJ7TrackerSession();
    if (generation !== j7TrackerSessionGeneration || current?.token !== session.token) return;
    await chrome.storage.local.set({ j7TrackerSessionV1: null });
    await setJ7TrackerDisconnected('session-expired');
    j7TrackerHistoryError = 'not-connected';
  });
}

async function refreshJ7TrackerHistory(force = false) {
  if (!force && Date.now() - j7TrackerHistoryAt < J7TRACKER_HISTORY_TTL_MS) return true;
  if (!force && Date.now() < j7TrackerRetryAt) return false;
  const generation = j7TrackerSessionGeneration;
  if (j7TrackerHistoryPromise && j7TrackerHistoryPromiseGeneration === generation) return j7TrackerHistoryPromise;
  const work = (async () => {
    const session = await readJ7TrackerSession();
    if (!session) {
      await setJ7TrackerDisconnected('login-required');
      j7TrackerHistoryError = 'not-connected';
      return false;
    }
    try {
      const records = await j7TrackerSocialHistory(session);
      const current = await readJ7TrackerSession();
      if (generation !== j7TrackerSessionGeneration || current?.token !== session.token) return false;
      const normalized = normalizeJ7TrackerHistory(records);
      const oldFomo = new Set(j7TrackerFomoCache.map((event) => event.key));
      const oldPump = new Set(j7TrackerPumpCache.map((event) => event.key));
      const fomoChanged = normalized.fomo.some((event) => !oldFomo.has(event.key));
      const pumpChanged = normalized.pump.some((event) => !oldPump.has(event.key));
      j7TrackerFomoCache = normalized.fomo;
      j7TrackerPumpCache = normalized.pump;
      j7TrackerHistoryAt = Date.now();
      j7TrackerHistoryError = '';
      j7TrackerRetryAt = 0;
      await chrome.storage.local.set({
        j7TrackerSyncStateV1: {
          connected: true,
          accountId: session.accountId,
          displayName: session.displayName,
          fomoTrackedCount: j7TrackerFomoTrackedCount,
          pumpTrackedCount: j7TrackerPumpTrackedCount,
          verifiedAt: j7TrackerHistoryAt,
        },
      });
      if (fomoChanged) notifyTrackerTabs('gdh-fomo-push');
      if (pumpChanged) notifyTrackerTabs('gdh-pump-push');
      return true;
    } catch (error) {
      const current = await readJ7TrackerSession();
      if (generation !== j7TrackerSessionGeneration || current?.token !== session.token) return false;
      if (error?.status === 401 || error?.status === 403) {
        await chrome.storage.local.set({ j7TrackerSessionV1: null });
        await setJ7TrackerDisconnected('session-expired');
        j7TrackerHistoryError = 'not-connected';
      } else {
        j7TrackerHistoryError = 'network';
        j7TrackerRetryAt = Date.now() + J7TRACKER_RETRY_MS;
        await chrome.storage.local.set({
          j7TrackerSyncStateV1: { connected: false, reason: 'network', checkedAt: Date.now() },
        });
      }
      return false;
    }
  })();
  j7TrackerHistoryPromise = work;
  j7TrackerHistoryPromiseGeneration = generation;
  try {
    return await work;
  } finally {
    if (j7TrackerHistoryPromise === work) {
      j7TrackerHistoryPromise = null;
      j7TrackerHistoryPromiseGeneration = -1;
    }
  }
}

async function fetchJ7TrackerFomoFeed() {
  const configured = await refreshJ7TrackerState(false);
  if (!configured) {
    const reason = j7TrackerHistoryError || 'not-connected';
    const events = reason === 'network' ? j7TrackerFomoCache.map((event) => ({ ...event, stale: true })) : [];
    return { ok: false, reason, events, stale: events.length > 0, source: 'j7tracker', fetchedAt: j7TrackerHistoryAt || 0 };
  }
  const refreshed = await refreshJ7TrackerHistory(false);
  if (!refreshed) {
    const reason = j7TrackerHistoryError || 'network';
    const events = reason === 'network' ? j7TrackerFomoCache.map((event) => ({ ...event, stale: true })) : [];
    return { ok: false, reason, events, stale: events.length > 0, source: 'j7tracker', fetchedAt: j7TrackerHistoryAt || 0 };
  }
  return {
    ok: true, events: j7TrackerFomoCache.slice(), source: 'j7tracker',
    fetchedAt: j7TrackerHistoryAt || Date.now(), stale: false,
  };
}

async function fetchJ7TrackerPumpFeed() {
  const configured = await refreshJ7TrackerState(false);
  if (!configured) {
    const reason = j7TrackerHistoryError || 'not-connected';
    const events = reason === 'network' ? j7TrackerPumpCache.map((event) => ({ ...event, stale: true })) : [];
    return { ok: false, reason, events, stale: events.length > 0, source: 'j7tracker', fetchedAt: j7TrackerHistoryAt || 0 };
  }
  const refreshed = await refreshJ7TrackerHistory(false);
  if (!refreshed) {
    const reason = j7TrackerHistoryError || 'network';
    const events = reason === 'network' ? j7TrackerPumpCache.map((event) => ({ ...event, stale: true })) : [];
    return { ok: false, reason, events, stale: events.length > 0, source: 'j7tracker', fetchedAt: j7TrackerHistoryAt || 0 };
  }
  return {
    ok: true, events: j7TrackerPumpCache.slice(), source: 'j7tracker',
    fetchedAt: j7TrackerHistoryAt || Date.now(), stale: false,
  };
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

function resetFomoAccountCaches() {
  fomoAuthGeneration += 1;
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
  if (changes.fomoToken) {
    const previousAccount = fomoAccountIdentity(changes.fomoToken.oldValue);
    const nextAccount = fomoAccountIdentity(changes.fomoToken.newValue);
    if (previousAccount !== nextAccount) resetFomoAccountCaches();
  }
  if (changes.j7TrackerSessionV1) resetJ7TrackerCaches();
});

function isJ7TrackerSender(sender) {
  try {
    const hostname = new URL(String(sender?.url || sender?.tab?.url || '')).hostname;
    return hostname === 'j7tracker.io';
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'j7tracker-session-updated') {
    if (!isJ7TrackerSender(sender)) {
      sendResponse({ ok: false });
      return false;
    }
    resetJ7TrackerCaches();
    refreshJ7TrackerState(true)
      .then((ok) => sendResponse({ ok: Boolean(ok) }))
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
    fetchJ7TrackerFomoFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
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

  if (message?.type === 'pump-feed') {
    fetchJ7TrackerPumpFeed()
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
