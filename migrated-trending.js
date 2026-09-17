// ISOLATED world only. Fed exclusively by content.js's validated owned runtime port.
// No page events, transport, storage, or independent demand.
(() => {
  'use strict';
  globalThis.gdhCreateMigratedTrending = ({ref, eligible, asset}) => {
    const selector = '[data-testid="trenchesCompleted"] div[data-testid="trench-token-card"][href]';
    const badges = new Map(), watched = new Set();
    let members = new Set(), deadline = 0, timer = null, frame = null, observing = false;
    const observer = new MutationObserver(() => schedule());
    const resize = new ResizeObserver(() => schedule());
    function clear() {
      members.clear(); deadline = 0;
      clearTimeout(timer); timer = null;
      clearInterval(routeTimer); routeTimer = null;
      cancelAnimationFrame(frame); frame = null;
      observer.disconnect(); resize.disconnect(); watched.clear(); observing = false;
      for (const badge of badges.values()) badge.remove();
      badges.clear();
    }
    // Read-only native identity: the route alone is insufficient during SPA swaps.
    // Require the header's full CA AND its chain-specific explorer link to agree.
    const explorerChains = new Map([
      ['solscan.io','sol'], ['bscscan.com','bsc'], ['basescan.org','base'], ['etherscan.io','eth'],
      ['monadscan.com','monad'], ['monadvision.com','monad'],
      ['testnet.arcscan.app','arc'], ['arcscan.app','arc'], ['rh-scan.com','robinhood']
    ]);
    let routeTimer = null, route = location.pathname;
    function tokenHeader(retained, current) {
      const match = location.pathname.match(/^\/([a-z0-9]+)\/token\/([A-Za-z0-9]+)\/?$/);
      const identity = match && ref(match[1], match[2]);
      if (!identity || !members.has(identity.key)) return;
      for (const address of document.querySelectorAll('#token-base-address[data-addr]')) {
        const info = address.parentElement?.parentElement?.parentElement;
        const symbol = info?.querySelector('[data-testid="token-detail-symbol"]');
        const row = symbol?.closest('[data-sentry-component="TooltipCopy"]')?.parentElement?.parentElement;
        const controls = row?.querySelector('[data-sentry-component="TokenMarkEditButton"]')?.parentElement?.parentElement;
        const headerRef = ref(match[1], address.getAttribute('data-addr'));
        if (!row || !controls || !headerRef || headerRef.key !== identity.key || getComputedStyle(controls).position !== 'relative') continue;
        const confirmed = [...info.querySelectorAll('[data-sentry-component="BaseLinkView"] a[href]')].some(link => {
          try {
            const url = new URL(link.href);
            const ca = url.pathname.match(/^\/(?:token|address)\/([A-Za-z0-9]+)\/?$/)?.[1];
            const nativeRef = ca && ref(explorerChains.get(url.hostname), ca);
            return url.protocol === 'https:' && nativeRef?.key === identity.key;
          } catch { return false; }
        });
        if (!confirmed) continue;
        for (const node of [info,row,controls]) { current.add(node); if (!watched.has(node)) { watched.add(node); resize.observe(node); } }
        const rr = row.getBoundingClientRect(), cr = controls.getBoundingClientRect();
        const children = [...row.children].map(n => n.getBoundingClientRect()).filter(r => r.width && r.height);
        const left = Math.max(rr.left, ...children.map(r => r.right)) + 6;
        const top = rr.top + (rr.height - 20) / 2;
        if (!row.checkVisibility({checkVisibilityCSS:true}) || rr.height < 20 || left + 82 > Math.min(rr.right, innerWidth) || top < 0) continue;
        // Fail closed on clipped native scroll containers; never widen their content.
        let fits = true;
        for (let n = row; n && n !== document.body; n = n.parentElement) {
          const style = getComputedStyle(n), r = n.getBoundingClientRect();
          if ((style.overflowX !== 'visible' && (left < r.left || left + 82 > r.right)) || (style.overflowY !== 'visible' && (top < r.top || top + 20 > r.bottom))) { fits = false; break; }
        }
        if (!fits) continue;
        let badge = badges.get(controls);
        if (!badge || !badge.isConnected) {
          badge = document.createElement('span'); badge.className = 'gdh-token-trending';
          badge.setAttribute('aria-label', 'FOMO Trending');
          const eyes = document.createElement('img'); eyes.src = asset; eyes.alt = ''; eyes.width = 19; eyes.height = 13;
          badge.append(eyes, document.createTextNode('Trending')); controls.append(badge); badges.set(controls, badge);
        }
        badge.style.left = `${left - cr.left - controls.clientLeft}px`;
        badge.style.top = `${top - cr.top - controls.clientTop}px`;
        retained.add(controls);
      }
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(scan); }
    function scan() {
      frame = null;
      if (!eligible() || Date.now() >= deadline) { clear(); return; }
      observer.disconnect();
      const retained = new Set(), current = new Set();
      for (const card of document.querySelectorAll(selector)) {
        const match = card.getAttribute('href').match(/^\/([a-z0-9]+)\/token\/([A-Za-z0-9]+)\/?$/);
        const identity = match && ref(match[1], match[2]);
        if (!identity || !members.has(identity.key)) continue;
        const name = card.querySelector('[data-sentry-component="TooltipCopy"]');
        const row = name?.parentElement;
        if (!row || !row.querySelector('[data-sentry-component="TokenMarkEditButton"]') || getComputedStyle(card).position !== 'relative') continue;
        for (const node of [card,row]) { current.add(node); if (!watched.has(node)) { watched.add(node); resize.observe(node); } }
        const cr = card.getBoundingClientRect(), rr = row.getBoundingClientRect();
        // Overlay only genuinely unused trailing space. Never shrink/truncate names,
        // move controls, change a host style, or change virtualizer geometry.
        const children = [...row.children].map(n => n.getBoundingClientRect()).filter(r => r.width && r.height);
        const left = Math.max(rr.left, ...children.map(r => r.right)) + 6;
        if (!card.checkVisibility() || rr.height < 20 || left + 82 > Math.min(rr.right, cr.right) || rr.top < cr.top || rr.top + 20 > cr.bottom) continue;
        let badge = badges.get(card);
        if (!badge || !badge.isConnected) {
          badge = document.createElement('span'); badge.className = 'gdh-migrated-trending';
          badge.setAttribute('aria-label', 'FOMO Trending');
          const eyes = document.createElement('img'); eyes.src = asset; eyes.alt = ''; eyes.width = 19; eyes.height = 13;
          badge.append(eyes, document.createTextNode('Trending')); card.append(badge); badges.set(card, badge);
        }
        // Native card is the positioned containing block; account for its border.
        badge.style.left = `${left - cr.left - card.clientLeft}px`;
        badge.style.top = `${rr.top - cr.top - card.clientTop}px`;
        retained.add(card);
      }
      tokenHeader(retained, current);
      for (const [card, badge] of badges) if (!retained.has(card)) { badge.remove(); badges.delete(card); }
      for (const node of watched) if (!current.has(node)) { resize.unobserve(node); watched.delete(node); }
      observer.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['href','class','style','hidden','data-testid','data-addr']});
      observing = true;
    }
    function update(data) {
      clear();
      const now = Date.now();
      if (!eligible() || !data?.ok || data.status !== 'live' || data.stale || !Number.isFinite(data.fetchedAt) || data.fetchedAt > now || now - data.fetchedAt >= 60000) return;
      for (const item of data.items) {
        const identity = item && ref(item.chain, item.address);
        if (identity) members.add(identity.key);
      }
      if (!members.size) return;
      deadline = data.fetchedAt + 60000;
      timer = setTimeout(clear, Math.max(0, deadline - now));
      route = location.pathname;
      // pushState in the page world need not emit a DOM mutation or popstate.
      // Read only while a fresh source is owned; do not patch native history.
      routeTimer = setInterval(() => { if (route !== location.pathname) { route = location.pathname; schedule(); } }, 100);
      scan();
    }
    window.addEventListener('resize', () => { if (observing) schedule(); });
    window.addEventListener('popstate', () => { if (observing) schedule(); });
    document.addEventListener('scroll', () => { if (observing) schedule(); }, true);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') clear(); });
    return Object.freeze({update, clear});
  };
})();
