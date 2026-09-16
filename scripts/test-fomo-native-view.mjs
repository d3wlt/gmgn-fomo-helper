import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../fomo-native-view.js', import.meta.url), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${passed} - ${name}`); }
const key = i => `0x${i.toString(16).padStart(40, '0')}:4663`;
const topic = 'trending_tokens:1,56,8453,143,4663,1399811149';
const live = i => ({source: 'live', key: key(i), topicKey: topic});
const fiber = (p = {}, tag = 0) => ({tag, memoizedProps: p, pendingProps: p, child: null, sibling: null, return: null, alternate: null});
function children(parent, ...kids) { parent.child = kids[0] || null; kids.forEach((f, i) => { f.return = parent; f.sibling = kids[i + 1] || null; }); return parent; }
function env(data = [live(1)], mounted = [1], options = {}) {
  const calls = {network: 0, native: 0, callback: 0}, observers = [], frames = new Map(); let serial = 0;
  const host = {isConnected: true};
  const html = {isConnected: true, contains: el => el.isConnected === true};
  const dom = [host];
  const document = {documentElement: html, createTreeWalker: () => { let i = 0; return {nextNode: () => dom[i++] || null}; }};
  const rootFiber = fiber(null, 3), root = {current: rootFiber}; rootFiber.stateNode = root;
  const panel = fiber({panel: {tab: 'tokens', tokenListType: 'trending'}});
  const listProps = {dataKey: 'trending', data, extraData: {listType: 'trending'}};
  const list = fiber(listProps), wrapper = fiber(listProps), rows = [];
  for (const i of mounted) {
    const descriptor = data.find(d => d.key === key(i));
    const address = key(i).split(':')[0];
    const row = fiber({source: 'live', listType: 'trending', tokenAddress: address, chainId: 4663,
      liveToken: {tokenKey: key(i), topicKey: descriptor?.topicKey || topic}});
    const bridge = fiber({topicKey: descriptor?.topicKey || topic, tokenKey: key(i), listType: 'trending', chartPrice: undefined});
    const price = fiber({priceUSD: '2', totalSupply: '100', change24: '-0.25', identity: key(i), listType: 'trending'});
    const leaf = fiber({}, 5); leaf.stateNode = host;
    children(row, children(bridge, children(price, leaf))); rows.push({row, bridge, price, leaf});
  }
  const anchor = fiber({}, 5); anchor.stateNode = host;
  children(rootFiber, children(panel, children(list, children(wrapper, anchor, ...rows.map(r => r.row)))));
  host.__reactFiber$test = anchor;
  const forbidden = () => { calls.network++; throw new Error('forbidden I/O'); };
  class MutationObserver { constructor(cb) { this.cb = cb; this.active = true; observers.push(this); } observe(target, opts) { this.target = target; this.opts = opts; } disconnect() { this.active = false; } }
  const window = {}; window.top = options.frame ? {} : window;
  const ctx = vm.createContext({window, document, location: {origin: options.origin || 'https://fomo.family'},
    MutationObserver, requestAnimationFrame: cb => { const id = ++serial; frames.set(id, cb); return id; },
    cancelAnimationFrame: id => frames.delete(id), fetch: forbidden, WebSocket: forbidden, XMLHttpRequest: forbidden,
    setTimeout: forbidden, setInterval: forbidden, localStorage: {getItem: forbidden, setItem: forbidden}});
  vm.runInContext(source, ctx, {timeout: 1000});
  const api = window.__gdhFomoNativeView;
  return {api, calls, observers, frames, root, rootFiber, panel, list, wrapper, anchor, host, html, dom, rows,
    read: () => { const v = api.read(); return v === null ? null : JSON.parse(JSON.stringify(v)); },
    mutate: records => observers.forEach(o => { if (o.active) o.cb(records || [{type: 'childList', target: host}]); }),
    flush: () => { const cbs = [...frames.values()]; frames.clear(); cbs.forEach(cb => cb()); }};
}
test('origin and top-level guards; immutable API', () => {
  assert.equal(env([], [], {origin: 'http://fomo.family'}).api, undefined);
  assert.equal(env([], [], {frame: true}).api, undefined);
  const e = env(); assert(Object.isFrozen(e.api)); assert.throws(() => { e.api.read = () => null; });
  assert.deepEqual(Object.keys(e.api), ['read', 'observe']);
});
test('full 100 native descriptors, mounted subset, exact DTO', () => {
  const e = env(Array.from({length: 100}, (_, i) => live(i + 1)), [1, 3, 9, 11, 15, 20, 55, 99]);
  const v = e.read(); assert.equal(v.items.length, 100); assert.equal(v.prices.length, 8);
  assert.deepEqual(v.items.map(x => x.key), Array.from({length: 100}, (_, i) => key(i + 1)));
  assert.deepEqual(Object.keys(v), ['items', 'prices', 'hiddenFilters', 'hoverFreeze']);
  assert.deepEqual(v.prices.find(x => x.key === key(1)), {key: key(1), address: key(1).split(':')[0], networkId: 4663,
    price: 2, totalSupply: 100, change24Percent: -25, chartOverride: false});
  assert.equal(v.hiddenFilters, true); assert.equal(v.hoverFreeze, true);
});
test('committed alternate is selected, stale and pending props are refused', () => {
  const e = env(), stale = fiber({account: 'DO NOT READ'}, 5);
  stale.return = e.rootFiber; stale.alternate = e.anchor; e.anchor.alternate = stale; e.host.__reactFiber$test = stale;
  assert.equal(e.read().items.length, 1);
  stale.alternate = null; assert.equal(e.read(), null);
  e.host.__reactFiber$test = e.anchor;
  e.list.pendingProps = {...e.list.memoizedProps, data: []}; assert.equal(e.read(), null);
});
test('Arc 5042 descriptors are recognized without merging same-address chains', () => {
  const arc={source:'live',key:key(1).replace(':4663',':5042'),topicKey:'trending_tokens:4663,5042'};
  const e=env([arc,{...live(1),topicKey:arc.topicKey}],[]),v=e.read();
  assert.deepEqual(v.items.map(r=>r.networkId),[5042,4663]);
  assert.equal(v.items[0].address,v.items[1].address);assert.notEqual(v.items[0].key,v.items[1].key);
  assert.equal(e.calls.network,0);
});
test('snapshot frozen fallback is allowlisted; unsafe snapshot price overlay omitted', () => {
  const raw = {priceUSD: '3', change24: '-0.4', token: {address: key(1).split(':')[0], networkId: 4663,
    symbol: 'X', name: 'Frozen', info: {totalSupply: '10'}}};
  Object.defineProperty(raw, 'account', {get() { throw new Error('private read'); }});
  const d = {source: 'snapshot', key: key(1), token: raw}, e = env([d], []);
  assert.deepEqual(e.read().items[0].snapshot, {price: 3, totalSupply: 10, change24Percent: -40, symbol: 'X', name: 'Frozen'});
  assert.deepEqual(e.read().prices, []);
  raw.token.address = key(2).split(':')[0]; assert.equal(e.read(), null);
});
test('source, key, topic, chain and duplicate validation', () => {
  for (const d of [{...live(1), source: 'unknown'}, {...live(1), key: `${key(1)}junk`},
    {...live(1), topicKey: 'graduated_tokens:4663'}, {...live(1), topicKey: 'trending_tokens:1'},
    {...live(1), topicKey: 'trending_tokens:4663,4663'}, {...live(1), topicKey: 'trending_tokens:04663'}]) assert.equal(env([d], []).read(), null);
  assert.equal(env([live(1), live(1)], []).read(), null);
  assert.equal(env([live(1), {...live(2), topicKey: 'trending_tokens:4663'}], []).read(), null);
  const e = env(); e.rows[0].row.memoizedProps.chainId = 1; assert.equal(e.read(), null);
  const f = env(); f.rows[0].bridge.memoizedProps.topicKey = 'trending_tokens:1'; assert.equal(f.read(), null);
});
test('SOL case is preserved and exact snapshot parent correlation required', () => {
  const address = '6ssGtD5KUhzrENtn5BiEdTt4tcb6sfn7wPHRJyBYsp7N';
  const d = {source: 'snapshot', key: `${address}:1399811149`, token: {token: {address, networkId: 1399811149}}};
  const e = env([d], []); assert.equal(e.read().items[0].address, address);
  d.token.token.address = address.toLowerCase(); assert.equal(e.read(), null);
});
test('unknown and negative metrics remain null, negative changes preserved', () => {
  const e = env(), p = e.rows[0].price.memoizedProps;
  for (const value of [undefined, null, '', 'NaN', Infinity, {}, true, '-1', '0x10', ' 2 ']) {
    p.priceUSD = value; p.totalSupply = value;
    const v = e.read(); assert.equal(v.prices[0].price, null); assert.equal(v.prices[0].totalSupply, null);
  }
  p.priceUSD = 0; p.totalSupply = 0; p.change24 = undefined;
  assert.equal(e.read().prices[0].price, 0); assert.equal(e.read().prices[0].change24Percent, null);
});
test('I1 chartPrice provenance and reset on each capture', () => {
  const e = env(), {bridge, price} = e.rows[0];
  bridge.memoizedProps.chartPrice = 5; price.memoizedProps.priceUSD = '5';
  assert.equal(e.read().prices[0].chartOverride, true);
  bridge.memoizedProps.chartPrice = undefined; assert.equal(e.read().prices[0].chartOverride, false);
  bridge.memoizedProps.chartPrice = 4; assert.equal(e.read(), null);
  bridge.memoizedProps.chartPrice = -1; assert.equal(e.read(), null);
  bridge.memoizedProps.chartPrice = null; children(e.wrapper, e.anchor); assert.deepEqual(e.read().prices, []);
});
test('conflicting wrapper arrays and multiple panels fail closed', () => {
  const e = env(); e.wrapper.memoizedProps = {...e.list.memoizedProps, data: [live(2)]}; e.wrapper.pendingProps = e.wrapper.memoizedProps;
  assert.equal(e.read(), null);
  const f = env(); children(f.rootFiber, f.panel, fiber({panel: {tab: 'tokens', tokenListType: 'trending'}})); assert.equal(f.read(), null);
  const h = env(); children(h.panel, h.list, fiber(h.list.memoizedProps)); assert.equal(h.read(), null);
});
test('structural cycles, traversal overflow and >100 descriptors refuse partial output', () => {
  assert.equal(env(Array.from({length: 101}, (_, i) => live(i + 1)), []).read(), null);
  const e = env(); e.anchor.sibling = e.anchor; assert.equal(e.read(), null);
  const f = env(); children(f.rootFiber, f.panel, ...Array.from({length: 20001}, () => fiber())); assert.equal(f.read(), null);
  const d = env(); d.dom.push(...Array.from({length: 12001}, () => ({isConnected: true}))); assert.equal(d.read(), null);
});
test('replacement/unmount clears overlay and committed root changes are followed', () => {
  const e = env(); e.host.isConnected = false; assert.equal(e.read(), null); e.host.isConnected = true;
  const replacement = fiber(null, 3); replacement.stateNode = e.root;
  e.root.current = replacement; assert.equal(e.read(), null);
  children(replacement, e.panel); assert.equal(e.read().items.length, 1);
});
test('mutation bursts schedule one shot; cleanup cancels all future callbacks', () => {
  const e = env(), cleanup = e.api.observe(() => e.calls.callback++);
  assert.equal(e.frames.size, 0); e.mutate(); e.mutate(); e.mutate(); assert.equal(e.frames.size, 1);
  e.flush(); assert.equal(e.calls.callback, 1); e.flush(); assert.equal(e.calls.callback, 1);
  e.mutate(); cleanup(); cleanup(); assert.equal(e.frames.size, 0); e.flush(); e.mutate(); assert.equal(e.calls.callback, 1);
  assert.equal(e.observers[0].active, false); assert.equal(e.calls.network, 0);
});
test('no native getter/hook/handler invocation, no network/timers/storage or read callback effects', () => {
  const e = env();
  for (const target of [e.panel, e.rows[0].row]) {
    Object.defineProperty(target, 'memoizedState', {get() { e.calls.native++; throw new Error('hooks'); }});
    for (const k of ['account', 'watchlists', 'friendHolders', 'onClick']) Object.defineProperty(target.memoizedProps, k, {get() { e.calls.native++; throw new Error('private'); }});
    target.type = () => { e.calls.native++; };
  }
  for (let i = 0; i < 10; i++) assert(e.read());
  assert.deepEqual(e.calls, {network: 0, native: 0, callback: 0});
});
test('snapshot mounted No is omitted without chart provenance', () => {
  const raw = {priceUSD: '3', token: {address: key(1).split(':')[0], networkId: 4663}};
  const e = env([{source: 'snapshot', key: key(1), token: raw}], [1]);
  e.rows[0].row.memoizedProps = {source: 'snapshot', token: raw, listType: 'trending'};
  e.rows[0].row.pendingProps = e.rows[0].row.memoizedProps;
  children(e.rows[0].row, e.rows[0].price);
  e.rows[0].price.memoizedProps.identity = raw.token.address;
  assert.equal(e.read().items[0].snapshot.price, 3); assert.deepEqual(e.read().prices, []);
});
test('extension-only mutations are ignored, native replacement still schedules', () => {
  const e = env(), cleanup = e.api.observe(() => e.calls.callback++);
  const own = {nodeType: 1, closest: () => ({})};
  e.mutate([{type: 'attributes', target: own}]);
  e.mutate([{type: 'childList', target: e.host, addedNodes: [own], removedNodes: []}]);
  assert.equal(e.frames.size, 0);
  e.mutate([{type: 'childList', target: e.host, addedNodes: [own, e.host], removedNodes: []}]);
  assert.equal(e.frames.size, 1); e.flush(); assert.equal(e.calls.callback, 1); cleanup();
});
test('portals/offscreen branches and disconnected row hosts provide no price overlay', () => {
  for (const tag of [4, 22, 23]) { const e = env(); e.rows[0].row.tag = tag; assert.deepEqual(e.read().prices, []); }
  const e = env(); e.rows[0].leaf.stateNode = {isConnected: false}; assert.deepEqual(e.read().prices, []);
});
console.log(`PASS ${passed} bounded production-source VM tests (no network)`);
