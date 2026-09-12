import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const background = read('background.js');
const content = read('content.js');
const bridge = read('page-bridge.js');
const manifest = JSON.parse(read('manifest.json'));
const releaseBuild = read('scripts/build-release.ps1');
const releaseWorkflow = read('.github/workflows/release.yml');
const releaseNote = read(`release-notes/v${manifest.version}.md`);
const readme = read('README.md');
const popup = read('popup.js');
const popupHtml = read('popup.html');
const styles = read('styles.css');
const site = read('site/index.html');
const privacy = read('PRIVACY.md');

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.ok(functionStart >= 0, `missing function ${name}`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function evaluate(functions, expression, extras = {}) {
  const context = vm.createContext({ ...extras });
  return vm.runInContext(`${functions.join('\n')}\n(${expression})`, context);
}

// Stateful backend regressions run the complete production worker. Only the
// browser/network boundaries are fixtures, so new helpers, caches, and backoff
// state cannot silently disappear from an extracted-function VM.
function backgroundHarness(route) {
  const calls = [];
  const ignore = { addListener() {} };
  const context = vm.createContext({
    console, Date, URL, URLSearchParams, atob, btoa, AbortController, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    importScripts() {},
    fetch: async (url, options) => {
      const requestPath = new URL(url).pathname + new URL(url).search;
      calls.push(requestPath);
      return route(requestPath, options);
    },
    chrome: {
      runtime: { onInstalled: ignore, onStartup: ignore, onMessage: ignore },
      alarms: { get: async () => ({}), create() {}, onAlarm: ignore },
      storage: { local: { remove: async () => {}, get: async () => ({}), set: async () => {} }, onChanged: ignore },
    },
  });
  vm.runInContext(background, context, { filename: 'background.js' });
  return { calls, run: (code) => vm.runInContext(code, context) };
}

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
};

await test('Partial-sale cost uses cumulative purchase quantity and fees', () => {
  const fn = extractFunction(bridge, 'readHoldingCost');
  const result = evaluate([fn], 'readHoldingCost({ balance: 40, accu_amount: 100, accu_cost: 100, accu_fee: 2 })');
  assert.equal(result, 1.02);
});

await test('Closed positions do not reuse historical average cost', () => {
  const fn = extractFunction(bridge, 'readHoldingCost');
  const result = evaluate([fn], 'readHoldingCost({ balance: 0, history_avg_cost: 9 })');
  assert.equal(result, 0);
});

await test('API cost aggregation matches the page bridge', () => {
  const fn = extractFunction(content, 'holdingCostFromApi');
  const result = evaluate([fn], 'holdingCostFromApi({ balance: 40, accu_amount: 100, accu_cost: 100, accu_fee: 2 })');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { balance: 40, average: 1.02 });
});

await test('Position surge checks cost return and five-minute change', () => {
  const costFn = extractFunction(content, 'holdingCostChange');
  const fiveMinuteFn = extractFunction(content, 'holdingFiveMinuteChange');
  assert.ok(Math.abs(evaluate([costFn], "holdingCostChange('1.2', '1')") - 20) < 1e-9);
  assert.equal(evaluate([costFn], "holdingCostChange('2', '4')"), -50);
  assert.equal(Number.isNaN(evaluate([costFn], "holdingCostChange('2', '0')")), true);
  assert.ok(Math.abs(evaluate([fiveMinuteFn], "holdingFiveMinuteChange({ price5m: 1 }, 1.05)") - 5) < 1e-9);
  assert.equal(evaluate([fiveMinuteFn], "holdingFiveMinuteChange({ pct5m: -2 }, 1.05)"), -2);
  assert.equal(Number.isNaN(evaluate([fiveMinuteFn], "holdingFiveMinuteChange({}, 1.05)")), true);
  const handler = extractFunction(content, 'handleHoldingPriceUpdate');
  assert.ok(handler.includes('holdingCostChange(price, meta?.cost)'));
  assert.ok(handler.includes('holdingFiveMinuteChange(update, price)'));
  assert.ok(handler.includes('pct5m > 0'));
  assert.ok(content.includes('price5m: Number(p.price_5m)'));
});

await test('Material cost changes reset the alert baseline', () => {
  const fn = extractFunction(content, 'holdingCostMateriallyChanged');
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(0, 1)'), true);
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(1, 1.0005)'), false);
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(1, 1.002)'), true);
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(1, 0)'), false);
  const put = extractFunction(content, 'putHolding');
  assert.ok(put.includes('holdingAlertedAt.delete(key)'));
  assert.ok(put.includes('holdingAlertLevel.delete(key)'));
  const rebuild = extractFunction(content, 'rebuildHoldingWatch');
  assert.ok(rebuild.includes('holdingCostMateriallyChanged(old.cost, item.cost)'));
  assert.ok(rebuild.includes('if (next.has(key)) continue'));
});

await test('Position surge is quiet initially and can alert again after a pullback', () => {
  const fn = extractFunction(content, 'holdingSurgeDecision');
  const call = (previous, pct, ready = true, rising = true) => evaluate([fn], `holdingSurgeDecision(${previous}, ${pct}, 20, ${ready}, ${rising})`);
  assert.deepEqual(JSON.parse(JSON.stringify(call('null', 25))), { nextLevel: 1, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('null', 25, true, false))), { nextLevel: 0, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('0', 21))), { nextLevel: 1, alert: true });
  assert.deepEqual(JSON.parse(JSON.stringify(call('0', 21, true, false))), { nextLevel: 0, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('1', 45, false))), { nextLevel: 1, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('1', 45, true, false))), { nextLevel: 1, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('1', 5))), { nextLevel: 0, alert: false });
});

await test('Position surge requires a confirmed positive balance', async () => {
  const confirm = extractFunction(content, 'confirmHoldingStillOwned');
  const run = (apiResult, stillCached = true) => evaluate(
    [confirm],
    "confirmHoldingStillOwned('bsc', 'bsc:0xabc')",
    {
      holdingAlertConfirming: new Set(),
      syncHoldingWatchFromApi: async () => apiResult,
      holdingWatchMap: new Map(stillCached ? [['bsc:0xabc', { cost: 1 }]] : []),
    },
  );
  assert.equal(await run({ ok: true, present: true }), true);
  assert.equal(await run({ ok: true, present: false }), false);
  assert.equal(await run({ ok: false, present: false }), false);
  assert.equal(await run({ ok: true, present: true }, false), false);

  const handler = extractFunction(content, 'handleHoldingPriceUpdate');
  assert.ok(handler.startsWith('async function'));
  assert.ok(handler.includes('await confirmHoldingStillOwned(chain, key)'));
  assert.ok(handler.indexOf('await confirmHoldingStillOwned') < handler.indexOf('showRemindCard'));
  const sync = extractFunction(content, 'syncHoldingWatchFromApi');
  assert.ok(sync.includes('if (!(balance > 0)) continue'));
  assert.ok(sync.includes('present: expectedKey ? result.seen?.has(expectedKey) === true : null'));
  const start = extractFunction(content, 'startHoldingPoll');
  assert.ok(start.includes('await syncHoldingWatchFromApi()'));
});

await test('FOMO popup keeps sell activity and labels position changes', () => {
  const functions = [
    extractFunction(content, 'fomoActivitySide'),
    extractFunction(content, 'fomoUiPosition'),
    extractFunction(content, 'normalizeFomoPopupTrade'),
  ];
  // Position labels now require explicit evidence, not an inferred ordinary sell.
  const samples = evaluate(functions, `[
    normalizeFomoPopupTrade({ id: 'buy-1', type: 'swap_buy', positionAction: 'First', createdAt: '2026-09-03T12:00:00Z', usdAmount: 125, authorTrade: { openedAt: '2026-09-03T12:00:00Z' } }),
    normalizeFomoPopupTrade({ id: 'sell-1', type: 'swap_sell', positionAction: 'Partial', createdAt: '2026-09-03T12:01:00Z', usdAmount: 50, authorTrade: { openedAt: '2026-09-03T11:00:00Z' } }),
    normalizeFomoPopupTrade({ id: 'sell-2', type: 'swap_sell', positionAction: 'All', createdAt: '2026-09-03T12:02:00Z', usdAmount: 75, authorTrade: { closedAt: '2026-09-03T12:02:00Z' } }),
    normalizeFomoPopupTrade({ id: 'sell-3', isBuy: false, positionAction: 'Partial' }),
    normalizeFomoPopupTrade({ id: 'sell-unknown', type: 'swap_sell' }),
  ]`);
  assert.deepEqual(JSON.parse(JSON.stringify(samples.map((item) => ({ side: item.side, position: item.position })))), [
    { side: 'buy', position: 'First' },
    { side: 'sell', position: 'Partial' },
    { side: 'sell', position: 'All' },
    { side: 'sell', position: 'Partial' },
    { side: 'sell', position: '' },
  ]);
  const render = extractFunction(content, 'renderFomoItems');
  assert.ok(render.includes('normalizeFomoPopupTrade(item)'));
  assert.ok(render.includes("kind === 'swaps'"));
  assert.ok(render.includes("gdh-fomo__side--${trade.side}"));
  assert.ok(styles.includes('.gdh-fomo__side--sell'));
  assert.ok(styles.includes('.gdh-fomo__position'));
});

