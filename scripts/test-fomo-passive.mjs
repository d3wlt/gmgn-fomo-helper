import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
const source = await fs.readFile(new URL('../fomo-passive.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
assert(manifest.content_scripts.some(s => s.world === 'MAIN' && s.run_at === 'document_start' && s.js.includes('fomo-passive.js')));
assert(!manifest.content_scripts.some(s => s.js?.includes('fomo-early.js')));
// VM installation tests: zero provider I/O, idempotence, no inbound postMessage command surface.
{
  let io = 0; const messages = [], timers = [];
  class XHR { open() { io++; } send() { io++; } }
  class WS { constructor() { io++; } }
  const context = { URL, Date, Set, WeakMap, Proxy, Reflect, Object, Array, Number, String, JSON,
    location: { origin: 'https://fomo.family', href: 'https://fomo.family/' },
    document: { visibilityState: 'visible', addEventListener() {} },
    XMLHttpRequest: XHR, WebSocket: WS, fetch() { io++; },
    postMessage(m) { messages.push(m); }, addEventListener(type) { assert.notEqual(type, 'message'); },
    setInterval(fn, ms) { assert.equal(ms, 20000); timers.push(fn); } };
  context.window = context; context.top = context;
  vm.runInNewContext(source, context); vm.runInNewContext(source, context);
  timers[0](); assert.equal(io, 0); assert.equal(timers.length, 1);
  assert(messages.every(m => m.connected === false));
}
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fomo-passive-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(temp, 'key.pem'), '-out', path.join(temp, 'cert.pem'), '-subj', '/CN=prod-api.fomo.family', '-days', '1'], { stdio: 'ignore' });
const server = https.createServer({ key: await fs.readFile(path.join(temp, 'key.pem')), cert: await fs.readFile(path.join(temp, 'cert.pem')) });
const wss = new WebSocketServer({ server });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,BlockInsecurePrivateNetworkRequests', '--no-proxy-server', '--ignore-certificate-errors', `--host-resolver-rules=MAP prod-api.fomo.family:443 127.0.0.1:${server.address().port}`] });
try {
  const context = await browser.newContext();
  const requests = [], sends = [], delayed = []; let socket, wsCount = 0, account = 'account-a', status = 200;
  const raw = { id: 'alert-1', type: 'swap_buy', userId: 'followed', tradeId: 'trade-1',
    tokenAddress: 'token-address', networkId: 1399811149, usdAmount: 25, marketCap: 123,
    createdAt: '2026-09-07T12:00:00Z', authorization: 'DO-NOT-FORWARD', nested: { jwt: 'DO-NOT-FORWARD' } };
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url()); requests.push(url.pathname);
    if (url.origin === 'https://fomo.family') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Passive local fixture — no live authentication</title>' });
    if (url.searchParams.has('delayed')) { delayed.push(route); return; }
    let responseObject = {};
    if (url.pathname === '/v2/users/current' || url.pathname === '/v2/users') responseObject = { id: account, jwt: 'DO-NOT-FORWARD' };
    if (url.pathname.endsWith('/followingIds')) responseObject = { followingIds: ['followed'] };
    if (url.pathname === '/feed/tradingActivity') responseObject = { items: [raw], hasNextPage: false };
    return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ statusCode: 200, success: true, responseObject }) });
  });
  wss.on('connection', ws => { socket = ws; wsCount++; ws.on('message', message => sends.push(String(message))); });
  await context.addInitScript(() => {
    window.events = [];
    window.addEventListener('message', e => { if (e.source === window && e.origin === location.origin && e.data?.source === 'gdh-fomo-passive-v1') window.events.push(e.data); });
    // Accelerate ONLY the local observer liveness interval.
    const interval = window.setInterval;
    window.setInterval = (fn, ms, ...args) => interval(fn, ms === 20000 ? 100 : ms, ...args);
  });
  // Test-only origin mapping to a real localhost TLS socket; production allowlist unchanged.
  const localSocketURL = `wss://127.0.0.1:${server.address().port}`;
  await context.addInitScript({ content: source.replace("url.origin !== 'wss://prod-api.fomo.family'", `url.origin !== '${localSocketURL}'`) });
  const page = await context.newPage(); await page.goto('https://fomo.family/');
  await page.waitForTimeout(150);
  assert.deepEqual(requests, ['/']); assert.equal(wsCount, 0); assert.equal(sends.length, 0);
  await page.evaluate(async socketURL => {
    const api = 'https://prod-api.fomo.family';
    const result = await fetch(api + '/v2/users/current');
    if ((await result.json()).responseObject.id !== 'account-a') throw new Error('Page body consumed');
    await new Promise(resolve => { const check = () => events.some(e => e.kind === 'account') ? resolve() : setTimeout(check, 5); check(); });
    await fetch(api + '/v2/users/current/followingIds');
    await new Promise(resolve => { const x = new XMLHttpRequest(); x.open('GET', api + '/feed/tradingActivity'); x.onload = resolve; x.send(); });
    window.nativeSocket = new WebSocket(socketURL + '/ws');
    await new Promise((resolve, reject) => { nativeSocket.addEventListener('open', resolve); nativeSocket.addEventListener('error', () => reject(new Error('Local TLS socket failed'))); });
  }, localSocketURL);
  await page.waitForTimeout(100);
  assert.equal((await page.evaluate(() => events.filter(e => e.kind === 'connection').at(-1))).connected, false, 'unsubscribed socket not Alerts-connected');
  socket.send(JSON.stringify({ type: 'subscribed', topicType: 'trading_activity', topicId: 'account-a' }));
  socket.send(JSON.stringify({ type: 'data', topicType: 'trading_activity', topicId: 'other-account', payload: { ...raw, id: 'wrong-account' } }));
  socket.send(JSON.stringify({ type: 'data', topicType: 'trading_activity', topicId: 'account-a', payload: { ...raw, id: 'alert-ws' } }));
  // Page-dispatched synthetic socket MessageEvent must not count as native reception.
  await page.evaluate(raw => nativeSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'data', topicType: 'trading_activity', topicId: 'account-a', payload: { ...raw, id: 'synthetic' } }) })), raw);
  await page.waitForTimeout(250);
  let events = await page.evaluate(() => window.events);
  assert(events.some(e => e.kind === 'following' && e.followingIds[0] === 'followed'));
  assert(events.some(e => e.kind === 'activity' && e.transport === 'rest' && e.items[0].networkId === 1399811149));
  assert(events.some(e => e.kind === 'activity' && e.items[0].id === 'alert-ws'));
  assert(!JSON.stringify(events).includes('DO-NOT-FORWARD'));
  assert(!events.some(e => e.items?.some(i => ['synthetic', 'wrong-account'].includes(i.id))));
  assert(events.some(e => e.kind === 'connection' && e.connected === true));
  assert(events.filter(e => e.kind === 'account').length > 1, 'local rebind replay for worker restart');
  for (let i = 1; i < events.length; i++) assert(events[i].seq > events[i - 1].seq);
  const before = requests.length;
  socket.close(); await page.waitForTimeout(200);
  events = await page.evaluate(() => window.events);
  assert.equal(events.filter(e => e.kind === 'connection').at(-1).connected, false);
  assert.equal(requests.length, before); assert.equal(wsCount, 1); assert.equal(sends.length, 0);
  assert.deepEqual(requests, ['/', '/v2/users/current', '/v2/users/current/followingIds', '/feed/tradingActivity']);
  // Delayed old-account current/following responses must never rebind after logout/switch.
  await page.evaluate(() => { fetch('https://prod-api.fomo.family/v2/users/current?delayed=1'); fetch('https://prod-api.fomo.family/v2/users/current/followingIds?delayed=1'); });
  await page.waitForTimeout(50); assert.equal(delayed.length, 2);
  status = 401; await page.evaluate(() => fetch('https://prod-api.fomo.family/v2/users/current'));
  await page.waitForTimeout(50);
  status = 200; account = 'account-b';
  await page.evaluate(() => fetch('https://prod-api.fomo.family/v2/users/current'));
  await page.waitForTimeout(50);
  for (const route of delayed) await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: true, responseObject: { id: 'account-a', followingIds: ['stale-roster'] } }) });
  await page.waitForTimeout(100);
  events = await page.evaluate(() => window.events);
  const logoutAt = events.findIndex(e => e.kind === 'logout'); assert(logoutAt >= 0);
  assert(events.slice(logoutAt + 1).some(e => e.kind === 'account' && e.accountId === 'account-b'));
  assert(!events.slice(logoutAt + 1).some(e => e.accountId === 'account-a' || e.followingIds?.includes('stale-roster')));
  assert.equal(sends.length, 0); assert.equal(wsCount, 1);
  console.log(JSON.stringify({ ok: true, tests: 'VM + real Chromium routed fixture (not live FOMO auth)', providerRequests: requests.length - 1, expectedPageRequests: 7, nativeSockets: wsCount, helperRequests: 0, socketSends: sends.length, envelopes: events.length }));
} finally { await browser.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); }
