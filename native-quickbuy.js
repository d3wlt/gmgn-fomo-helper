(() => {
  'use strict';
  // MAIN-world adapter. No trading API, credentials, copied callbacks or amounts.
  // GMGN owns execution and settings. Only the real native component handles input.
  const SELECTOR = '.gdh-native-buy-host';
  const MODULES = { react: 14232, dom: 524279, quick: 278695 };
  let runtime = null;
  let active = null;
  let generation = 0;

  function identity(host) {
    const card = host.closest('.gdh-fomofeed');
    if (!card || !card.isConnected || card.dataset.gdhFomoStale === '1') return null;
    const chain = host.dataset.chain || '', address = host.dataset.address || '';
    if (!['sol', 'eth', 'bsc', 'base'].includes(chain)) return null;
    if (!(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(address)) return null;
    if (!host.dataset.eventKey || host.dataset.eventKey !== card.dataset.gdhFomoKey) return null;
    return { chain, address, symbol: host.dataset.symbol || '', logo: host.dataset.logo || '', key: host.dataset.eventKey };
  }
  const signature = value => value && JSON.stringify(value);

  function nativeContext() {
    const native = document.querySelector('[data-sentry-component="TrackerListItem"]');
    if (!native) return null;
    const key = Object.keys(native).find(k => k.startsWith('__reactFiber$'));
    let f = native[key];
    let top = f;
    while (top?.return) top = top.return;
    let route = [];
    if (top?.stateNode?.current) {
      // Bailouts can share a host fiber across trees with an old .return pointer.
      // Walk the committed tree and retain its ACTUAL ancestry, not f.alternate.
      const stack = [{ fiber: top.stateNode.current, parent: null }];
      for (let visited = 0; stack.length && visited < 20000; visited++) {
        const node = stack.pop(), current = node.fiber;
        if (current.stateNode === native) {
          for (let n = node; n; n = n.parent) route.push(n.fiber);
          break;
        }
        if (current.sibling) stack.push({ fiber: current.sibling, parent: node.parent });
        if (current.child) stack.push({ fiber: current.child, parent: node });
      }
    } else {
      for (let i = 0; f && i < 150; i++, f = f.return) route.push(f);
    }
    const out = [], seen = new Set();
    for (const f of route) {
      const t = f.type;
      const context = t?._context || (t?.$$typeof === Symbol.for('react.context') ? t : null);
      if (context && f.memoizedProps && Object.hasOwn(f.memoizedProps, 'value') && !seen.has(context)) {
        seen.add(context); out.push([context, f.memoizedProps.value]);
      }
    }
    return out.length ? out : null;
  }
  function sameContexts(a, b) {
    return !!a && !!b && a.length === b.length && a.every(([c, v], i) => c === b[i][0] && Object.is(v, b[i][1]));
  }
  function loadRuntime() {
    if (runtime) return runtime;
    const chunks = window.webpackChunk_N_E;
    if (!Array.isArray(chunks)) return null;
    // Pin the observed component contract; fail closed on missing/changed bundles.
    const factories = new Map();
    for (const chunk of chunks) for (const [id, fn] of Object.entries(chunk[1] || {})) factories.set(Number(id), fn);
    const quickSource = String(factories.get(MODULES.quick) || '');
    if (!quickSource.includes('data-testid') || !quickSource.includes('quickbuy') || !quickSource.includes('QuickBuy')
      || !quickSource.includes('tokenInfo') || !quickSource.includes('buyType')) return null;
    if (!factories.has(MODULES.react) || !factories.has(MODULES.dom)) return null;
    let require;
    chunks.push([[`gdh-native-buy-${Date.now()}`], {}, r => { require = r; }]);
    if (typeof require !== 'function') return null;
    const React = require(MODULES.react), DOM = require(MODULES.dom), QuickBuy = require(MODULES.quick).A;
    if (typeof React?.createElement !== 'function' || typeof DOM?.createRoot !== 'function' || !QuickBuy) return null;
    runtime = { React, DOM, QuickBuy };
    return runtime;
  }
  function unavailable(host, message = 'Native quick buy unavailable. Open the token page instead.') {
    host.dataset.state = 'unavailable'; host.title = message;
    host.textContent = 'Buy unavailable';
  }
  function dispose() {
    generation++;
    if (!active) return;
    const old = active; active = null;
    old.observer.disconnect();
    old.root.unmount();
    old.host.replaceChildren(); old.host.textContent = 'Buy'; old.host.dataset.state = 'idle';
  }
  function mount(host) {
    const value = identity(host), contexts = nativeContext();
    if (active?.host === host && active.signature === signature(value) && sameContexts(active.contexts, contexts)) return;
    dispose();
    if (!value || !contexts) { unavailable(host); return; }
    let api;
    try { api = loadRuntime(); } catch { api = null; }
    if (!api) { unavailable(host); return; }
    const { React, DOM, QuickBuy } = api;
    const ticket = generation;
    host.replaceChildren(); host.dataset.state = 'loading';
    const root = DOM.createRoot(host);
    class Guard extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch() { if (ticket === generation) host.dataset.state = 'unavailable'; }
      render() { return this.state.failed ? React.createElement('span', null, 'Buy unavailable') : this.props.children; }
    }
    // Explicit identity ONLY. Never spread donor props or copy its onClick closure.
    let element = React.createElement(QuickBuy, {
      network: value.chain,
      tokenInfo: { address: value.address, symbol: value.symbol, logo: value.logo },
      buyType: 'follow', isSmall: true, h: '24px',
    });
    element = React.createElement(Guard, null, element);
    for (const [context, providerValue] of contexts) element = React.createElement(context.Provider, { value: providerValue }, element);
    const observer = new MutationObserver(() => {
      if (active?.host !== host) return;
      if (!host.isConnected || signature(identity(host)) !== active.signature) dispose();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    observer.observe(host, { attributes: true });
    observer.observe(host.closest('.gdh-fomofeed'), { attributes: true, attributeFilter: ['data-gdh-fomo-key', 'data-gdh-fomo-stale'] });
    active = { host, root, contexts, signature: signature(value), observer, armedAt: performance.now() + 350 };
    root.render(element);
    host.dataset.state = 'ready';
    host.title = `Native GMGN quick buy · ${value.chain} · ${value.symbol || value.address}. Uses GMGN Following buy settings.`;
  }
  document.addEventListener('pointerover', event => {
    const host = event.target.closest?.(SELECTOR);
    if (host && event.isTrusted) mount(host);
  }, true);
  document.addEventListener('focusin', event => {
    const host = event.target.closest?.(SELECTOR);
    if (host && event.isTrusted) mount(host);
  }, true);
  // A stale identity/context must NEVER execute. Block this gesture; next hover
  // rebinds with fresh native context. Native handles pointer/click dedup itself.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown']) {
    document.addEventListener(type, event => {
      if (type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      const host = event.target.closest?.(SELECTOR);
      if (!host) return;
      // Let the user see a newly bound token/account before any gesture executes.
      if (active?.host === host && performance.now() < active.armedAt) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (!event.isTrusted || active?.host !== host || !host.querySelector('[data-testid="quickbuy"]')
        || active.signature !== signature(identity(host)) || !sameContexts(active.contexts, nativeContext())) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.isTrusted) { dispose(); unavailable(host, 'Context changed. Move away and hover again before buying.'); }
      }
    }, true);
  }
  window.addEventListener('pagehide', dispose);
})();