await test('Followed FOMO trades and theses are normalized for the GMGN tracker', () => {
  const functions = [
    extractFunction(background, 'fomoActivitySide'),
    extractFunction(background, 'fomoActivityPosition'),
    extractFunction(background, 'fomoNetworkSlug'),
    extractFunction(background, 'fomoHttpsUrl'),
    extractFunction(background, 'fomoMetadataText'),
    extractFunction(background, 'fomoMetadataNumber'),
    extractFunction(background, 'slimFomoFollowedEvent'),
  ];
  const events = evaluate(functions, `[
    slimFomoFollowedEvent({
      id: 'trade-buy', type: 'swap_buy', user: { id: 'u1', userHandle: '@alice_user', displayName: 'Alice Nick' },
      createdAt: '2026-09-03T12:00:00Z', tokenAddress: 'So11111111111111111111111111111111111111112',
      networkId: 1399811149, usdAmount: 220, ticker: 'SOL', marketCap: 1000000,
      authorTrade: { openedAt: '2026-09-03T12:00:00Z' }
    }, new Set(['u1'])),
    slimFomoFollowedEvent({
      id: 'trade-sell', type: 'swap_sell', userId: 'u1', userHandle: 'Alice',
      createdAt: '2026-09-03T12:05:00Z', tokenAddress: '0x1234567890123456789012345678901234567890',
      networkId: 56, usdAmount: -90, ticker: 'ABC', authorTrade: { closedAt: '2026-09-03T12:05:00Z' }
    }, new Set(['u1'])),
    slimFomoFollowedEvent({
      id: 'thesis-1', type: 'thesis', userId: 'u1', userHandle: 'Alice',
      createdAt: '2026-09-03T12:06:00Z', tokenAddress: '0x1234567890123456789012345678901234567890',
      networkId: 56, comment: 'My thesis', ticker: 'ABC', authorTrade: { usdValue: 150 }
    }, new Set(['u1'])),
    slimFomoFollowedEvent({ id: 'not-followed', type: 'swap_buy', userId: 'u2', createdAt: '2026-09-03T12:07:00Z' }, new Set(['u1']))
  ]`, { FOMO_NETWORK_SLUG: { 56: 'bsc', 1399811149: 'sol' } });
  assert.deepEqual(JSON.parse(JSON.stringify(events.map((item) => item && ({
    source: item.source, type: item.type, position: item.position, followed: item.followed, usd: item.usd, name: item.name,
  })))), [
    { source: 'fomo-followed', type: 'buy', position: 'First', followed: true, usd: 220, name: 'alice_user' },
    { source: 'fomo-followed', type: 'sell', position: 'All', followed: true, usd: 90, name: 'Alice' },
    { source: 'fomo-followed', type: 'thesis', position: 'Thesis', followed: true, usd: 150, name: 'Alice' },
    null,
  ]);
  assert.ok(background.includes("'/v2/users/current/followingIds'"));
  const collector = extractFunction(background, 'fetchFomoFollowedFeed');
  assert.ok(collector.includes('passiveFomoSnapshot'), 'Following reads the passive cache');
  assert.ok(!/fomoAuthedFetch|fetch\(|fomoKeepAlive|ensureFreshFomoToken/.test(collector), 'no independent network or auth path');
  assert.ok(background.includes("message?.type === 'fomo-passive-event'"));
  assert.ok(background.includes("message?.type === 'fomo-followed-feed'"));
  assert.ok(content.includes("chrome.runtime.sendMessage({ type: 'fomo-followed-feed' }"));
  assert.ok(content.includes("source: 'fomo-followed'"));
  assert.ok(content.includes("followed: { label: 'Following'"));
  assert.ok(styles.includes('.gdh-fomofeed.is-followed'));
  assert.ok(styles.includes('.gdh-fomofeed__position'));
});

await test('Passive Following reads make no FOMO requests or expose legacy cached data', async () => {
  const worker = backgroundHarness(() => { throw new Error('Passive feed cannot request FOMO'); });
  worker.run("fomoFollowedFeedCache = { ...emptyFomoFollowedFeed(), events: [{ key: 'old-account-event' }], updatedAt: 1 }");
  const response = await worker.run('fetchFomoFollowedFeed()');
  assert.equal(response.mode, 'passive');
  assert.equal(response.passiveStatus, 'waiting-for-fomo-tab');
  assert.equal(response.coverageGap, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.events)), []);
  assert.deepEqual(worker.calls, []);
});

await test('Notification history is sanitized, deduplicated, and capped', () => {
  const functions = [
    extractFunction(background, 'cleanNotificationText'),
    extractFunction(background, 'normalizeNotificationHistoryItem'),
    extractFunction(background, 'notificationHistoryFingerprint'),
    extractFunction(background, 'mergeNotificationHistory'),
  ];
  const sanitized = evaluate(functions, `normalizeNotificationHistoryItem({
    id: 'safe-id', at: 1000, tag: 'Position surge\\u0000', symbol: 'TEST', label: 'From cost basis',
    value: '+25%', dir: 'sideways', href: 'javascript:alert(1)'
  })`);
  assert.equal(sanitized.tag, 'Position surge');
  assert.equal(sanitized.dir, '');
  assert.equal(sanitized.href, '');

  const merged = evaluate(functions, `mergeNotificationHistory([
    { id: 'old', at: 1000, tag: 'Position surge', symbol: 'TEST', label: 'From cost basis', value: '+25%', dir: 'up', href: '/sol/token/Abc123' }
  ], { id: 'new', at: 2000, tag: 'Position surge', symbol: 'TEST', label: 'From cost basis', value: '+25%', dir: 'up', href: '/sol/token/Abc123' })`, {
    NOTIFICATION_HISTORY_MAX: 100,
  });
  assert.equal(merged.length, 1);

  const capped = evaluate(functions, `mergeNotificationHistory(
    Array.from({ length: 120 }, (_, i) => ({ id: String(i), at: i + 1, tag: 'Alert', symbol: String(i), value: String(i) })),
    { id: 'latest', at: 9999, tag: 'Alert', symbol: 'LATEST', value: '+1%' }
  )`, { NOTIFICATION_HISTORY_MAX: 100 });
  assert.equal(capped.length, 100);
  assert.equal(capped[0].id, 'latest');
  assert.ok(content.includes('recordNotificationHistory(info);'));
  assert.ok(content.includes("className = 'gdh-notification-launcher'"));
});

await test('Position alerts follow per-chain GMGN app settings', () => {
  const functions = [
    extractFunction(content, 'holdingSignalBoolean'),
    extractFunction(content, 'parseGmgnHoldingSignalConfig'),
  ];
  const wrapped = evaluate(functions, `parseGmgnHoldingSignalConfig({ code: 0, data: [
    { push_chain: 'sol', push_switch_dict: { holding_signal: true, hot_token: false } },
    { push_chain: 'bsc', push_switch_dict: { holding_signal: 0 } },
    { push_chain: 'base', push_switch_dict: { holding_signal: '1' } }
  ] })`);
  assert.deepEqual(JSON.parse(JSON.stringify(wrapped)), { sol: true, bsc: false, base: true });
  const direct = evaluate(functions, `parseGmgnHoldingSignalConfig([
    { push_chain: 'sol', push_switch_dict: { holding_signal: 'open' } },
    { push_chain: 'bsc', push_switch_dict: { holding_signal: 'close' } }
  ])`);
  assert.deepEqual(JSON.parse(JSON.stringify(direct)), { sol: true, bsc: false });
  assert.equal(evaluate(functions, "parseGmgnHoldingSignalConfig({ data: [{ chain: 'sol', enabled: true }] })"), null);
});

