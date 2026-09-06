(() => {
  'use strict';

  if (window.__gdhJ7SessionBridgeStarted) return;
  window.__gdhJ7SessionBridgeStarted = true;

  const isJ7Host = location.hostname === 'j7tracker.io';
  if (!isJ7Host) return;

  const readValue = (key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return '';
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'string' ? parsed.trim() : String(raw).trim();
      } catch {
        return String(raw).trim();
      }
    } catch {
      return '';
    }
  };

  let lastStamp = '';
  let syncInflight = false;

  const notifyBackground = () => {
    try {
      chrome.runtime.sendMessage({ type: 'j7tracker-session-updated' }, () => void chrome.runtime.lastError);
    } catch {
    }
  };

  const syncSession = () => {
    if (syncInflight) return;
    syncInflight = true;
    const token = readValue('sessionId').slice(0, 4096);
    const displayName = readValue('loggedInUser').slice(0, 100);
    const accountId = readValue('loggedInUserId').slice(0, 160) || displayName;
    const stamp = `${token}\n${accountId}\n${displayName}`;
    if (stamp === lastStamp) {
      syncInflight = false;
      return;
    }
    lastStamp = stamp;
    const at = Date.now();
    const patch = token
      ? {
          j7TrackerSessionV1: { token, accountId, displayName, at },
          j7TrackerSyncStateV1: { connected: false, reason: 'verifying', accountId, displayName, syncedAt: at },
        }
      : {
          j7TrackerSessionV1: null,
          j7TrackerSyncStateV1: { connected: false, reason: 'login-required', checkedAt: at },
        };
    try {
      chrome.storage.local.set(patch, () => {
        syncInflight = false;
        if (!chrome.runtime.lastError) notifyBackground();
      });
    } catch {
      syncInflight = false;
    }
  };

  syncSession();
  window.setInterval(syncSession, 5000);
  window.addEventListener('focus', syncSession);
  window.addEventListener('storage', syncSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncSession();
  });
})();
