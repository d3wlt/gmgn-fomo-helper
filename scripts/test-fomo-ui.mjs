import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Execute production helpers, not reimplementations. DOM stubs below cover only
// text rendering; full script/lifecycle/geometry tests live in test-fomo-browser.
const root = new URL('../', import.meta.url);
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`PASS ${label}`); }
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Production helper boundaries missing: ${start}`);
  return source.slice(a, b);
}
const plain = value => JSON.parse(JSON.stringify(value));
for (const file of ['content.js', 'debot-content.js']) {
  const source = fs.readFileSync(new URL(file, root), 'utf8');
  const list = { children: [], replaceChildren(...children) { this.children = children; } };
  const context = vm.createContext({
    Date, Number, chrome: { runtime: { getManifest: () => ({ version: '0.50.0' }) } },
    document: { createElement: () => ({ textContent: '', className: '' }) },
    fomoUiRoute: () => ({ chain: 'eth', address: 'SECRET_ADDRESS' }),
    fomoUiTab: () => 'swaps', fomoUiPanel: () => ({ querySelector: () => list }),
    fomoUiItems: () => [], fomoUiRenderItems: (_list, items) => list.replaceChildren(...items),
  });
  vm.runInContext(`let fomoUi = { meta: null, error: null, retryAt: 0, followingOnly: false };\n` +
    section(source, '  function fomoUiTimestamp(', '  function resetFomoUi(') +
    section(source, '  function renderFomoUiItems(', '  function buildFomoUi('), context, { filename: fileURLToPath(new URL(file, root)) });
  const run = expression => vm.runInContext(expression, context);
  check(`${file}: source and coverage allowlist`, () => {
    context.response = { source: 'SECRET_SOURCE', token: 'SECRET_TOKEN', fetchedAt: 'bad', followingKnown: 'true', partial: 1,
      coverage: { attempted: 3.9, succeeded: -1, limit: Infinity, truncated: 'true', users: ['SECRET_USER'] } };
    const meta = plain(run('fomoUiMeta(response)'));
    assert.equal(meta.source, 'unknown'); assert.equal(meta.fetchedAt, 0);
    assert.equal(meta.followingKnown, false); assert.equal(meta.partial, false);
    assert.deepEqual(meta.coverage, { attempted: 3, succeeded: null, limit: null, truncated: false });
    for (const source of ['holder-history', 'token-feed', 'holders', 'thesis']) {
      context.response.source = source; assert.equal(run('fomoUiMeta(response).source'), source);
    }
  });
  check(`${file}: sanitized diagnostics omit payload, users and addresses`, () => {
    run("fomoUi.meta = fomoUiMeta(response); fomoUi.error = fomoUiError({reason:'SECRET_ERROR',message:'SECRET_MESSAGE'});");
    const diagnostics = plain(run('fomoUiDiagnostics()'));
    assert.deepEqual(Object.keys(diagnostics).sort(), ['chain', 'coverage', 'source', 'status', 'tab', 'timestamps', 'version']);
    assert.equal(diagnostics.version, '0.50.0'); assert.equal(diagnostics.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET/);
    context.fomoUiRoute = () => ({ chain: 'SECRET_CHAIN' });
    context.fomoUiTab = () => 'SECRET_TAB';
    context.chrome.runtime.getManifest = () => ({ version: 'SECRET_VERSION' });
    const unknown = run('fomoUiDiagnostics()');
    assert.equal(unknown.chain, 'unknown'); assert.equal(unknown.tab, 'unknown'); assert.equal(unknown.version, 'unknown');
    context.fomoUiTab = () => 'swaps';
  });
  check(`${file}: timestamps and safe retry guidance`, () => {
    assert.equal(run('fomoUiTimestamp(1700000000)'), 1700000000000);
    assert.equal(run('fomoUiTimestamp(1700000000000)'), 1700000000000);
    assert.equal(run("fomoUiTimestamp('2023-11-14T22:13:20Z')"), 1700000000000);
    assert.equal(run("fomoUiTimestamp('SECRET')"), 0);
    const before = Date.now(); const error = run("fomoUiError({status:429, reason:'SECRET'})");
    assert.equal(error.reason, 'rate-limited'); assert.ok(error.retryAt >= before + 30000);
    assert.equal(run("fomoUiError({status:401}).reason"), 'expired');
    assert.match(run("fomoUiErrorText(fomoUiError({reason:'runtime'}))"), /Extension connection unavailable/);
    assert.doesNotMatch(run("fomoUiErrorText(fomoUiError({reason:'SECRET',message:'SECRET'}))"), /SECRET/);
  });
  check(`${file}: Following filters explicit flags, preserves exits and sorts without mutation`, () => {
    context.items = [{ id: 'buy', followed: true, side: 'buy', timestamp: 1700000000 },
      { id: 'other', followed: false, timestamp: 1700000003 },
      { id: 'exit', followed: true, side: 'sell', positionAction: 'All', timestamp: 1700000002 },
      { id: 'unknown', followed: 'true', timestamp: 1700000004 }];
    assert.deepEqual(plain(run("fomoUiVisibleItems(items, 'swaps', true, true).map(x=>x.id)")), ['exit', 'buy']);
    assert.deepEqual(context.items.map(x => x.id), ['buy', 'other', 'exit', 'unknown']);
    assert.equal(run("fomoUiVisibleItems(items, 'swaps', true, false).length"), 0);
    assert.equal(run("fomoUiVisibleItems(items, 'thesis', true, false).length"), 4);
    assert.equal(run("fomoUiVisibleItems(null, 'holders', false, true).length"), 0);
  });
  check(`${file}: unknown Following is not known empty`, () => {
    run('fomoUi.followingOnly = true; fomoUi.meta = fomoUiMeta({followingKnown:false}); renderFomoUiItems();');
    assert.match(list.children[0].textContent, /Following lookup unavailable/);
    run('fomoUi.meta = fomoUiMeta({followingKnown:true}); renderFomoUiItems();');
    assert.equal(list.children[0].textContent, 'No followed trades in this coverage.');
    context.fomoUiTab = () => 'holders'; run('renderFomoUiItems()');
    assert.equal(list.children[0].textContent, 'No followed current holders in this coverage.');
  });
  check(`${file}: first/more/trim/exit use explicit evidence`, () => {
    for (const [action, position, side, activity] of [
      ['First', 'First', 'buy', 'Buy'], ['opened', 'First', 'buy', 'Buy'],
      ['More', 'More', 'buy', 'Buy'], ['increase', 'More', 'buy', 'Buy'],
      ['trimmed', 'Partial', 'sell', 'Trim'], ['Partial', 'Partial', 'sell', 'Trim'],
      ['All', 'All', 'sell', 'Exit'], ['closed', 'All', 'sell', 'Exit'],
      ['', '', 'sell', 'Sell'], ['SECRET', '', 'unknown', ''],
    ]) {
      context.item = { positionAction: action, side };
      assert.equal(run('fomoUiPosition(item)'), position);
      assert.equal(run('fomoUiActivity(item)'), activity);
    }
    assert.equal(run('fomoUiPosition({isFirstTrade:true})'), 'First');
    assert.equal(run('fomoUiActivity({isSell:true,isFullExit:true})'), 'Exit');
    assert.equal(run("fomoUiActivity({type:'wholesale'})"), '');
  });
  if (file === 'debot-content.js') {
    vm.runInContext(section(source, '  function runtimeMessage(', '  function safeText('), context);
    for (const mode of ['empty', 'lastError', 'throw', 'success']) {
      context.chrome.runtime.lastError = mode === 'lastError' ? { message: 'SECRET' } : null;
      context.chrome.runtime.sendMessage = (_message, callback) => {
        if (mode === 'throw') throw new Error('SECRET');
        callback(mode === 'success' ? { ok: true } : undefined);
      };
      const result = plain(await run('runtimeMessage({type:"fixture"})'));
      assert.deepEqual(result, mode === 'success' ? { ok: true } : { ok: false, reason: 'runtime' });
      passed++; console.log(`PASS ${file}: runtime ${mode}`);
    }
  }
}
const gmgnSource = fs.readFileSync(new URL('content.js', root), 'utf8');
const gaps = [];
let deliver;
const feedContext = vm.createContext({
  settings:{enabled:true,enableFomoFeed:true}, document:{querySelector:()=>true},
  TRACK_TAB_CELL:'.fixture', trackerCards:()=>[], Date, fomoUiAuthGeneration:0,
  fomoFollowedLastPollAt:0, fomoFollowedEvents:[], scheduleScan:()=>{},
  renderFomoFollowedGap:response=>gaps.push(response),
  chrome:{runtime:{sendMessage:(_message,callback)=>{deliver=callback;}}},
});
vm.runInContext(section(gmgnSource,'  function pollFomoFollowedFeed(', '  function fomoFeedRelTime('),feedContext);
check('GMGN followed-feed callback propagates real coverage gaps and partial events',()=>{
  vm.runInContext('pollFomoFollowedFeed()',feedContext);
  deliver({ok:true,coverageGap:true,events:[{key:'new'}]});
  assert.equal(gaps.at(-1).coverageGap,true);
  assert.equal(feedContext.fomoFollowedEvents[0].key,'new');
  vm.runInContext('pollFomoFollowedFeed()',feedContext);
  deliver({ok:false,reason:'fetch-failed',coverageGap:true,stale:true,events:[{key:'partial'}]});
  assert.equal(gaps.at(-1).stale,true);
  assert.equal(feedContext.fomoFollowedEvents[0].key,'partial');
});
check('GMGN followed-feed callback rejects account-switch races',()=>{
  vm.runInContext('pollFomoFollowedFeed()',feedContext);
  feedContext.fomoUiAuthGeneration++;
  const count=gaps.length;
  deliver({ok:true,coverageGap:true,events:[{key:'old-account'}]});
  assert.equal(gaps.length,count);
  assert.equal(feedContext.fomoFollowedEvents[0].key,'partial');
});
check('GMGN followed-feed authentication failure clears events',()=>{
  vm.runInContext('pollFomoFollowedFeed()',feedContext);
  deliver({ok:false,reason:'not-connected',events:[{key:'must-not-render'}]});
  assert.equal(feedContext.fomoFollowedEvents.length,0);
});
console.log(`FOMO UI helper scenarios passed: ${passed}`);