await test('GMGN app notification config uses the official empty request', () => {
  const sanitize = extractFunction(bridge, 'sanitizeHoldingConfig');
  const bridged = evaluate([sanitize], `sanitizeHoldingConfig({ code: 0, data: [
    { push_chain: 'sol', push_switch_dict: { holding_signal: '1', other: 'secret' } },
    { push_chain: 'eth', push_switch_dict: { holding_signal: '1' } }
  ] })`);
  assert.deepEqual(JSON.parse(JSON.stringify(bridged)), [
    { push_chain: 'sol', push_switch_dict: { holding_signal: '1' } },
  ]);
  assert.match(bridge, /HOLDING_CONFIG_URL[\s\S]*?body:\s*'\{\}'/);
  assert.match(bridge, /localStorage\.getItem\('tgInfo'\)/);
  assert.match(content, /document\.dispatchEvent\(new Event\(GMGN_HOLDING_CONFIG_REQUEST_EVENT\)\)/);
  assert.doesNotMatch(bridge, /body:\s*JSON\.stringify\(\{\s*push_chains:/);
});

await test('The main-world bridge captures token_stat without another socket', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const mainBridge = manifest.content_scripts.find((item) => item.world === 'MAIN');
  assert.equal(mainBridge.run_at, 'document_start');
  assert.ok(bridge.includes("message?.channel !== 'token_stat'"));
  assert.ok(bridge.includes('new Proxy(nativeWebSocket'));
  assert.ok(!bridge.includes("new WebSocket('wss://ws.gmgn.ai"));
});

await test('Position keys preserve Solana case and normalize EVM', () => {
  const functions = [
    "const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/; const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;",
    extractFunction(content, 'normalizeWalletAddress'),
    extractFunction(content, 'holdingKey'),
  ];
  const sol = 'AbCdEfGhijkLMNPQRSTUVWXYZ123456789';
  assert.equal(evaluate(functions, `holdingKey('sol', '${sol}')`), `sol:${sol}`);
  assert.equal(evaluate(functions, `holdingKey('bsc', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD')`), 'bsc:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
});

await test('Authoritative reconciliation replaces only the current chain', () => {
  const functions = [extractFunction(background, 'normalizeHoldingWatchItem'), extractFunction(background, 'mergeHoldingWatchList')];
  const current = [
    { chain: 'bsc', address: '0x1111111111111111111111111111111111111111', cost: 1, at: 1 },
    { chain: 'base', address: '0x2222222222222222222222222222222222222222', cost: 2, at: 2 },
  ];
  const incoming = [{ chain: 'bsc', address: '0x3333333333333333333333333333333333333333', cost: 3, at: 3 }];
  const result = evaluate(functions, `mergeHoldingWatchList(${JSON.stringify(current)}, 'bsc', ${JSON.stringify(incoming)}, true)`, { HOLDING_WATCH_PER_CHAIN_MAX: 100, Date });
  assert.equal(result.length, 2);
  assert.ok(result.some((x) => x.chain === 'base'));
  assert.ok(!result.some((x) => x.address.endsWith('1111')));
});

await test('Virtual-list merging keeps unrendered rows', () => {
  const functions = [extractFunction(background, 'normalizeHoldingWatchItem'), extractFunction(background, 'mergeHoldingWatchList')];
  const current = [{ chain: 'bsc', address: '0x1111111111111111111111111111111111111111', cost: 1, at: 1 }];
  const incoming = [{ chain: 'bsc', address: '0x3333333333333333333333333333333333333333', cost: 3, at: 3 }];
  const result = evaluate(functions, `mergeHoldingWatchList(${JSON.stringify(current)}, 'bsc', ${JSON.stringify(incoming)}, false)`, { HOLDING_WATCH_PER_CHAIN_MAX: 100, Date });
  assert.equal(result.length, 2);
});

await test('Each chain retains up to 100 positions independently', () => {
  const functions = [extractFunction(background, 'normalizeHoldingWatchItem'), extractFunction(background, 'mergeHoldingWatchList')];
  const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
  const current = [
    ...Array.from({ length: 100 }, (_, i) => ({ chain: 'bsc', address: address(i + 1), at: i + 1 })),
    ...Array.from({ length: 100 }, (_, i) => ({ chain: 'base', address: address(i + 1001), at: i + 1 })),
  ];
  const incoming = Array.from({ length: 100 }, (_, i) => ({ chain: 'sol', address: address(i + 2001), at: 1000 + i }));
  const result = evaluate(functions, `mergeHoldingWatchList(${JSON.stringify(current)}, 'sol', ${JSON.stringify(incoming)}, true)`, { HOLDING_WATCH_PER_CHAIN_MAX: 100, Date });
  assert.equal(result.filter((x) => x.chain === 'bsc').length, 100);
  assert.equal(result.filter((x) => x.chain === 'base').length, 100);
  assert.equal(result.filter((x) => x.chain === 'sol').length, 100);
});

await test('Recycled native rows only inherit token-block collapse, never feed height', () => {
  const fn = extractFunction(content, 'refreshFomoFeedFixedRowShifts');
  assert.ok(fn.includes('const amount = collapsed;'));
  assert.ok(fn.includes("if (row.card.dataset.gdhTokenBlocked === '1') collapsed -= row.h;"));
  assert.ok(!fn.includes('offsetHeight'));
  assert.ok(content.includes('scheduleFomoFeedRowReflow();'));
});

await test('Feed offsets preserve GMGN virtual-list transforms', () => {
  const setter = extractFunction(content, 'setFomoFeedRowShift');
  const result = evaluate(
    ['const fomoFeedShifted = new Map();', setter],
    `(() => {
      const row = { style: { transform: 'translateY(258px)', translate: '' } };
      const applied = setFomoFeedRowShift(row, 66);
      const shifted = { applied, transform: row.style.transform, translate: row.style.translate };
      setFomoFeedRowShift(row, 0);
      return { shifted, restoredTransform: row.style.transform, restoredTranslate: row.style.translate };
    })()`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    shifted: { applied: true, transform: 'translateY(258px)', translate: '0px 66px' },
    restoredTransform: 'translateY(258px)',
    restoredTranslate: '',
  });

  const fixedRow = extractFunction(content, 'fomoFeedFixedRow');
  const geometry = evaluate(
    ['const fomoFeedShifted = new Map();', fixedRow],
    `(() => {
      class RowElement extends HTMLElement {}
      const parent = Object.assign(new RowElement(), {
        clientTop: 2,
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 100 }),
      });
      const wrap = Object.assign(new RowElement(), {
        style: { position: 'absolute', top: '0px', transform: 'translateY(192px)', translate: '0px 66px' },
        offsetHeight: 64.5,
        parentElement: parent,
        getBoundingClientRect: () => ({ top: 358 }),
      });
      const card = Object.assign(new RowElement(), { parentElement: wrap });
      fomoFeedShifted.set(wrap, { originalTranslate: '', amount: 66 });
      return fomoFeedFixedRow(card);
    })()`,
    { HTMLElement: class HTMLElement {} },
  );
  assert.deepEqual(JSON.parse(JSON.stringify({ top: geometry.top, h: geometry.h })), { top: 190, h: 64.5 });

  for (const name of ['clearFomoFeedShifts', 'refreshFomoFeedFixedRowShifts']) {
    assert.ok(!extractFunction(content, name).includes('style.transform'), `${name} overwrites native transform`);
  }
});

await test('Merged tracker owns scroll mapping rather than a capped split lane', () => {
  const scan = extractFunction(content, 'scanFomoFeed');
  assert.ok(scan.includes('renderMergedTracker(cards, events)'));
  assert.ok(!scan.includes('HEAD_CAP'));
  assert.ok(!scan.includes('INLINE_CAP'));
  const layout = extractFunction(content, 'renderMergedTracker');
  assert.ok(layout.includes('data-gdh-native-index'));
  assert.ok(layout.includes('stamps[index] !== Number(card.dataset.gdhTrackTs)'));
  assert.ok(extractFunction(content, 'syncMergedTracker').includes('m.viewport.scrollTop ='));
  assert.ok(!styles.includes('max-height: min(220px, 28vh)'));
  assert.match(styles, /\.gdh-merged-tracker\s*\{[^}]*overflow: auto/s);
});

await test('Long-lived caches evict their oldest entries', () => {
  const mapFn = extractFunction(content, 'setBoundedMap');
  const setFn = extractFunction(content, 'rememberBoundedSet');
  const result = evaluate([mapFn, setFn], `(() => {
    const map = new Map();
    setBoundedMap(map, 'a', 1, 2);
    setBoundedMap(map, 'b', 2, 2);
    setBoundedMap(map, 'c', 3, 2);
    const set = new Set();
    rememberBoundedSet(set, 'a', 2);
    rememberBoundedSet(set, 'b', 2);
    rememberBoundedSet(set, 'c', 2);
    return { map: [...map.keys()].join(','), set: [...set].join(',') };
  })()`);
  assert.equal(result.map, 'b,c');
  assert.equal(result.set, 'b,c');
  assert.ok(content.includes('setBoundedMap(fomoTrCache'));
  assert.ok(content.includes('setBoundedMap(fomoPnlCache'));
  assert.ok(content.includes('rememberBoundedSet(fomoFeedSeen'));
  assert.ok(background.includes('setBoundedMap(fomoCache'));
  assert.ok(!background.includes('flapTokenInfo'), 'removed Flap collector cannot issue RPC calls');
  assert.ok(background.includes('setBoundedMap(supplyCache'));
});

await test('Scroll throttling uses one timer', () => {
  const contentRun = extractFunction(content, 'runScheduledScan');
  const bridgeRun = extractFunction(bridge, 'runScheduledScan');
  const run = (fn, gap) => {
    const state = { scans: 0, schedules: 0, wait: 0 };
    return evaluate([fn], `(() => {
    runScheduledScan();
    return { delay: scanDelayTimer, scans: state.scans, schedules: state.schedules, wait: state.wait };
  })()`, {
    scanRafId: 1,
    scanDelayTimer: 0,
    lastScanAt: 100,
    scrollingUntil: 500,
    scanScheduled: true,
    SCAN_MIN_GAP_SCROLLING: gap,
    Date: { now: () => 150 },
    Math,
    state,
    window: { setTimeout: (_fn, ms) => { state.wait = ms; return 7; } },
    scheduleScan: () => { state.schedules += 1; },
    scanCards: () => { state.scans += 1; },
  });
  };
  const contentResult = run(contentRun, 120);
  const bridgeResult = run(bridgeRun, 150);
  assert.equal(`${contentResult.delay}|${contentResult.scans}|${contentResult.schedules}|${contentResult.wait}`, '7|0|0|70');
  assert.equal(`${bridgeResult.delay}|${bridgeResult.scans}|${bridgeResult.schedules}|${bridgeResult.wait}`, '7|0|0|100');
});

await test('Tracking-feed mutation layout is frame-coalesced', () => {
  assert.ok(content.includes('const fomoFeedScrollTargets = new WeakSet();'));
  assert.ok(content.includes('scheduleFomoFeedRowReflow();\n      scheduleScan();'));
  assert.ok(!content.includes('refreshFomoFeedFixedRowShifts();\n      }\n      scheduleScan();'));
  assert.ok(content.includes("if (document.visibilityState === 'hidden') return;"));
  assert.ok(bridge.includes("if (document.visibilityState === 'hidden') return;"));
  assert.match(content, /if \(document\.visibilityState !== 'hidden'\) \{\s*if \(Date.now\(\) - fomoFollowedLastPollAt >= FOMO_FEED_POLL_MS\) pollFomoFollowedFeed\(\);\s*refreshFomoFeedTimes\(\);\s*scanVisibleCards\(\);\s*\}/);
  assert.ok(content.includes("root.querySelectorAll('[data-gdh-fomo-ts]')"));
  assert.ok(content.includes("time.className = 'gdh-fomofeed__tcell gdh-fomofeed__ttime';\n    time.dataset.gdhFomoTs = String(ev.ts);"));
});

await test('FOMO cards inherit the GMGN theme', () => {
  assert.match(styles, /\.gdh-fomofeed\s*\{[\s\S]*?color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed__name\s*\{[\s\S]*?color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed__sym\s*\{[\s\S]*?color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed__symtext\s*\{[^}]*color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed:hover\s*\{\s*background:\s*color-mix\(in srgb, currentColor 4%, transparent\);\s*\}/);
  assert.ok(!styles.includes('.gdh-fomofeed__name {\n  font-weight: 600; color: #f5f5f5;'));
  assert.ok(!styles.includes('.gdh-fomofeed__sym {\n  color: #e8ecf3;'));
});

await test('Inserted events deduplicate against native GMGN trades', () => {
  const functions = [
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'trackingFeedNormalizedTx'),
    extractFunction(content, 'trackingFeedIsNativeDuplicate'),
  ];
  const exact = { source: 'fomo', type: 'buy', tx: '0xABC' };
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify(exact)}, { tx: '0xabc' })`), true);

  const fomo = { source: 'fomo', type: 'buy', addr: '0xABCDEF', chain: 'bsc', ts: 100000, usd: 100 };
  const row = { addr: '0xabcdef', chain: 'bsc', side: 'buy', ts: 110000, usd: 103 };
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify(fomo)}, ${JSON.stringify(row)})`), true);
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify({ ...fomo, type: 'thesis' })}, ${JSON.stringify(row)})`), false);
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify({ ...fomo, usd: 130 })}, ${JSON.stringify(row)})`), false);

});

