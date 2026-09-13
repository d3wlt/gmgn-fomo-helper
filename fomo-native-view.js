(() => {
  'use strict';
  // MAIN-world only (manifest must enforce world: MAIN). No native code is executed.
  // Verified public authenticated-v2-BVad9-j9.js: v1 -> jl data=fe after Lc;
  // x1 -> R1 -> So(liveToken, tokenAddress, chainId) -> I1(chartPrice) -> No.
  // I1 uses chartPrice?.toString() ?? priceUSD; No displays change24 * 100.
  // Unknown builds, noncanonical snapshot keys and ambiguous panels fail closed.
  // Offscreen prices and DOM-silent React commits are not guaranteed observable.
  if (location.origin !== 'https://fomo.family' || window.top !== window ||
      Object.getOwnPropertyDescriptor(window, '__gdhFomoNativeView')) return;
  const LIMIT = 20000, DOM_LIMIT = 12000, DEPTH = 256;
  const networks = new Set([1, 56, 8453, 143, 4663, 1399811149]);
  // Read data properties only: public props must never execute page getters/selectors.
  const g = (o, k) => o && Object.getOwnPropertyDescriptor(o, k)?.value;
  const fail = () => { throw new Error('unavailable'); };
  const metric = (v, signed = false) => {
    if (typeof v !== 'number' && (typeof v !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v) || v.length > 80)) return null;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER && (signed || n >= 0) ? n : null;
  };
  const change = v => { const n = metric(v, true); return n === null ? null : metric(n * 100, true); };
  const text = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : '';
  function identity(key) {
    if (typeof key !== 'string' || key.length > 65) fail();
    const parts = key.split(':'), address = parts[0], networkId = Number(parts[1]);
    if (parts.length !== 2 || String(networkId) !== parts[1] || !networks.has(networkId) ||
        !(networkId === 1399811149 ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(address)) fail();
    return {key, address, networkId};
  }
  function topic(value, networkId) {
    if (typeof value !== 'string' || value.length > 100 || !/^trending_tokens:[0-9]+(?:,[0-9]+)*$/.test(value)) fail();
    const ids = value.slice(16).split(',');
    if (new Set(ids).size !== ids.length || ids.some(n => !networks.has(Number(n)) || String(Number(n)) !== n) || !ids.includes(String(networkId))) fail();
    return value;
  }
  function descriptor(d) {
    const id = identity(g(d, 'key')), source = g(d, 'source');
    let snapshot = null, topicKey = null;
    if (source === 'live') topicKey = topic(g(d, 'topicKey'), id.networkId);
    else if (source === 'snapshot') {
      const raw = g(d, 'token'), token = g(raw, 'token');
      if (g(token, 'address') !== id.address || g(token, 'networkId') !== id.networkId) fail();
      snapshot = {price: metric(g(raw, 'priceUSD')), totalSupply: metric(g(g(token, 'info'), 'totalSupply')),
        change24Percent: change(g(raw, 'change24')), symbol: text(g(token, 'symbol')), name: text(g(token, 'name'))};
    } else fail();
    return {item: {key: id.key, address: id.address, networkId: id.networkId, snapshot}, source, topicKey};
  }
  function props(f) {
    const p = g(f, 'memoizedProps');
    if (g(f, 'pendingProps') !== p) fail();
    return p;
  }
  const isPanel = p => g(g(p, 'panel'), 'tab') === 'tokens' && g(g(p, 'panel'), 'tokenListType') === 'trending';
  const isList = p => g(p, 'dataKey') === 'trending' && g(g(p, 'extraData'), 'listType') === 'trending';
  function capture() {
    const roots = new Map(), walker = document.createTreeWalker(document.documentElement, 1);
    let dom = document.documentElement, count = 0;
    while (dom) {
      if (++count > DOM_LIMIT) fail();
      const keys = Object.getOwnPropertyNames(dom);
      if (keys.length > 256) fail();
      for (const key of keys) if (key.startsWith('__reactFiber$')) {
        const seed = g(dom, key); let f = seed, depth = 0;
        while (g(f, 'return')) { if (++depth > DEPTH) fail(); f = g(f, 'return'); }
        if (g(f, 'tag') === 3) {
          const root = g(f, 'stateNode'), current = g(root, 'current');
          if (!current || g(current, 'tag') !== 3 || g(current, 'stateNode') !== root) fail();
          if (!roots.has(root)) roots.set(root, {current, seeds: []});
          roots.get(root).seeds.push({seed, dom});
        }
      }
      dom = walker.nextNode();
    }
    if (!roots.size || roots.size > 8) fail();
    let budget = 0; const panels = [], trees = [];
    for (const [root, record] of roots) {
      const nodes = [], parents = new Map(), mounted = new Set(), seen = new Set();
      const stack = [[record.current, null, 0]];
      while (stack.length) {
        const [f, parent, depth] = stack.pop();
        if (!f || seen.has(f) || ++budget > LIMIT || depth > DEPTH) fail();
        seen.add(f); parents.set(f, parent); nodes.push(f);
        // Portals and offscreen branches are not the mounted native list boundary.
        if ([4, 22, 23].includes(g(f, 'tag'))) continue;
        const p = g(f, 'memoizedProps');
        if (isPanel(p)) { props(f); panels.push({f, nodes, parents, mounted}); }
        const host = g(f, 'stateNode');
        if (g(f, 'tag') === 5 && host?.isConnected && document.documentElement.contains(host)) mounted.add(f);
        let child = g(f, 'child'), siblings = new Set();
        while (child) {
          if (siblings.has(child) || siblings.size >= LIMIT) fail();
          siblings.add(child); stack.push([child, f, depth + 1]); child = g(child, 'sibling');
        }
      }
      if (!record.seeds.some(({seed, dom: el}) => el.isConnected &&
          ((seen.has(seed) && g(seed, 'stateNode') === el) ||
           (seen.has(g(seed, 'alternate')) && g(g(seed, 'alternate'), 'stateNode') === el)))) fail();
      for (let i = nodes.length - 1; i >= 0; i--) if (mounted.has(nodes[i]) && parents.get(nodes[i])) mounted.add(parents.get(nodes[i]));
      trees.push({root, current: record.current});
    }
    if (panels.length !== 1) fail();
    const {f: panel, nodes, parents, mounted} = panels[0];
    if (!mounted.has(panel)) fail();
    for (let f = panel; f; f = parents.get(f)) props(f);
    const below = (f, ancestor) => { let n = 0; while (f && f !== ancestor) { if (++n > DEPTH) fail(); f = parents.get(f); } return f === ancestor; };
    const lists = nodes.filter(f => below(f, panel) && isList(g(f, 'memoizedProps')));
    if (lists.length > 16) fail();
    const outer = lists.filter(f => !lists.some(other => other !== f && below(f, other)));
    if (outer.length !== 1 || !mounted.has(outer[0])) fail();
    let entries = null, signature = null;
    for (const f of lists) {
      for (let ancestor = f; ancestor && ancestor !== panel; ancestor = parents.get(ancestor)) props(ancestor);
      const data = g(props(f), 'data');
      if (!Array.isArray(data) || data.length > 100) fail();
      const parsed = Array.from({length: data.length}, (_, i) => descriptor(g(data, String(i))));
      const sig = JSON.stringify(parsed);
      if (signature !== null && sig !== signature) fail();
      signature = sig; if (f === outer[0]) entries = parsed;
    }
    const byKey = new Map(), canonical = new Set(), topics = new Set();
    for (const entry of entries) {
      const {key, address, networkId} = entry.item;
      const dedupe = `${networkId}:${networkId === 1399811149 ? address : address.toLowerCase()}`;
      if (canonical.has(dedupe)) fail(); canonical.add(dedupe); byKey.set(key, entry);
      if (entry.topicKey) topics.add(entry.topicKey);
    }
    if (topics.size > 1) fail();
    const prices = [], priced = new Set();
    for (const f of nodes) {
      if (!below(f, outer[0]) || !mounted.has(f)) continue;
      const p = g(f, 'memoizedProps');
      if (g(p, 'listType') !== 'trending' || g(p, 'identity') === undefined ||
          !Object.getOwnPropertyDescriptor(p, 'priceUSD')) continue;
      for (let ancestor = f; ancestor && ancestor !== outer[0]; ancestor = parents.get(ancestor)) props(ancestor);
      let row = parents.get(f), bridge = null, steps = 0;
      while (row && row !== outer[0]) {
        if (++steps > DEPTH) fail();
        const rp = g(row, 'memoizedProps');
        if (g(rp, 'listType') === 'trending' && Object.getOwnPropertyDescriptor(rp, 'chartPrice') && g(rp, 'tokenKey')) {
          if (bridge) fail(); bridge = props(row);
        }
        if (g(rp, 'source') === 'live' || g(rp, 'source') === 'snapshot') break;
        row = parents.get(row);
      }
      if (!row || row === outer[0]) fail();
      const rp = props(row);
      // Snapshot No has no I1 chartPrice provenance. Keep allowlisted fallback only;
      // never label a snapshot final price as a proven non-override.
      if (g(rp, 'source') === 'snapshot') continue;
      const live = g(rp, 'liveToken'), key = g(live, 'tokenKey'), entry = byKey.get(key);
      if (!entry || entry.source !== 'live' || !bridge || g(rp, 'listType') !== 'trending' ||
          g(rp, 'tokenAddress') !== entry.item.address || g(rp, 'chainId') !== entry.item.networkId ||
          g(live, 'topicKey') !== entry.topicKey || g(bridge, 'tokenKey') !== key ||
          g(bridge, 'topicKey') !== entry.topicKey || g(p, 'identity') !== key || priced.has(key)) fail();
      const chart = g(bridge, 'chartPrice'), price = metric(g(p, 'priceUSD'));
      const chartOverride = chart !== null && chart !== undefined;
      if (chartOverride && (typeof chart !== 'number' || metric(chart) === null || chart <= 0 || chart !== price)) fail();
      priced.add(key);
      prices.push({key, address: entry.item.address, networkId: entry.item.networkId, price,
        totalSupply: metric(g(p, 'totalSupply')), change24Percent: change(g(p, 'change24')), chartOverride});
    }
    for (const {root, current} of trees) if (g(root, 'current') !== current) fail();
    return {items: entries.map(e => e.item), prices, hiddenFilters: true, hoverFreeze: true};
  }
  function read() { try { return capture(); } catch { return null; } }
  function observe(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    let active = true, frame = null;
    const selfSelector = '.gdh-notification-launcher, .gdh-notification-panel, .gdh-fomo, .gdh-fomo-panel, .gdh-fomo-ui, .gdh-fomo-feed-gap, .gdh-fomofeed-lane, .gdh-tooltip, .gdh-tokenblock, [id^="gdh-fomo-name-tip-"]';
    const ownNode = node => {
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      return !!el?.closest(selfSelector);
    };
    const ownRecord = record => {
      if (ownNode(record.target)) return true;
      if (record.type !== 'childList') return false;
      const added = record.addedNodes, removed = record.removedNodes;
      const length = (added?.length || 0) + (removed?.length || 0);
      if (!length || length > 200) return false;
      for (const collection of [added, removed]) if (collection) for (const node of collection) if (!ownNode(node)) return false;
      return true;
    };
    const observer = new MutationObserver(records => {
      if (!active || !records.length || frame !== null) return;
      if (records.length <= 1000 && records.every(ownRecord)) return;
      // Parent owns stream/event coalescing. No recurring frame, timers or native events.
      frame = requestAnimationFrame(() => { frame = null; if (active) callback(); });
    });
    // Document scope is needed for root/panel replacement; only structural/text and
    // virtualization attributes, not arbitrary attribute traffic. Callback does not read.
    observer.observe(document, {subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden']});
    return () => { active = false; observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); frame = null; };
  }
  Object.defineProperty(window, '__gdhFomoNativeView', {value: Object.freeze({read, observe}), writable: false, configurable: false});
})();
