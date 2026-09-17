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
      cancelAnimationFrame(frame); frame = null;
      observer.disconnect(); resize.disconnect(); watched.clear(); observing = false;
      for (const badge of badges.values()) badge.remove();
      badges.clear();
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
      for (const [card, badge] of badges) if (!retained.has(card)) { badge.remove(); badges.delete(card); }
      for (const node of watched) if (!current.has(node)) { resize.unobserve(node); watched.delete(node); }
      observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['href','class','style','hidden','data-testid']});
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
      scan();
    }
    window.addEventListener('resize', () => { if (observing) schedule(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') clear(); });
    return Object.freeze({update, clear});
  };
})();