await test('The page bridge publishes and clears native trade fingerprints', () => {
  for (const field of ['transaction_hash', 'amount_usd', 'data-gdh-track-tx', 'data-gdh-track-side', 'data-gdh-track-usd']) {
    assert.ok(bridge.includes(field), `missing tracker field ${field}`);
  }
  assert.match(bridge, /'data-gdh-track-usd', 'data-gdh-track-ts',[\s\S]*element\.removeAttribute\(attr\)/);
});

await test('The page bridge recognizes only complete trade records', () => {
  const fn = extractFunction(bridge, 'readTrackerRecord');
  const run = (record) => evaluate([fn], `(() => {
    const element = {};
    element['__reactFiber$test'] = { memoizedProps: { record: ${JSON.stringify(record)} } };
    return readTrackerRecord(element);
  })()`);
  assert.equal(run({ base_address: '0xdead', symbol: 'NOT_A_TRADE' }), null);
  const result = run({
    token_address: '0xabc', base_token: { symbol: 'ABC' }, chain: 'bsc',
    maker_info_address: '0xmaker', side: 'buy', timestamp: 1700000000,
    transaction_hash: '0xtx', amount_usd: 12.5,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    address: '0xabc', symbol: 'ABC', chain: 'bsc', maker: '0xmaker', nick: '',
    side: 'buy', tx: '0xtx', usd: 12.5, ts: 1700000000000,
  });
});

await test('Tracking supports card, table, and no-testid layouts', () => {
  assert.ok(content.includes('TRACKER_TABLE_ITEM_SELECTOR'));
  assert.ok(content.includes('TRACKER_DATA_SELECTOR'));
  assert.ok(content.includes('fixed.h <= 50'));
  assert.ok(bridge.includes("row.firstElementChild"));
  assert.match(bridge, /querySelectorAll\(TRACKER_TABLE_ITEM_SELECTOR\)[\s\S]*trackerSeen\.add\(candidate\)/);
  assert.ok(bridge.includes('scanUnmarkedTrackerRows'));
  assert.match(bridge, /if \(!trackerSeen\.size\) scanUnmarkedTrackerRows\(trackerSeen, trackerData\)/);
  assert.match(bridge, /value\.maker[\s\S]*side === 'buy'[\s\S]*timestamp > 0/);
});

await test('The FOMO keeper uses a real non-discardable background page', async () => {
  const calls = [];
  const chrome = { tabs: {
    query: async () => [],
    create: async (options) => { calls.push(['create', options]); return { id: 7, url: options.url, discarded: false }; },
    update: async (id, options) => { calls.push(['update', id, options]); return { id, url: 'https://fomo.family/?gdh_keeper=1', discarded: false }; },
    reload: async () => {},
  } };
  const fn = extractFunction(background, 'fomoEnsureSdkOwner');
  const result = evaluate([fn], 'fomoEnsureSdkOwner(true)', {
    chrome,
    FOMO_KEEPER_URL: 'https://fomo.family/?gdh_keeper=1',
    fomoOpenTabs: async () => [],
    fomoAuthNote: async () => {},
  });
  await result;
  assert.equal(calls[0][1].active, false);
  assert.equal(calls[0][1].pinned, true);
  assert.equal(calls[1][2].autoDiscardable, false);
  const frozenCalls = [];
  const frozenChrome = { tabs: {
    query: async () => [],
    create: async (options) => { frozenCalls.push(['create', options]); return { id: 8, url: options.url, discarded: false }; },
    update: async (id, options) => ({ id, url: 'https://fomo.family/?gdh_keeper=1', discarded: false, ...options }),
    reload: async () => {},
  } };
  await evaluate([fn], 'fomoEnsureSdkOwner(true)', {
    chrome: frozenChrome,
    FOMO_KEEPER_URL: 'https://fomo.family/?gdh_keeper=1',
    fomoOpenTabs: async () => [{ id: 3, url: 'https://fomo.family/', discarded: false, status: 'complete' }],
    fomoAuthNote: async () => {},
  });
  assert.equal(frozenCalls.length, 1);
  const closed = [];
  const heartbeatFn = extractFunction(background, 'recordFomoPageHeartbeat');
  await evaluate([heartbeatFn], "recordFomoPageHeartbeat({ visible: true, keeper: false }, { tab: { id: 10, url: 'https://fomo.family/' } })", {
    URL,
    Date,
    chrome: { storage: { local: { set: async () => {} } }, tabs: { remove: async (ids) => closed.push(...ids) } },
    fomoOpenTabs: async () => [
      { id: 10, url: 'https://fomo.family/' },
      { id: 11, url: 'https://fomo.family/?gdh_keeper=1' },
    ],
    fomoAuthNote: async () => {},
  });
  assert.deepEqual(closed, [11]);
});

