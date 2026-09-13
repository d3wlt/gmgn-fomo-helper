(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://fomo.family') return;
  const SOURCE = 'gdh-fomo-passive-v1';
  const bridgeId = crypto.randomUUID();
  // This channel contains public native response fields only, never request
  // headers, session tokens or the site's complete response objects.
  const fields = new Set(('id key swapId commentId type userId authorId createdAt timestamp ts networkId chainId chain chainSlug tokenAddress userHandle handle displayName userName profilePictureLink avatar usdAmount usdValue fdv marketCap ticker symbol tokenName tokenImageUrl tokenImage tradeId txHash transactionHash position positionAction action text thesis networkName chainName address name imageUrl image closedAt percentageRealizedPnl percentageUnrealizedPnl comment body user token authorTrade tradeComment').split(' '));
  function slim(raw, depth = 0) {
    if (typeof raw === 'string') return raw.slice(0, 1500);
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw === 'boolean' || raw === null) return raw;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 2) return undefined;
    const out = {};
    for (const key of Object.keys(raw).slice(0, 100)) if (fields.has(key)) {
      const value = slim(raw[key], depth + 1);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  let lastSeq = 0;
  let queued = 0;
  let chain = Promise.resolve();
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const raw = event.data;
    if (!raw || raw.source !== SOURCE || !['account','following','activity','connection','logout','trending'].includes(raw.kind)
      || !Number.isSafeInteger(raw.seq) || raw.seq <= lastSeq || !Number.isSafeInteger(raw.epoch) || raw.epoch < 0 || queued >= 32) return;
    const accountId = typeof raw.accountId === 'string' && /^[a-zA-Z0-9:_-]{1,100}$/.test(raw.accountId) ? raw.accountId : '';
    const data = { source:SOURCE, kind:raw.kind, bridgeId, epoch:raw.epoch, seq:raw.seq, accountId,
      observedAt:Number.isFinite(raw.observedAt) ? raw.observedAt : Date.now() };
    if (raw.kind === 'activity') {
      if (!Array.isArray(raw.items) || raw.items.length > 100) return;
      data.items = raw.items.map(item => slim(item)).filter(item => item && typeof item === 'object');
      if (JSON.stringify(data.items).length > 250000) return;
    }
    if (raw.kind === 'trending') {
      data.available = raw.available === true;
      data.nativeSnapshot = raw.nativeSnapshot === true;
      data.viewMode = raw.viewMode === 'native-view' ? 'native-view' : 'stream';
      const keys = ['chain','networkId','address','symbol','name','price','marketCap','change24Percent','rank','priceSource'];
      if (!Array.isArray(raw.items) || raw.items.length > 100 || JSON.stringify(raw.items).length > 100000) {
        data.available = false; data.items = [];
      } else data.items = raw.items.map(row => Object.fromEntries(keys.map(key => [key,
        typeof row?.[key] === 'string' ? row[key].slice(0,120) : typeof row?.[key] === 'number' && Number.isFinite(row[key]) ? row[key] : null])));
    }
    if (raw.kind === 'following') {
      if (!Array.isArray(raw.followingIds) || raw.followingIds.length > 10000 || raw.followingIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(id))) return;
      data.followingIds = [...new Set(raw.followingIds)];
    }
    if (raw.kind === 'connection') data.connected = raw.connected === true;
    lastSeq = raw.seq; queued++;
    chain = chain.catch(() => {}).then(() => chrome.runtime.sendMessage({type:'fomo-passive-event', data})).catch(() => {}).finally(() => { queued--; });
  });
  // Local handshake only: lets MAIN replay its already-observed account/roster
  // if the document-start isolated listener attached after native instrumentation.
  window.postMessage({source:'gdh-fomo-passive-ready-v1'}, location.origin);
})();
