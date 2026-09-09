import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root = new URL('../', import.meta.url);
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*', r=>r.fulfill({body:'<!doctype html><body></body>',contentType:'text/html'}));
  await page.routeWebSocket('**/*', s=>s.close());
  await page.goto('https://gmgn.ai/');
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(()=>{
    window.chrome={storage:{local:{get:(k,cb)=>cb?.({enabled:false}),set:(v,cb)=>cb?.()},onChanged:{addListener(){}}},runtime:{id:'fixture',getURL:p=>p,getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:(m,cb)=>cb?.({ok:false})}};
  });
  await page.addStyleTag({path:new URL('styles.css',root).pathname});
  let source=fs.readFileSync(new URL('content.js',root),'utf8');
  source=source.replace(/\}\)\(\);\s*$/, `window.__merged={render:(cards,events)=>{settings.enabled=true;lastFullScanAt=Infinity;fomoFeedLastPollAt=Infinity;fomoFollowedLastPollAt=Infinity;pumpFeedLastPollAt=Infinity;fomoFollowedEvents=events;return renderMergedTracker(cards,events);}, sync:syncMergedTracker, destroy:teardownFomoFeed};})();`);
  await page.addScriptTag({content:source});
  await page.waitForTimeout(100);
  await page.evaluate(()=>{
    document.body.style.margin='0';
    document.body.innerHTML='<div id="host" style="height:700px;width:450px;max-width:100vw;display:flex"><div id="viewport" style="height:700px;flex:1;overflow:auto"><div id="spacer" style="height:6400px;position:relative"></div></div></div>';
    window.stamps=Array.from({length:100},(_,i)=>Date.now()-i*1000);
    window.nativeClicks=0;
    window.recycle=()=>{
      const v=document.querySelector('#viewport'), s=document.querySelector('#spacer');
      s.setAttribute('data-gdh-native-index',JSON.stringify(window.stamps));
      s.style.height=`${window.stamps.length*64}px`;
      const start=Math.max(0,Math.min(window.stamps.length-12,Math.floor(v.scrollTop/64)));
      s.replaceChildren();
      for(let i=start;i<Math.min(start+12,window.stamps.length);i++) {
        const w=document.createElement('div');w.className='native-wrap';w.style.cssText=`position:absolute;top:0;transform:translateY(${i*64}px);height:64px;width:100%`;
        const c=document.createElement('button'); c.dataset.sentryComponent='TrackerListItem';c.dataset.gdhTrackTs=String(window.stamps[i]);c.dataset.index=String(i);c.textContent=`Native ${i}`;c.style.cssText='height:64px;width:100%'; c.onclick=()=>window.nativeClicks++;
        w.append(c);s.append(w);
      }
    };
    document.querySelector('#viewport').addEventListener('scroll',window.recycle);
    window.recycle();
    window.events=Array.from({length:40},(_,i)=>({key:`merged-${i}`,source:'fomo-followed',type:'buy',userId:'alice',handle:'alice',symbol:'TEST',chain:'eth',addr:'0x3333333333333333333333333333333333333333',ts:window.stamps[i*2]-500,usd:1}));
    window.render=()=>window.__merged.render([...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')],window.events);
  });
  assert.equal(await page.evaluate(()=>window.render()),true);
  assert.equal(await page.locator('.gdh-fomofeed').count(),40);
  assert.equal(await page.locator('.gdh-fomofeed-lane').count(),0);
  const seenNative=new Set(),seenFomo=new Set();
  for(let y=0;y<=9300;y+=300) {
    assert.equal(await page.locator('.gdh-merged-tracker').count(),1,`surface retained at ${y}; errors ${errors}`);
    await page.evaluate(y=>{document.querySelector('.gdh-merged-tracker').scrollTop=y;window.__merged.sync();},y);
    await page.waitForTimeout(80);
    const report=await page.evaluate(()=>{
      const box=document.querySelector('.gdh-merged-tracker').getBoundingClientRect();
      const rows=[...document.querySelectorAll('[data-sentry-component="TrackerListItem"],.gdh-fomofeed')].map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,ts:Number(el.dataset.gdhTrackTs||el.querySelector('[data-gdh-fomo-ts]')?.dataset.gdhFomoTs),native:el.dataset.index,fomo:el.dataset.gdhFomoKey})).filter(r=>r.bottom>box.top&&r.top<box.bottom).sort((a,b)=>a.top-b.top);
      return {rows,overflow:getComputedStyle(document.querySelector('#viewport')).overflowY};
    });
    assert.equal(report.overflow,'hidden');
    for(let i=0;i<report.rows.length;i++) {
      const r=report.rows[i];if(r.native!==undefined)seenNative.add(r.native);if(r.fomo)seenFomo.add(r.fomo);
      if(i){assert.ok(report.rows[i-1].bottom<=r.top+.6,`overlap at ${y}`);assert.ok(report.rows[i-1].ts>=r.ts,`chronology at ${y}`);}
    }
  }
  assert.equal(seenNative.size,100,`native indices missing ${Array.from({length:100},(_,i)=>String(i)).filter(i=>!seenNative.has(i))}; geometry ${JSON.stringify(await page.evaluate(()=>({outer:document.querySelector('.gdh-merged-tracker').scrollTop,native:document.querySelector('#viewport').scrollTop,height:document.querySelector('#viewport').scrollHeight,rows:[...document.querySelectorAll('.native-wrap')].map(e=>[e.firstChild.dataset.index,e.getBoundingClientRect().top,e.style.translate])})))}`);
  assert.equal(seenFomo.size,40,'all 40 interleaved FOMO rows reachable');
  await page.evaluate(()=>{document.querySelector('.gdh-merged-tracker').scrollTop=0;window.__merged.sync();});
  await page.waitForTimeout(40);
  await page.locator('[data-index="0"]').click();
  assert.equal(await page.evaluate(()=>window.nativeClicks),1,'original native handler retained');
  await page.evaluate(()=>{window.stamps.unshift(window.stamps[0]+1000);window.recycle();window.render();});
  await page.waitForTimeout(30);
  assert.equal(await page.locator('.gdh-fomofeed').count(),40);
  for(const width of [1280,768,390]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await page.locator('.gdh-merged-tracker').evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1));
  }
  await page.evaluate(()=>window.__merged.destroy());
  assert.equal(await page.locator('.gdh-merged-tracker').count(),0);
  assert.equal(await page.locator('#host > #viewport').count(),1);
  assert.equal(await page.locator('.native-wrap').evaluateAll(els=>els.every(el=>!el.style.translate)),true);
  assert.deepEqual(errors,[]);
  console.log('PASS merged scroll: 100 native + 40 FOMO reachable, chronological/no overlap, one scrollbar, native click, recycling/arrival, responsive widths, teardown; synthetic host only');
} finally {await browser.close();}
