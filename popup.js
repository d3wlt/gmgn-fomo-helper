'use strict';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULTS = {
  enabled: true,
  debugLogging: false,
  showDevPerformance: true,
  showDevTooltip: true,
  enableDevBookmark: true,
  enableCalloutBlacklist: true,
  enableSpecialWallet: true,
  enableRemindAlert: true,
  enableFomoPanel: true,
  enableHoldingSurge: true,
  holdingSurgeThreshold: 20,
  holdingSurgeCooldown: 60,
  mergeFomoHolders: true,
  enableMarkedHolders: true,
  enableFomoFeed: true,
  enablePumpFeed: true,
  fomoFeedChainOnly: false,
  fomoFeedTypes: { buy: true, sell: true, thesis: true },
  markedHolders: [
    { address: '0x38e47fece3ea323e864c65410f6458c820eaa897', name: 'Cow' },
    { address: '0xbf004bff64725914ee36d03b87d6965b0ced4903', name: 'Afeng Main 1' },
    { address: '0xbd28edf53231cd121a963b4b119d3cc4cb3a368a', name: 'Afeng Main 2' },
    { address: '0x92deb73329794a517f1a8be4925446300f159400', name: 'Afeng Alt 1' },
    { address: '0xb9c970411d72584649c2a41c9d5996df582fcc06', name: 'Afeng Alt 2' },
    { address: '0x2ce9d43d1cba6ae31d7f07bfe0098dfa2d833373', name: 'Kuzuo' },
  ],
  hideLightningTrade: true,
  watchedDevs: [],
  highlightColor: '#f5b83d',
};