await test('FOMO recognizes authentication errors inside HTTP 200', () => {
  const fn = extractFunction(background, 'fomoBodyUnauthed');
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ success: false, statusCode: 401 })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ statusCode: 403 })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ error: 'unauthorized' })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ statusCode: 430 })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ success: true, statusCode: 200 })"), false);
  const authedFetch = extractFunction(background, 'fomoAuthedFetchImpl');
  assert.ok(extractFunction(background, 'fomoAuthedFetch').includes('fomoAuthedFetchImpl(path,options)'));
  assert.ok(authedFetch.includes('res.status === 430'));
  assert.ok(authedFetch.includes('res.status === 431'));
});

await test('FOMO rejects malformed and application-level failed responses', () => {
  const fn = extractFunction(background, 'fomoBodyFailed');
  assert.equal(evaluate([fn], 'fomoBodyFailed(null)'), true);
  assert.equal(evaluate([fn], "fomoBodyFailed({ success: false })"), true);
  assert.equal(evaluate([fn], "fomoBodyFailed({ statusCode: 201 })"), true);
  assert.equal(evaluate([fn], "fomoBodyFailed({ success: true, statusCode: 200, responseObject: {} })"), false);
  assert.equal(evaluate([fn], "fomoBodyFailed({ items: [] })"), false);
});

await test('The background avoids direct Privy session calls and public secrets', () => {
  assert.ok(!background.includes('auth.privy.io/api/v1/sessions'));
  assert.ok(!background.includes('gdh-marked-watch-2026'));
  assert.ok(!background.includes('reportCustomMarked'));
});

await test('The download page is safe and ZIP-only', () => {
  assert.ok(!site.includes('.innerHTML ='));
  assert.ok(site.includes('985gmgn-helper-private/releases'));
  assert.ok(site.includes('Load unpacked'));
  assert.ok(site.includes('.sha256'));
});

await test('The FOMO login button uses the existing referral route', () => {
  const fn = extractFunction(content, 'buildFomoErrorBox');
  assert.ok(fn.includes("link.href = 'https://fomo.family/';"));
  assert.ok(fn.includes("window.open('https://fomo.family/r/Unipioneer', '_blank', 'noopener,noreferrer');"));
  assert.ok(fn.includes("link.textContent = 'Open FOMO and sign in →';"));
  assert.ok(!fn.includes("textContent = 'Unipioneer'"));
});

await test('Solana supply cache keys preserve case', () => {
  assert.ok(background.includes("const normalizedAddress = looksEvm ? String(address).toLowerCase() : String(address);"));
});

await test('FOMO share obtains cross-chain supply from same-origin GMGN', async () => {
  const fn = extractFunction(content, 'loadFomoSupply');
  assert.ok(fn.includes('https://gmgn.ai/api/v1/mutil_window_token_info?'));
  assert.ok(fn.includes("body: JSON.stringify({ chain: route.chain, addresses: [route.address] })"));
  assert.ok(fn.includes('item?.total_supply ?? item?.max_supply ?? item?.circulating_supply'));
  assert.ok(fn.indexOf('await fetch(') < fn.indexOf("type: 'token-supply'"));
  assert.ok(fn.includes('fomoStats.key === statKey'));

  const address = '0xfdae23ce76018da62507bb5ef20e6ef5450e8312';
  const stats = { key: `robinhood|${address}`, holders: null, thesisCount: null, supply: 0 };
  let backgroundCalls = 0;
  let renders = 0;
  await evaluate([fn], `loadFomoSupply({ chain: 'robinhood', address: '${address}' })`, {
    fomoStats: stats,
    fomoLoadGeneration: 0,
    fomoSupplyLoadingKey: '',
    gmgnApiQuery: () => 'device_id=live-page',
    settings: {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ code: 0, data: [{ total_supply: '1000000000' }] }),
    }),
    chrome: { runtime: { sendMessage: async () => { backgroundCalls += 1; return { ok: false }; } } },
    renderFomoStats: () => { renders += 1; },
  });
  assert.equal(stats.supply, 1_000_000_000);
  assert.equal(backgroundCalls, 0);
  assert.equal(renders, 1);
});

await test('Translation probes preserve mixed script evidence', () => {
  const runtimes = [
    [content, 'fomoLanguageProbe', 'fomoFallbackLang'],
  ];
  const cases = [
    ['\\u7b80\\u4f53', 'zh'],
    ['\\u7e41\\u9ad4', 'zh'],
    ['\\u3059\\u3054\\u3044', 'ja'],
    ['\\ub300\\ubc15', 'ko'],
    ['\\u4e2d\\u6587 HODL', 'zh'],
    ['\\u3059\\u3054\\u3044 HODL', 'ja'],
    ['\\ub300\\ubc15 HODL', 'ko'],
  ];
  for (const [source, probeName, fallbackName] of runtimes) {
    const probe = extractFunction(source, probeName);
    const fallback = extractFunction(source, fallbackName);
    const mixed = evaluate([probe], `${probeName}('\\u4e2d\\u6587 HODL https://example.com 0x1234567890abcdef')`);
    assert.equal(mixed, String.fromCodePoint(0x4e2d, 0x6587) + ' HODL');
    for (const [sample, lang] of cases) {
      assert.equal(evaluate([fallback], `${fallbackName}('${sample}')`), lang);
    }
    assert.equal(evaluate([fallback], `${fallbackName}('moon soon')`), '');
  }
});

await test('Language tags and detector candidates normalize before translation', () => {
  const runtimes = [
    [content, 'normalizeFomoLanguageTag', 'selectFomoDetectedLanguage'],
  ];
  for (const [source, normalizeName, selectName] of runtimes) {
    const normalize = extractFunction(source, normalizeName);
    const select = extractFunction(source, selectName);
    assert.equal(evaluate([normalize], `${normalizeName}('EN-gb')`), 'en');
    assert.equal(evaluate([normalize], `${normalizeName}('pt_BR')`), 'pt');
    assert.equal(evaluate([normalize], `${normalizeName}('zh-Hant-TW')`), 'zh');
    const candidates = JSON.stringify([
      { detectedLanguage: 'fr-FR', confidence: 0.01 },
      { detectedLanguage: 'en-US', confidence: 0.92 },
      { detectedLanguage: 'es-MX', confidence: 0.07 },
    ]);
    assert.equal(evaluate([normalize, select], `${selectName}(${candidates})`), 'en');
    const other = JSON.stringify([
      { detectedLanguage: 'en', confidence: 0.1 },
      { detectedLanguage: 'es-419', confidence: 0.84 },
    ]);
    assert.equal(evaluate([normalize, select], `${selectName}(${other})`), 'es');
  }
});

await test('Detection skips confirmed English and keeps safe failure fallbacks', async () => {
  const fomoFunctions = [
    extractFunction(content, 'fomoLanguageProbe'),
    extractFunction(content, 'fomoFallbackLang'),
    extractFunction(content, 'normalizeFomoLanguageTag'),
    extractFunction(content, 'selectFomoDetectedLanguage'),
    extractFunction(content, 'fomoDetectLang'),
  ];
  const detector = (candidates) => ({ create: async () => ({ detect: async () => candidates }) });
  assert.equal(await evaluate(fomoFunctions, "fomoDetectLang('hold this gem')", {
    fomoDetector: null,
    fomoDetApi: () => detector([{ detectedLanguage: 'en-US', confidence: 0.11 }]),
  }), 'en');
  assert.equal(await evaluate(fomoFunctions, "fomoDetectLang('bonjour le monde')", {
    fomoDetector: null,
    fomoDetApi: () => detector([{ detectedLanguage: 'fr-CA', confidence: 0.61 }]),
  }), 'fr');
  assert.equal(await evaluate(fomoFunctions, "fomoDetectLang('unknown latin text')", {
    fomoDetector: null,
    fomoDetApi: () => ({ create: async () => { throw new Error('temporary'); } }),
  }), '');
  assert.equal(await evaluate(fomoFunctions, "fomoDetectLang('\\u7e41\\u9ad4 English')", {
    fomoDetector: null,
    fomoDetApi: () => detector([{ detectedLanguage: 'en', confidence: 0.8 }]),
  }), 'zh');
  assert.equal(await evaluate(fomoFunctions, "fomoDetectLang('\\u6771\\u4eac')", {
    fomoDetector: null,
    fomoDetApi: () => detector([{ detectedLanguage: 'ja-JP', confidence: 0.93 }]),
  }), 'ja');

});

