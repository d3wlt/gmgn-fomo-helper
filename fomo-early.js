(() => {
  'use strict';

  //
  if (window.__gdhFomoEarly) return;
  window.__gdhFomoEarly = true;

  const jwtExpMs = (token) => {
    try {
      const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
    } catch {
      return 0;
    }
  };
  const unwrap = (raw) => {
    if (!raw) return '';
    let value = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') value = parsed;
    } catch {
    }
    value = String(value || '').trim();
    return value.length > 20 ? value : '';
  };

  try {
    chrome.storage.local.get('fomoToken', (stored) => {
      try {
        const cur = stored?.fomoToken;
        if (!cur?.token || !cur.refresh) return;
        const keys = Object.keys(window.localStorage);
        const candidates = keys
          .filter((k) => /^privy:(.+:)?token$/.test(k))
          .map((tokenKey) => {
            const prefix = tokenKey.slice(0, -'token'.length);
            const token = unwrap(window.localStorage.getItem(tokenKey));
            return { tokenKey, refreshKey: `${prefix}refresh_token`, exp: jwtExpMs(token) };
          })
          .sort((a, b) => (b.exp || 0) - (a.exp || 0));
        const tokenKey = candidates[0]?.tokenKey || 'privy:token';
        const refreshKey = candidates[0]?.refreshKey || 'privy:refresh_token';
        const pageToken = unwrap(window.localStorage.getItem(tokenKey));
        const pageExp = pageToken ? jwtExpMs(pageToken) : 0;
        const curExp = Number(cur.exp) || jwtExpMs(cur.token);
        if (pageToken && pageExp >= curExp) return;
        const keep = (key, value) => {
          const raw = window.localStorage.getItem(key);
          const asJson = raw == null || /^"/.test(raw);
          window.localStorage.setItem(key, asJson ? JSON.stringify(value) : value);
        };
        keep(tokenKey, cur.token);
        keep(refreshKey, cur.refresh);
      } catch {
      }
    });
  } catch {
  }
})();
