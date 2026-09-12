// Production source in isolated, network-blocked Chromium; no live account or trades.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const read = f => fs.readFileSync(new URL('../'+f, import.meta.url), 'utf8');
const retired = /specialWallet|enableSpecialWallet|specialManage|ensureStarButton|ensureAddressPageStar|addWalletStarPref|SPECIAL_PIN|scanPinnedPush|gdh-star|gdh-sp-|gdh-color-(?:button|palette)|gdh-rainbow|gdh-addw-(?:row|toggle|star|opts|dots|dot|custom|pin)/i;
for (const file of ['content.js', 'popup.js', 'popup.html', 'styles.css']) assert.doesNotMatch(read(file), retired, file);
const A='0x1111111111111111111111111111111111111111';
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  const errors=[], requests=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/*', r=>{requests.push(r.request().url());return r.fulfill({contentType:'text/html',body:`<body>
    <section data-sentry-component="WalletTrack"><header data-sentry-component="TrackingHeader">Tracking</header><div data-sentry-component="TrackingBody"><a data-sentry-component="TrackerListItem" href="/bsc/token/${A}" data-gdh-track-maker="${A}"><span>Buy</span><span data-sentry-component="LiteTrackerAmount">1</span></a></div></section>
    <div data-sentry-component="WalletTable"><div style="height:44px"><a href="/bsc/address/${A}">Wallet</a></div></div>
    <div><button data-sentry-component="UserFollow">Follow</button></div>
    <form><input placeholder="Wallet address"><input placeholder="Wallet name"><button type="button">Add wallet</button></form>
    <div data-testid="token-detail-holders-row" data-gdh-holder-balance="100"></div>
    <div data-testid="token-detail-holders-row" data-gdh-holder-balance="50"></div>
    </body>`});});
  await page.goto('https://gmgn.ai/bsc/address/'+A);
  await page.evaluate(A=>{
    window.store={enabled:true, enableSpecialWallet:true,specialWallets:[{address:A,label:'OLD',color:'rainbow',pin:true}],addWalletStarPref:{on:true,color:'#ff0000',pin:true},watchedDevs:[{address:A,label:'Dev'}],blockedCallers:[{wallet:A,handle:'blocked',name:'Blocked'}],enableHoldingSurge:false,enableFomoFeed:false,enableFomoPanel:false,enableMarkedHolders:false,markedListMigratedV2:true,holdingWatchPurgedV1:true};
    window.writes=[];window.reads=[];window.listeners=[];
    window.change=value=>{Object.assign(store,value);listeners.forEach(fn=>fn(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,{newValue:v}])),'local'));};
    window.chrome={runtime:{getURL:x=>x,getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:(m,c)=>{c?.({ok:false});return Promise.resolve({ok:false});}},storage:{local:{get:(k,c)=>{reads.push(k);const v=typeof k==='string'?{[k]:store[k]}:Object.fromEntries(Object.entries(k).map(([key,def])=>[key,store[key]??def]));c?.(v);return Promise.resolve(v);},set:(v,c)=>{writes.push(v);Object.assign(store,v);c?.();return Promise.resolve();}},onChanged:{addListener:fn=>listeners.push(fn)}}};
    document.querySelector('form button').addEventListener('click',()=>window.nativeAdds=(window.nativeAdds||0)+1);
  },A);
  await page.addStyleTag({content:read('styles.css')});
  await page.addScriptTag({content:read('content.js').replace(/\}\)\(\);\s*$/, 'window.__retirement={scan:()=>{lastFullScanAt=0;scanVisibleCards();},rank:buildRankBadge,devs:()=>watchedMap.size,blocked:()=>blockedWallets.size};})();')});
  await page.waitForTimeout(1300);
  const absent=async()=>assert.equal(await page.locator('.gdh-star-button,.gdh-sp-manage-button,.gdh-sp-manage-modal,.gdh-pin-strip,.gdh-color-palette,.gdh-addw-row,[data-gdh-special],[data-gdh-star-host]').count(),0);
  await absent();
  await page.evaluate(()=>{change({enableSpecialWallet:false});change({enableSpecialWallet:true,addWalletStarPref:{on:true,pin:true},specialWallets:store.specialWallets});__retirement.scan();});
  await page.locator('form button').click();
  assert.equal(await page.evaluate(()=>nativeAdds),1);
  await page.evaluate(A=>{history.pushState({},'', '/bsc/token/'+A);document.querySelector('[data-sentry-component="TrackingBody"]').append(document.querySelector('[data-sentry-component="TrackerListItem"]').cloneNode(true));__retirement.scan();},A);
  await absent();
  assert.deepEqual(await page.evaluate(()=>[__retirement.devs(),__retirement.blocked(),__retirement.rank(75)?.textContent]),[1,1,'On-chain #2']);
  await page.locator('input[placeholder="Wallet address"]').fill('So11111111111111111111111111111111111111112');
  assert.equal(await page.locator('.gdh-addw-cross__go').textContent(),'Add directly to SOL');
  // Do not click the independent native follow shortcut: absence of automatic writes/requests is the assertion.
  assert.doesNotMatch(JSON.stringify(await page.evaluate(()=>({reads,writes}))), /specialWallet|enableSpecialWallet|addWalletStarPref/i);
  assert.deepEqual(requests,['https://gmgn.ai/bsc/address/'+A]);
  assert.deepEqual(errors,[]);
  console.log('PASS special-wallet retirement: production controls/styles/code absent; saved ON/color/pin and storage changes inert; address/tracker/wallet/add-dialog clean; native add, developer/callout indexes, holder rank and cross-chain shortcut preserved; no external traffic.');
} finally {await browser.close();}