await test('Confirmed English is cached without creating a translator', async () => {
  const fomoCache = new Map();
  let fomoTranslatorCalls = 0;
  await evaluate([extractFunction(content, 'runFomoTranslate')], 'runFomoTranslate()', {
    settings: { fomoTranslate: true }, fomoTrGeneration: 3, fomoTrRunning: false,
    fomoTrQueue: [{ el: { dataset: {} }, text: 'plain English', generation: 3 }],
    fomoTrCache: fomoCache, FOMO_TR_CACHE_MAX: 300,
    fomoDetectLang: async () => 'en',
    fomoTranslatorFor: async () => { fomoTranslatorCalls += 1; return null; },
    setBoundedMap: (map, key, value) => map.set(key, value), paintTranslation: () => {},
  });
  assert.equal(fomoCache.get('plain English'), '');
  assert.equal(fomoTranslatorCalls, 0);

});

await test('Transient detection failures are not negative-cached', async () => {
  const fomoCache = new Map();
  await evaluate([extractFunction(content, 'runFomoTranslate')], 'runFomoTranslate()', {
    settings: { fomoTranslate: true }, fomoTrGeneration: 1, fomoTrRunning: false,
    fomoTrQueue: [{ el: { dataset: {} }, text: 'unknown Latin', generation: 1 }],
    fomoTrCache: fomoCache, FOMO_TR_CACHE_MAX: 300,
    fomoDetectLang: async () => '', fomoTranslatorFor: async () => null,
    setBoundedMap: (map, key, value) => map.set(key, value), paintTranslation: () => {},
  });
  assert.equal(fomoCache.has('unknown Latin'), false);

});

await test('Translator availability and creation always use normalized source to English', async () => {
  const contentCalls = [];
  const contentTranslator = { translate: async (text) => text };
  const contentApi = {
    availability: async (options) => { contentCalls.push(['availability', options]); return 'available'; },
    create: async (options) => { contentCalls.push(['create', options]); return contentTranslator; },
  };
  const contentFunctions = [
    extractFunction(content, 'normalizeFomoLanguageTag'),
    extractFunction(content, 'fomoTranslatorFor'),
  ];
  const contentContext = {
    fomoTranslators: new Map(), fomoTrApi: () => contentApi, fomoTrGesture: false,
    fomoTrPendingLangs: new Set(), fomoTrNeedsGesture: false, fomoTrStuck: false,
    fomoTrProgress: 0, FOMO_TR_STUCK_MS: 15000, syncFomoTrButton: () => {},
    window: { setTimeout: () => 0 },
  };
  assert.equal(await evaluate(contentFunctions, "fomoTranslatorFor('PT_br')", contentContext), contentTranslator);
  assert.deepEqual(JSON.parse(JSON.stringify(contentCalls[0])), ['availability', { sourceLanguage: 'pt', targetLanguage: 'en' }]);
  assert.equal(contentCalls[1][0], 'create');
  assert.equal(contentCalls[1][1].sourceLanguage, 'pt');
  assert.equal(contentCalls[1][1].targetLanguage, 'en');
  assert.equal(typeof contentCalls[1][1].monitor, 'function');
  assert.equal(await evaluate(contentFunctions, "fomoTranslatorFor('en-GB')", contentContext), null);
  assert.equal(contentCalls.length, 2);

});

await test('Translation painting preserves originals and is idempotent', () => {
  const runtimes = [
    [content, 'paintTranslation', 'gdh-fomo__zh', 'fomoTrGeneration'],
  ];
  for (const [source, paintName, className, generationName] of runtimes) {
    const paint = extractFunction(source, paintName);
    const result = evaluate([paint], `(() => {
      const made = [];
      const original = {
        textContent: '  exact original\\ntext  ', parentNode: {}, nextElementSibling: null,
        after(node) { if (!this.nextElementSibling) { this.nextElementSibling = node; made.push(node); } },
      };
      document.createElement = () => {
        const node = { className: '', textContent: '' };
        node.classList = { contains: (value) => node.className.split(/\\s+/).includes(value) };
        return node;
      };
      ${paintName}(original, 'English sibling', 4);
      ${paintName}(original, 'Updated English sibling', 4);
      return { original: original.textContent, count: made.length, translated: made[0]?.textContent };
    })()`, {
      settings: { fomoTranslate: true }, [generationName]: 4, document: { createElement: null },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      original: '  exact original\ntext  ', count: 1, translated: 'Updated English sibling',
    });
    assert.equal(className.endsWith('__zh'), true);
  }
});

await test('Turning translation off invalidates in-flight paint jobs', () => {
  const contentRun = extractFunction(content, 'runFomoTranslate');
  assert.match(contentRun, /await translator\.translate\(text\)[\s\S]*?generation !== fomoTrGeneration/);
  assert.ok(extractFunction(content, 'applyFomoTranslationSetting').includes('fomoTrGeneration += 1'));
  assert.ok(extractFunction(content, 'refreshFomoTranslations').includes("querySelectorAll('.gdh-fomo__zh')"));

  const staleCases = [
    [content, 'paintTranslation', 'fomoTrGeneration'],
  ];
  for (const [source, paintName, generationName] of staleCases) {
    const element = { parentNode: {}, nextElementSibling: null, after: () => { throw new Error('stale paint'); } };
    evaluate([extractFunction(source, paintName)], `${paintName}(element, 'late translation', 1)`, {
      element, settings: { fomoTranslate: true }, [generationName]: 2,
      document: { createElement: () => { throw new Error('stale paint'); } },
    });
  }
});

await test('Every FOMO narrative render path queues an English sibling', () => {
  assert.ok(extractFunction(content, 'renderFomoHolders').includes('queueFomoTranslate(t, thesis)'));
  assert.ok(extractFunction(content, 'renderFomoItems').includes('queueFomoTranslate(body, text)'));
  assert.ok(extractFunction(content, 'buildFomoFeedTableRow').includes('queueFomoTranslate(text, ev.comment)'));
  assert.ok(extractFunction(content, 'buildFomoFeedCard').includes('queueFomoTranslate(text, ev.comment)'));
  assert.ok(content.includes("const FOMO_TRANSLATION_SOURCE_SELECTOR = '.gdh-fomo__text, .gdh-fomo__htext, .gdh-fomofeed__thesis'"));
  assert.ok(content.includes("if (key === 'fomoTranslate') {\n        applyFomoTranslationSetting(change.newValue);"));
  assert.ok(!content.includes("new Set(['zh'"));
  assert.ok(content.includes("`${fomoStats.thesisCount} narratives`"));
});

