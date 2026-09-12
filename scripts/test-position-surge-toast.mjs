import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root = new URL('../', import.meta.url);
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:390,height:700}});
  await page.route('**/*',r=>r.fulfill({body:'<!doctype html><body></body>',contentType:'text/html'}));
  await page.routeWebSocket('**/*',s=>s.close());
  await page.goto('https://gmgn.ai/');
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(()=>{
    window.historyRecords=[];
    window.chrome={storage:{local:{get:(k,cb)=>cb?.({enabled:false}),set:(v,cb)=>cb?.()},onChanged:{addListener(){}}},runtime:{id:'fixture',getURL:p=>p,getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:(m,cb)=>{if(m.type==='notification-history-add')window.historyRecords.push(m.payload);cb?.({ok:false});}}};
  });
  await page.addStyleTag({path:new URL('styles.css',root).pathname});
  const source=fs.readFileSync(new URL('content.js',root),'utf8');
  await page.addScriptTag({content:source.replace(/\}\)\(\);\s*$/, 'window.__toast=showRemindCard;})();')});
  const info={kind:'position-surge',tagText:'Position surge',dir:'up',bell:'🚀',symbol:'SYNTHETIC',label:'Cost / 5m',value:'Cost +20.0% · 5m +2.3%',href:'/eth/token/0x1111111111111111111111111111111111111111',raw:''};
  await page.evaluate(info=>{
    window.__toast({...info,kind:undefined,tagText:'Price alert',symbol:'OTHER'});
    window.__toast(info);
    window.surge=document.querySelector('.gdh-remind-card:last-child');
    window.toastStarted=performance.now();
    setTimeout(()=>window.surgePresentAt4500=window.surge.isConnected,4500);
    new MutationObserver(()=>{if(!window.surge.isConnected&&!window.toastRemoved)window.toastRemoved=performance.now();}).observe(document.body,{childList:true,subtree:true});
  },info);
  const surge=page.locator('.gdh-remind-card').filter({hasText:'SYNTHETIC'});
  assert.equal(await surge.locator('.gdh-remind-card__num').textContent(),info.value);
  assert.equal(await surge.locator('.gdh-remind-card__foot').textContent(),'Open token page →');
  await surge.hover();
  fs.mkdirSync(new URL('test-results/',root),{recursive:true});
  await page.screenshot({path:new URL('test-results/position-surge-390.png',root).pathname});
  await page.waitForFunction(()=>!!window.toastRemoved,null,{timeout:6000});
  assert.equal(await page.evaluate(()=>window.surgePresentAt4500),true,'surge remains until its five-second deadline');
  const elapsed=await page.evaluate(()=>window.toastRemoved-window.toastStarted);
  assert.ok(elapsed>=4900&&elapsed<5500,`hovered surge expires at five seconds, actual ${elapsed}ms`);
  assert.equal(await page.locator('.gdh-remind-card').filter({hasText:'OTHER'}).count(),1,'other reminder keeps its original lifetime');
  assert.equal(await page.evaluate(()=>window.historyRecords.length),2,'auto-dismiss does not erase history');
  assert.deepEqual(await page.evaluate(()=>window.historyRecords[1]),{tag:info.tagText,symbol:info.symbol,label:info.label,value:info.value,bell:info.bell,dir:info.dir,href:info.href});
  // Verify the existing token action without leaving the offline fixture host.
  await page.evaluate(info=>window.__toast(info),info);
  await page.locator('.gdh-remind-card').filter({hasText:'SYNTHETIC'}).click();
  await page.waitForURL(`https://gmgn.ai${info.href}`);
  assert.deepEqual(errors,[]);
  console.log(`PASS position surge: price-free metrics, token label/link/history, hovered toast removed in ${Math.round(elapsed)}ms, unrelated reminder unchanged; synthetic offline browser`);
} finally {await browser.close();}
