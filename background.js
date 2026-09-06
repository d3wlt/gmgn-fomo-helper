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
  if (areaName !== 'local') return;
  if (changes.fomoToken) {
    const oldIdentity = fomoAccountIdentity(changes.fomoToken.oldValue);
    const newIdentity = fomoAccountIdentity(changes.fomoToken.newValue);
    const sameAccount = oldIdentity && newIdentity && oldIdentity === newIdentity;
    if (!sameAccount) {
      fomoAuthGeneration += 1;
      fomoFollowedFeedCache = { ...emptyFomoFollowedFeed(), gapReason: 'account-baseline' };
      fomoFollowedFeedCheckpoint = null;
      fomoFollowingIdsCache = { ids: new Set(), fetchedAt: 0 };
      fomoApiRetryAt = 0;
      fomoApiFailures = 0;
      fomoFollowedHoldersCache.clear();
      fomoTradeDetailCache.clear();
      fomoTokenTradeFallbackCache.clear();
      fomoCache.clear();
    }
  }
  if (!changes.monitor985SessionV1) return;
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