const featureInputs = {
  enabled: document.querySelector('#enabled'),
  showDevPerformance: document.querySelector('#show-dev-performance'),
  showDevTooltip: document.querySelector('#show-dev-tooltip'),
  enableDevBookmark: document.querySelector('#enable-dev-bookmark'),
  enableCalloutBlacklist: document.querySelector('#enable-callout-blacklist'),
  enableSpecialWallet: document.querySelector('#enable-special-wallet'),
  enableRemindAlert: document.querySelector('#enable-remind-alert'),
  enableFomoPanel: document.querySelector('#enable-fomo-panel'),
  enableHoldingSurge: document.querySelector('#enable-holding-surge'),
  hideLightningTrade: document.querySelector('#hide-lightning-trade'),
};
const debugInput = document.querySelector('#debug-logging');
const debugStatus = document.querySelector('#debug-status');
const debugExport = document.querySelector('#debug-export');
const debugClear = document.querySelector('#debug-clear');
function debugLabel() { debugStatus.textContent = debugInput.checked ? 'Logging on — reproduce the issue, then export.' : 'Logging off — existing logs can still be exported or cleared.'; }
debugInput.addEventListener('change', async () => {
  try { await chrome.storage.local.set({debugLogging:debugInput.checked}); debugLabel(); }
  catch { debugInput.checked=!debugInput.checked; debugStatus.textContent='Could not save debug setting. Please retry.'; }
});
debugExport.addEventListener('click', async () => {
  debugExport.disabled=true;
  try {
    const result=await chrome.runtime.sendMessage({type:'debug-export'});
    if (!result?.ok || !result.data) throw new Error('unavailable');
    const blob=new Blob([JSON.stringify(result.data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download=`better-gmgn-debug-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
    debugStatus.textContent='Log file exported. Send it with the screenshot and approximate issue time.';
  } catch { debugStatus.textContent='Export failed. Please retry or reload the extension.'; }
  finally { debugExport.disabled=false; }
});
debugClear.addEventListener('click', async () => {
  debugClear.disabled=true;
  try {
    const result=await chrome.runtime.sendMessage({type:'debug-clear'});
    if (!result?.ok) throw new Error('unavailable');
    debugStatus.textContent='Logs cleared.';
  } catch { debugStatus.textContent='Could not clear logs. Please retry.'; }
  finally { debugClear.disabled=false; }
});
const devListInput = document.querySelector('#dev-list');
const colorInput = document.querySelector('#highlight-color');
const surgeThresholdInput = document.querySelector('#holding-surge-threshold');
const surgeCooldownInput = document.querySelector('#holding-surge-cooldown');
const gmgnHoldingSyncStatus = document.querySelector('#gmgn-holding-sync-status');
const j7TrackerSyncStatus = document.querySelector('#j7tracker-sync-status');
const mergeHoldersInput = document.querySelector('#enable-merge-fomo-holders');
const markedEnableInput = document.querySelector('#enable-marked-holders');
const fomoFeedEnableInput = document.querySelector('#enable-fomo-feed');
const pumpFeedEnableInput = document.querySelector('#enable-pump-feed');
const fomoFeedChainOnlyInput = document.querySelector('#fomo-feed-chain-only');
const fomoFeedTypeInputs = {
  buy: document.querySelector('#fomo-feed-buy'),
  sell: document.querySelector('#fomo-feed-sell'),
  thesis: document.querySelector('#fomo-feed-thesis'),
};

const markedListInput = document.querySelector('#marked-list');

function markedToText(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => `${x.address} ${x.name || ''}`.trim())
    .join('\n');
}

function markedFromText(text) {
  return String(text || '').split('\n')
    .map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const m = line.match(/^(0x[a-fA-F0-9]{40})\s*(.*)$/);
      return m ? { address: m[1].toLowerCase(), name: m[2].trim() || m[1].slice(0, 8) } : null;
    })
    .filter(Boolean);
}

const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = type;
}

function renderGmgnHoldingSyncState(state) {
  if (!state?.synced) {
    gmgnHoldingSyncStatus.textContent = state?.reason === 'login-required'
      ? 'Not synced: sign in to the same account on GMGN first'
      : 'Not synced yet; the extension setting remains active if sync fails';
    gmgnHoldingSyncStatus.className = 'sync-status is-warn';
    return;
  }
  const labels = { sol: 'SOL', bsc: 'BSC', base: 'Base' };
  const enabled = (Array.isArray(state.enabledChains) ? state.enabledChains : [])
    .map((chain) => labels[chain] || chain).join(', ');
  gmgnHoldingSyncStatus.textContent = enabled
    ? `GMGN app setting synced: enabled for ${enabled}`
    : 'GMGN app setting synced: position price alerts are disabled';
  gmgnHoldingSyncStatus.className = 'sync-status is-ok';
}

function shortJ7TrackerAccount(raw) {
  const value = String(raw || '');
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function renderJ7TrackerSyncState(state) {
  if (!state?.connected) {
    j7TrackerSyncStatus.textContent = state?.reason === 'session-expired'
      ? 'J7Tracker session expired: sign in again and open j7tracker.io'
      : (state?.reason === 'verifying'
        ? 'Verifying J7Tracker session…'
        : (state?.reason === 'network'
          ? 'J7Tracker refresh failed; retrying automatically.'
          : 'Not connected: open j7tracker.io once while signed in'));
    j7TrackerSyncStatus.className = 'sync-status is-warn';
    return;
  }
  const account = String(state.displayName || '').trim() || shortJ7TrackerAccount(state.accountId);
  const fomoCount = Number(state.fomoTrackedCount);
  const pumpCount = Number(state.pumpTrackedCount);
  const hasCounts = Number.isInteger(fomoCount) && fomoCount >= 0 && Number.isInteger(pumpCount) && pumpCount >= 0;
  const counts = hasCounts ? ` · FOMO ${fomoCount} · Pump ${pumpCount}` : '';
  j7TrackerSyncStatus.textContent = `J7Tracker connected${account ? `: ${account}` : ''}${counts}`;
  j7TrackerSyncStatus.className = `sync-status ${hasCounts && fomoCount + pumpCount === 0 ? 'is-warn' : 'is-ok'}`;
}

function parseDevList(text) {
  const entries = new Map();
  const errors = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    const match = line.match(/^(0x[a-fA-F0-9]{40})(?:[\s,\uFF0C|]+(.*))?$/);
    if (!match || !ADDRESS_RE.test(match[1])) {
      errors.push(index + 1);
      return;
    }

    const address = match[1].toLowerCase();
    entries.set(address, { address, label: (match[2] || '').trim() });
  });

  return { entries: [...entries.values()], errors };
}

function formatDevList(entries) {
  return entries
    .map((entry) => `${entry.address}${entry.label ? ` ${entry.label}` : ''}`)
    .join('\n');
}

chrome.storage.local.get(DEFAULTS, (stored) => {
  debugInput.checked = stored.debugLogging === true;
  debugLabel();
  for (const [key, input] of Object.entries(featureInputs)) {
    input.checked = stored[key] !== false;
  }
  devListInput.value = formatDevList(
    Array.isArray(stored.watchedDevs) ? stored.watchedDevs : [],
  );
  colorInput.value = stored.highlightColor || DEFAULTS.highlightColor;
  surgeThresholdInput.value = String(stored.holdingSurgeThreshold || DEFAULTS.holdingSurgeThreshold);
  surgeCooldownInput.value = String(stored.holdingSurgeCooldown || DEFAULTS.holdingSurgeCooldown);
  mergeHoldersInput.checked = stored.mergeFomoHolders !== false;
  markedEnableInput.checked = stored.enableMarkedHolders !== false;
  fomoFeedEnableInput.checked = stored.enableFomoFeed !== false;
  pumpFeedEnableInput.checked = stored.enablePumpFeed !== false;
  fomoFeedChainOnlyInput.checked = stored.fomoFeedChainOnly === true;
  const storedFomoTypes = stored.fomoFeedTypes && typeof stored.fomoFeedTypes === 'object'
    ? stored.fomoFeedTypes : DEFAULTS.fomoFeedTypes;
  for (const [key, input] of Object.entries(fomoFeedTypeInputs)) {
    input.checked = storedFomoTypes[key] !== false;
  }
  markedListInput.value = markedToText(
    Array.isArray(stored.markedHolders) ? stored.markedHolders : DEFAULTS.markedHolders);
  const count = Array.isArray(stored.watchedDevs) ? stored.watchedDevs.length : 0;
  setStatus(`Configured ${count} watched developers`);
});

chrome.storage.local.get({ gmgnHoldingSignalSyncState: null }, (stored) => {
  renderGmgnHoldingSyncState(stored.gmgnHoldingSignalSyncState);
});

chrome.storage.local.get({ j7TrackerSyncStateV1: null }, (stored) => {
  renderJ7TrackerSyncState(stored.j7TrackerSyncStateV1);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.debugLogging) { debugInput.checked=changes.debugLogging.newValue===true;debugLabel(); }
  if (areaName === 'local' && changes.gmgnHoldingSignalSyncState) {
    renderGmgnHoldingSyncState(changes.gmgnHoldingSignalSyncState.newValue);
  }
  if (areaName === 'local' && changes.j7TrackerSyncStateV1) {
    renderJ7TrackerSyncState(changes.j7TrackerSyncStateV1.newValue);
  }
});

saveButton.addEventListener('click', async () => {
  const parsed = parseDevList(devListInput.value);
  if (parsed.errors.length) {
    setStatus(`Lines ${parsed.errors.join(', ')} do not contain complete BSC wallet addresses`, 'error');
    return;
  }

  const next = {
    ...Object.fromEntries(
      Object.entries(featureInputs).map(([key, input]) => [key, input.checked]),
    ),
    watchedDevs: parsed.entries,
    highlightColor: colorInput.value || DEFAULTS.highlightColor,
    holdingSurgeThreshold: Number(surgeThresholdInput.value) || DEFAULTS.holdingSurgeThreshold,
    holdingSurgeCooldown: Number(surgeCooldownInput.value) || DEFAULTS.holdingSurgeCooldown,
    mergeFomoHolders: mergeHoldersInput.checked,
    enableMarkedHolders: markedEnableInput.checked,
    enableFomoFeed: fomoFeedEnableInput.checked,
    enablePumpFeed: pumpFeedEnableInput.checked,
    fomoFeedChainOnly: fomoFeedChainOnlyInput.checked,
    fomoFeedTypes: Object.fromEntries(
      Object.entries(fomoFeedTypeInputs).map(([key, input]) => [key, input.checked]),
    ),
    markedHolders: markedFromText(markedListInput.value),
  };

  chrome.storage.local.set(next, () => {
    if (chrome.runtime.lastError) {
      setStatus(`Save failed: ${chrome.runtime.lastError.message}`, 'error');
      return;
    }
    devListInput.value = formatDevList(parsed.entries);
    setStatus(`Saved ${parsed.entries.length} watched developers`, 'success');
  });
});