await test('FOMO token-trade fallback reconstructs buys, sells, and position actions', async () => {
  const functions = [
    extractFunction(background, 'fomoHttpsUrl'),
    extractFunction(background, 'slimFomoTokenSwap'),
    extractFunction(background, 'fomoSwapsFromTrade'),
  ];
  const target = '0x1234567890123456789012345678901234567890';
  const detail = {
    trade: {
      id: '11111111-1111-4111-8111-111111111111', userId: 'u1', networkId: 4663,
      openedAt: '2026-09-03T12:00:00Z', closedAt: '2026-09-03T12:03:00Z',
      usdValue: 120, realizedPnlUsd: 18,
    },
    user: { id: 'u1', userHandle: '@alice_user', displayName: 'Alice Nick' },
    swaps: [
      { id: 'buy-1', outTokenAddress: target, inTokenAddress: '0x0000000000000000000000000000000000000001', humanUsdAmountIn: '40', createdAt: '2026-09-03T12:00:00Z' },
      { id: 'buy-2', outTokenAddress: target, inTokenAddress: '0x0000000000000000000000000000000000000001', humanUsdAmountIn: '20', createdAt: '2026-09-03T12:01:00Z' },
      { id: 'sell-1', inTokenAddress: target, outTokenAddress: '0x0000000000000000000000000000000000000001', humanUsdAmountOut: '78', createdAt: '2026-09-03T12:03:00Z' },
    ],
  };
  const result = evaluate(functions, `fomoSwapsFromTrade(${JSON.stringify(detail)}, '${target}')`);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map((item) => ({
    side: item.side, positionAction: item.positionAction, usdAmount: item.usdAmount,
    handle: item.user.userHandle, displayName: item.user.displayName,
  })))), [
    { side: 'buy', positionAction: 'First', usdAmount: 40, handle: 'alice_user', displayName: 'Alice Nick' },
    { side: 'buy', positionAction: 'More', usdAmount: 20, handle: 'alice_user', displayName: 'Alice Nick' },
    { side: 'sell', positionAction: 'All', usdAmount: 78, handle: 'alice_user', displayName: 'Alice Nick' },
  ]);
  assert.match(background, /async function fomoFetchToken\([\s\S]*fetchFomoTokenTradeFallback\(tokenAddress, holders\.items\)/);
  assert.ok(background.includes('`/trades/${encodeURIComponent(id)}`'));
  assert.ok(background.includes('FOMO_TOKEN_TRADE_FALLBACK_TTL_MS = 120000'));
  assert.ok(background.includes('fomoTokenTradeFallbackInflight'));
  const holder = { tradeId: detail.trade.id, user: detail.user };
  const worker = backgroundHarness((requestPath) => {
    assert.equal(requestPath, `/trades/${detail.trade.id}`);
    return new Response(JSON.stringify({ statusCode: 200, responseObject: {
      ...detail, user: { id: 'u1', userHandle: null, displayName: null },
    } }));
  });
  const fallback = await worker.run(`Promise.all([
    fetchFomoTokenTradeFallback('${target}', ${JSON.stringify([holder])}),
    fetchFomoTokenTradeFallback('${target}', ${JSON.stringify([holder])})
  ])`);
  for (const response of fallback) {
    assert.equal(response.ok, true);
    assert.equal(response.source, 'holder-history');
    assert.equal(response.partial, false);
    assert.equal(response.count, 3);
    assert.ok(response.fetchedAt > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(response.coverage)), { attempted: 1, succeeded: 1, limit: 50, truncated: false });
    assert.deepEqual(JSON.parse(JSON.stringify(response.items.map((item) => ({
      side: item.side, positionAction: item.positionAction, usdAmount: item.usdAmount,
      handle: item.user.userHandle, displayName: item.user.displayName,
    })))), JSON.parse(JSON.stringify(result.slice().reverse().map((item) => ({
      side: item.side, positionAction: item.positionAction, usdAmount: item.usdAmount,
      handle: item.user.userHandle, displayName: item.user.displayName,
    })))));
  }
  assert.equal(worker.calls.length, 1, 'concurrent fallback requests share production detail fetches');
  assert.equal(worker.run('fomoTokenTradeFallbackCache.size'), 1, 'complete history may enter the authoritative cache');
  const cached = await worker.run(`fetchFomoTokenTradeFallback('${target}', ${JSON.stringify([holder])})`);
  assert.equal(cached.fetchedAt, fallback[0].fetchedAt);
  assert.equal(worker.calls.length, 1, 'cached history does not re-fetch trade details');
  const partialWorker = backgroundHarness((requestPath) => requestPath === `/trades/${detail.trade.id}`
    ? new Response(JSON.stringify({ statusCode: 200, responseObject: detail }))
    : new Response(JSON.stringify({ error: 'temporary failure' }), { status: 500 }));
  const partial = await partialWorker.run(`fetchFomoTokenTradeFallback('${target}', ${JSON.stringify([
    holder, { tradeId: '22222222-2222-4222-8222-222222222222', user: detail.user },
  ])})`);
  assert.equal(partial.ok, true);
  assert.equal(partial.partial, true);
  assert.equal(partial.count, 3, 'successful detail swaps survive a sibling detail failure');
  assert.equal(partial.coverage.attempted, 2);
  assert.equal(partial.coverage.succeeded, 1);
  assert.equal(partialWorker.run('fomoTokenTradeFallbackCache.size'), 0, 'incomplete history must not enter the authoritative cache');
});

