import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../page-bridge.js', import.meta.url), 'utf8');
class Element {
  constructor() { this.attrs = new Map(); this.style = {}; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  querySelector() { return null; }
}
const surface = new Element();
const cards = Array.from({length: 24}, () => {
  const card = new Element(), wrap = new Element();
  wrap.style.position = 'absolute'; wrap.parentElement = surface; card.parentElement = wrap;
  return card;
});
const context = vm.createContext({HTMLElement: Element, console,
  setAttribute: (el, k, v) => el?.setAttribute(k, v),
  document: {querySelectorAll(selector) {
    if (selector === 'tracker') return cards;
    if (selector.includes('[data-gdh-native-index]')) return [surface];
    if (selector.includes('[data-gdh-track-addr]')) return cards.filter(c => c.getAttribute('data-gdh-track-addr'));
    return [];
  }},
  HOLDING_ROW_SELECTOR:'holding', HOLDING_PANEL_SELECTOR:'panel', TRACKER_ITEM_SELECTOR:'tracker',
  TRACKER_TABLE_ITEM_SELECTOR:'table', HOLDER_ROW_SELECTOR:'holder', CARD_SELECTOR:'card',
  CALLOUT_SELECTOR:'callout', MANIFESTO_SELECTOR:'manifesto',
  scanHoldingRow(){}, scanHolderRow(){}, scanCard(){}, scanCallerElement(){},
});
vm.runInContext(`let scanScheduled, scanRafId; ${source.slice(source.indexOf('  function trackerRoute('), source.indexOf('  function scanHoldingRow('))}
${source.slice(source.indexOf('  function scanCards()'), source.indexOf('  function runScheduledScan()'))}
this.scan = scanCards; this.read = readTrackerRecord;`, context);
const trade = (i, generation = 0) => ({token_address:'0x'+'3'.repeat(40), maker:'same-maker', side:'buy', chain:'eth',
  timestamp:1789244000 - i * 10 + generation, transaction_hash:`tx-${generation}-${i}`});
const root = {};
function tree(generation) {
  const rows = Array.from({length:100}, (_, i) => trade(i, generation));
  const top = {stateNode:root};
  const list = {return:top, memoizedProps:{rows}}; top.child = list;
  const hosts = cards.map((card, i) => ({stateNode:card, memoizedProps:{},
    pendingProps:{trade:trade(99, 999)}, return:null}));
  const parents = hosts.map((host, i) => {
    const parent = {return:list, memoizedProps:{trade:rows[i]}, child:host}; host.return = parent; return parent;
  });
  parents.forEach((p, i) => { p.sibling = parents[i+1]; }); list.child = parents[0];
  return {top, list, rows, hosts, parents};
}
const a = tree(0), b = tree(1);
a.top.alternate = b.top; b.top.alternate = a.top;
a.hosts.forEach((host, i) => {host.alternate = b.hosts[i]; b.hosts[i].alternate = host; cards[i].__reactFiber$test = host;});
function check(t) {
  context.scan();
  cards.forEach((c, i) => {
    assert.equal(c.getAttribute('data-gdh-track-ts'), String(t.rows[i].timestamp * 1000), `row ${i} committed timestamp`);
    assert.equal(c.getAttribute('data-gdh-track-tx'), t.rows[i].transaction_hash);
  });
  assert.deepEqual(JSON.parse(surface.getAttribute('data-gdh-native-index')), t.rows.map(r => r.timestamp * 1000));
  assert.deepEqual(JSON.parse(surface.getAttribute('data-gdh-native-rows')).map(r => r.tx), t.rows.map(r => r.transaction_hash));
}
root.current = a.top; check(a);
root.current = b.top; check(b);
root.current = a.top; check(a);
// Bailout shares the host object; its .return deliberately still leads to A.
const shared = tree(2);
shared.parents.forEach((p, i) => {p.child = a.hosts[i];});
root.current = shared.top; check(shared);
// Stable host pool changes logical rows without changing token or maker.
for (const start of [9, 23, 50, 0]) {
  shared.parents.forEach((p, i) => {p.memoizedProps = {trade:shared.rows[start+i]};});
  context.scan();
  cards.forEach((c, i) => assert.equal(c.getAttribute('data-gdh-track-ts'), String(shared.rows[start+i].timestamp * 1000)));
  assert.deepEqual(JSON.parse(surface.getAttribute('data-gdh-native-index')), shared.rows.map(r => r.timestamp * 1000));
}
// Liquidity actions occupy genuine native slots; never borrow a neighbouring buy.
shared.rows[9].side='add';shared.rows[23].side='remove';check(shared);
assert.equal(cards[9].getAttribute('data-gdh-track-side'),'add');
assert.equal(cards[23].getAttribute('data-gdh-track-side'),'remove');
// Committed host with no identity must not borrow pending/alternate/list data.
shared.parents.forEach(p => {p.memoizedProps = {};});
context.scan();
for (const card of cards) for (const attr of ['addr','ts','tx','maker','side']) assert.equal(card.getAttribute(`data-gdh-track-${attr}`), null);
assert.equal(surface.getAttribute('data-gdh-native-index'), null);
assert.equal(surface.getAttribute('data-gdh-native-rows'), null);
// Detached hosts and fake no-root fibers fail closed and remove prior stamps.
root.current = {stateNode:root};
cards[0].setAttribute('data-gdh-track-ts', 'old'); context.scan();
assert.equal(cards[0].getAttribute('data-gdh-track-ts'), null);
cards[0].__reactFiber$test = {memoizedProps:{trade:trade(0)}};
assert.equal(context.read(cards[0], new Map()), null);
cards[0].__reactFiber$test = a.hosts[0];
// Bounded traversal rejects cyclic and over-budget trees, without partial data.
root.current = a.top; a.list.sibling = a.list;
assert.equal(context.read(cards[0], new Map()), null); delete a.list.sibling;
let chain = a.top;
for (let i=0;i<100001;i++) chain = {child:chain};
root.current = chain;
assert.equal(context.read(cards[0], new Map()), null);
// A single root traversal serves every card in a scan, even beyond 20k fibers.
let visits = 0;
chain = shared.top;
for (let i=0;i<21000;i++) { const child = chain; chain = {get child(){visits++; return child;}}; }
root.current = chain;
shared.parents.forEach((p, i) => {p.memoizedProps = {trade:shared.rows[i]};});
check(shared);
assert.equal(visits, 42000, 'one traversal (two child reads per node), not per card');
console.log('PASS committed tracker: alternate commits, shared stale-return hosts, stable repeated-token pool, parent index, fail-closed bounds, one traversal per scan');