await test('FOMO followed-holder lookup batches tokens and prefers usernames', async () => {
  const functions = [
    extractFunction(background, 'setBoundedMap'),
    extractFunction(background, 'fomoBodyUnauthed'),
    extractFunction(background, 'fomoBodyFailed'),
    extractFunction(background, 'fomoHttpsUrl'),
    extractFunction(background, 'normalizeFomoTokenRef'),
    extractFunction(background, 'slimFomoFollowedHolder'),
    extractFunction(background, 'fetchFomoFollowedHolders'),
  ];
  const calls = [];
  const address = '0x1234567890123456789012345678901234567890';
  const result = await evaluate(functions, `fetchFomoFollowedHolders({ tokens: [
    { address: '${address.toUpperCase().replace('0X', '0x')}', networkId: 56 },
    { address: 'bad', networkId: 56 }
  ] })`, {
    Date,
    FOMO_NETWORK_SLUG: { 56: 'bsc' },
    FOMO_FOLLOWED_HOLDERS_TTL_MS: 30000,
    FOMO_FOLLOWED_HOLDERS_CACHE_MAX: 30,
    fomoFollowedHoldersCache: new Map(),
    fomoAuthGeneration: 0,
    fomoAuthedFetch: async (path, options) => {
      calls.push({ path, method: options.method, payload: JSON.parse(options.body) });
      const body = { statusCode: 200, responseObject: { tokens: [{
        tokenAddress: address, networkId: 56, totalHolders: 2,
        topHolders: [
          { user: { id: 'u1', userHandle: '@alice_user', displayName: 'Alice Nick' } },
          { user: { id: 'u2', displayName: 'Bob Nick' } },
        ],
      }] } };
      return { res: { ok: true, status: 200, json: async () => body } };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/hodlers/friends');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].payload.tokens.length, 1);
  assert.equal(result.holdings[0].count, 2);
  assert.equal(result.holdings[0].users[0].name, 'alice_user');
  assert.equal(result.holdings[0].users[1].name, 'Bob Nick');
  assert.ok(content.includes("type: 'fomo-followed-holders'"));
  assert.ok(content.includes("followed.textContent = '★ Following'"));
  assert.ok(styles.includes('.gdh-fomo__hrow.is-followed'));
  assert.ok(popupHtml.includes('Token-page FOMO holder count'));
  assert.ok(background.includes('fomoFollowedHoldersCache.clear()'));
  assert.ok(background.includes('fomoAuthGeneration += 1'));
  assert.ok(content.includes('fomoFollowedHoldersGeneration += 1'));
  assert.ok(content.includes('fomoFollowedHoldersByChain.clear()'));
  assert.ok(content.includes('FOMO_FOLLOWED_HOLDERS_RETRY_MAX'));
});

await test('FOMO account identity survives token refreshes but changes with the user', () => {
  const makeToken = (sub, exp) => {
    const body = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url');
    return `header.${body}.signature`;
  };
  const first = { token: makeToken('did:privy:user-a', 1) };
  const refreshed = { token: makeToken('did:privy:user-a', 2) };
  const switched = { token: makeToken('did:privy:user-b', 2) };
  const backgroundFn = extractFunction(background, 'fomoAccountIdentity');
  const contentFn = extractFunction(content, 'fomoStoredAccountIdentity');
  const extras = { atob };
  assert.equal(evaluate([backgroundFn], `fomoAccountIdentity(${JSON.stringify(first)})`, extras), 'did:privy:user-a');
  assert.equal(evaluate([backgroundFn], `fomoAccountIdentity(${JSON.stringify(refreshed)})`, extras), 'did:privy:user-a');
  assert.equal(evaluate([contentFn], `fomoStoredAccountIdentity(${JSON.stringify(switched)})`, extras), 'did:privy:user-b');
  assert.ok(background.includes("fomoFollowedFeedInflight?.generation === fomoAuthGeneration"));
  assert.ok(background.includes("fomoTradeDetailInflight.get(id)?.promise === promise"));
});

await test('FOMO panel discards stale responses after account, route, or tab changes', () => {
  const fn = extractFunction(content, 'loadFomoData');
  assert.ok(fn.includes('const requestGeneration = ++fomoLoadGeneration'));
  assert.ok(fn.includes('requestGeneration !== fomoLoadGeneration'));
  assert.ok(fn.includes("`${fomoTab}|${current.chain}|${current.address}` === key"));
  assert.ok(content.includes('fomoLoadGeneration += 1'));
  assert.ok(fn.includes('fomoLoadInflight?.key === key'));
  assert.ok(fn.includes('fomoLoadInflight?.generation === requestGeneration'));
  assert.ok(!content.includes('if (fomoLoading) return'));
});

await test('Retired manifesto and Flap controls cannot be enabled', () => {
  for (const key of ['enableManifestoToast', 'enableManifestoTab', 'enableFlapTax', 'flapRpc']) {
    assert.ok(!content.includes(key));
    assert.ok(!popupHtml.includes(key));
    assert.ok(!read('popup.js').includes(key));
  }
  assert.ok(!background.includes('flap-token-info'));
});

await test('Developer tooltip target is the compact metrics badge, not the whole card', () => {
  class FakeElement {}
  const card = new FakeElement();
  const trigger = new FakeElement();
  const badgeChild = new FakeElement();
  card.closest = () => null;
  trigger.closest = (selector) => selector.includes('[data-gdh-watched="1"]') ? card : null;
  badgeChild.closest = (selector) => selector === '.gdh-dev-performance' ? trigger : null;
  const fn = extractFunction(content, 'findWatchedCard');
  assert.equal(evaluate([fn], 'findWatchedCard(badgeChild)', {
    badgeChild, Element: FakeElement, CARD_SELECTOR: '[data-testid="trench-token-card"]',
    settings: { showDevTooltip: true },
  }), card);
  assert.equal(evaluate([fn], 'findWatchedCard(card)', {
    card, Element: FakeElement, CARD_SELECTOR: '[data-testid="trench-token-card"]',
    settings: { showDevTooltip: true },
  }), null);
  assert.match(styles, /\.gdh-dev-performance\s*\{[\s\S]*pointer-events:\s*auto;/);
});

await test('Developer tooltip dismissal covers clicks, card changes, and lifecycle exits', () => {
  const functions = [
    extractFunction(content, 'hideTooltip'),
    extractFunction(content, 'suppressTooltipUntilPointerExit'),
    extractFunction(content, 'dismissTooltipForLifecycle'),
    extractFunction(content, 'handleTooltipPointerMove'),
    extractFunction(content, 'handleTooltipScroll'),
    extractFunction(content, 'showTooltipForCard'),
  ];
  const cardA = { isConnected: true };
  const cardB = { isConnected: true };
  const findWatchedCard = (target) => target === cardA ? cardA : target === cardB ? cardB : null;

  const clickTooltip = {
    classList: {
      remove(value) { clickCounters.removed = value; },
      add(value) { clickCounters.added = value; },
    },
  };
  const clickCounters = { positioned: 0, removed: '', added: '', filledOtherCard: false };
  const clickResult = evaluate(functions, `(() => {
    activeCard = cardA;
    tooltip = clickTooltip;
    suppressTooltipUntilPointerExit();
    handleTooltipPointerMove({ target: cardA });
    const suppressedOnClickedCard = suppressedTooltipCard === cardA;
    handleTooltipPointerMove({ target: cardB });
    return {
      activeOtherCard: activeCard === cardB,
      removed: clickCounters.removed,
      added: clickCounters.added,
      positioned: clickCounters.positioned,
      filledOtherCard: clickCounters.filledOtherCard,
      suppressedOnClickedCard,
      suppressionClearedForOtherCard: suppressedTooltipCard === null,
    };
  })()`, {
    activeCard: null,
    tooltip: null,
    suppressedTooltipCard: null,
    cardA,
    cardB,
    clickTooltip,
    clickCounters,
    findWatchedCard,
    fillTooltip: (card) => { clickCounters.filledOtherCard = card === cardB; },
    ensureTooltip: () => clickTooltip,
    positionTooltip: () => { clickCounters.positioned += 1; },
    scheduleScrollScan: () => {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(clickResult)), {
    activeOtherCard: true,
    removed: 'gdh-tooltip--visible',
    added: 'gdh-tooltip--visible',
    positioned: 1,
    filledOtherCard: true,
    suppressedOnClickedCard: true,
    suppressionClearedForOtherCard: true,
  });

  const replacementResult = evaluate(functions, `(() => {
    suppressedTooltipCard = detachedCard;
    handleTooltipPointerMove({ target: replacementCard });
    return { adoptedReplacement: suppressedTooltipCard === replacementCard, positioned: counters.positioned };
  })()`, {
    activeCard: null,
    tooltip: null,
    suppressedTooltipCard: null,
    detachedCard: { isConnected: false },
    replacementCard: cardB,
    counters: { positioned: 0 },
    findWatchedCard: (target) => target === cardB ? cardB : null,
    positionTooltip: () => { throw new Error('replacement tooltip repositioned'); },
    scheduleScrollScan: () => {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replacementResult)), {
    adoptedReplacement: true,
    positioned: 0,
  });

  const lifecycleCounters = { scroll: 0 };
  const lifecycleResult = evaluate(functions, `(() => {
    activeCard = cardA;
    suppressedTooltipCard = cardA;
    tooltip = { classList: { remove(value) { removed = value; } } };
    handleTooltipScroll(scrollEvent);
    return {
      activeCard,
      suppressedTooltipCard,
      removed,
      scrollCalls: lifecycleCounters.scroll,
    };
  })()`, {
    activeCard: null,
    tooltip: null,
    suppressedTooltipCard: null,
    cardA,
    removed: '',
    scrollEvent: { type: 'scroll' },
    lifecycleCounters,
    findWatchedCard,
    positionTooltip: () => {},
    scheduleScrollScan: () => { lifecycleCounters.scroll += 1; },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycleResult)), {
    activeCard: null,
    suppressedTooltipCard: null,
    removed: 'gdh-tooltip--visible',
    scrollCalls: 1,
  });

  const positionCounters = { positioned: 0 };
  const activeResult = evaluate(functions, `(() => {
    activeCard = cardA;
    tooltip = { classList: { remove() { throw new Error('active tooltip hidden'); } } };
    handleTooltipPointerMove({ target: cardA });
    return { sameCard: activeCard === cardA, positioned: positionCounters.positioned };
  })()`, {
    activeCard: null,
    tooltip: null,
    suppressedTooltipCard: null,
    cardA,
    positionCounters,
    findWatchedCard,
    positionTooltip: () => { positionCounters.positioned += 1; },
    scheduleScrollScan: () => {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(activeResult)), { sameCard: true, positioned: 1 });

  assert.ok(content.includes("document.addEventListener('pointerdown', suppressTooltipUntilPointerExit, true);"));
  assert.ok(content.includes("document.addEventListener('scroll', handleTooltipScroll, true);"));
  assert.ok(content.includes("window.addEventListener('blur', dismissTooltipForLifecycle);"));
  assert.ok(content.includes("if (document.visibilityState === 'hidden') dismissTooltipForLifecycle();"));
  assert.ok(content.includes('if (activeCard && !activeCard.isConnected) hideTooltip();'));
});

await test('Maintained sources are English-only and the release surface is ZIP-only', () => {
  const ignored = new Set(['.git', 'dist', 'node_modules', 'test-results']);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!/\.(?:png|ico)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  const auditFiles = files.filter((file) => file !== fileURLToPath(import.meta.url));
  const maintained = auditFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(maintained, /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/u);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.ok(!manifest.permissions.includes('native' + 'Messaging'));
  assert.ok(!maintained.includes('send' + 'NativeMessage'));
  assert.ok(!maintained.toLowerCase().includes(['native', 'updater'].join('-')));
  // Match executable assets, not JavaScript APIs such as process.execPath.
  assert.doesNotMatch(maintained, /\.exe\b/i);
  assert.ok(!background.includes('install' + '-update'));
  assert.ok(!background.includes('985gmgn-' + 'update-check'));
  assert.ok(!popupHtml.includes('id="check-' + 'update"'));
  assert.ok(!popup.includes('get-' + 'update-state'));
  assert.equal(fs.existsSync(path.join(root, 'native' + '-updater')), false);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'build-native-' + 'installer.ps1')), false);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/);
  assert.ok(popupHtml.startsWith('<!doctype html>\n<html lang="en">\n'));
  assert.ok(readme.replaceAll('**', '').includes(`Version ${manifest.version}`));
  assert.ok(releaseNote.startsWith(`# better gmgn v${manifest.version}\n`));
  assert.ok(fs.existsSync(path.join(root, 'release-notes', `v${manifest.version}.md`)), 'current release note exists alongside historical notes');
  assert.ok(releaseBuild.includes('gmgn-fomo-helper-v$version.zip'));
  assert.ok(releaseBuild.includes('"$zipPath.sha256"'));
  assert.ok(releaseBuild.includes('Get-ChildItem -LiteralPath $dist -File | Remove-Item -Force'));
  assert.ok(releaseWorkflow.includes("Where-Object { $_.Name -match '\\.zip(?:\\.sha256)?$' }"));
  assert.ok(releaseWorkflow.includes('if ($assets.Count -ne 2)'));
  assert.ok(!releaseBuild.includes('Compress-Archive'));
});

process.stdout.write(`1..${passed}\n`);
