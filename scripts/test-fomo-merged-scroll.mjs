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
  source=source.replace(/\}\)\(\);\s*$/, `window.__merged={render:(cards,events)=>{settings.enabled=true;lastFullScanAt=Infinity;fomoFollowedLastPollAt=Infinity;fomoFollowedEvents=events;return renderMergedTracker(cards,visibleTrackingFeedEvents(nativeTrackingFeedRows(cards)));}, sync:syncMergedTracker, scan:scanFomoFeed, state:()=>mergedTracker, destroy:()=>{settings.enabled=false;teardownFomoFeed();}};})();`);
  await page.addScriptTag({content:source});
  await page.waitForTimeout(100);
  await page.evaluate(()=>{
    document.body.style.margin='0';
    document.body.innerHTML='<div id="host" style="height:700px;width:450px;max-width:100vw;display:flex"><div id="viewport" style="height:700px;flex:1;overflow:auto"><div id="spacer" style="height:6400px;position:relative"></div></div></div>';
    window.stamps=Array.from({length:100},(_,i)=>Date.now()-i*1000);
    window.nativeClicks=0;
    window.recycle=(delayed=false)=>{
      const v=document.querySelector('#viewport'), s=document.querySelector('#spacer');
      s.setAttribute('data-gdh-native-index',JSON.stringify(window.stamps));
      s.style.height=`${window.stamps.length*64.5}px`;
      const start=Math.max(0,Math.min(window.stamps.length-12,Math.floor(v.scrollTop/64.5)));
      (window.recycleLog ||= []).push([performance.now(),v.scrollTop,document.querySelector('.gdh-merged-tracker')?.scrollTop]);
      for(let j=0;j<12;j++) {
        const i=start+j;
        let w=s.children[j];
        if(!w) {
          w=document.createElement('div');w.className='native-wrap';
          const c=document.createElement('button');c.dataset.sentryComponent='TrackerListItem';
          c.style.cssText='height:64.5px;width:100%';c.onclick=()=>window.nativeClicks++;
          w.append(c);s.append(w);
        }
        // A real pool retains the original native button/handler but replaces
        // wrapper cssText. Metadata lands in a later bridge turn.
        w.style.cssText=`position:absolute;top:0;transform:translateY(${i*64.5}px);height:64.5px;width:100%`;
        const c=w.firstChild;c.dataset.index=String(i);c.textContent=`Native ${i}`;
      }
      const stamp=()=>{for(const w of s.children)w.firstChild.dataset.gdhTrackTs=String(window.stamps[Number(w.firstChild.dataset.index)]);};
      clearTimeout(window.stampTimer);
      if(delayed) { window.__merged.scan();window.stampTimer=setTimeout(stamp,45); }
      else stamp();
    };
    document.querySelector('#viewport').addEventListener('scroll',()=>window.recycle(true));
    window.recycle();
    window.events=Array.from({length:40},(_,i)=>({key:`merged-${i}`,source:'fomo-followed',followed:true,type:'buy',userId:'alice',handle:'alice',symbol:'TEST',chain:'eth',addr:'0x3333333333333333333333333333333333333333',ts:window.stamps[i*2]-500,usd:1}));
    window.render=()=>window.__merged.render([...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')],window.events);
  });
  assert.equal(await page.evaluate(()=>window.render()),true);
  assert.equal(await page.locator('.gdh-fomofeed').count(),40);
  assert.equal(await page.locator('.gdh-fomofeed-lane').count(),0);
  const seenNative=new Set(),seenFomo=new Set();
  await page.evaluate(()=>{window.originalSurface=document.querySelector('.gdh-merged-tracker');window.originalButtons=[...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')];});
  for(const y of [...Array.from({length:32},(_,i)=>i*300),...Array.from({length:32},(_,i)=>(31-i)*300)]) {
    assert.equal(await page.locator('.gdh-merged-tracker').count(),1,`surface retained at ${y}; errors ${errors}`);
    await page.evaluate(y=>{document.querySelector('.gdh-merged-tracker').scrollTop=y;window.__merged.sync();},y);
    await page.waitForTimeout(150);
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')].every(c=>Number(c.dataset.gdhTrackTs)===window.stamps[Number(c.dataset.index)]));
    const report=await page.evaluate(()=>{
      const box=document.querySelector('.gdh-merged-tracker').getBoundingClientRect();
      const rows=[...document.querySelectorAll('[data-sentry-component="TrackerListItem"],.gdh-fomofeed')].map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,ts:Number(el.dataset.gdhTrackTs||el.querySelector('[data-gdh-fomo-ts]')?.dataset.gdhFomoTs),native:el.dataset.index,fomo:el.dataset.gdhFomoKey})).filter(r=>r.bottom>box.top&&r.top<box.bottom).sort((a,b)=>a.top-b.top);
      const m=window.__merged.state();
      const expected=window.stamps.map((_,i)=>{const top=i*64.5+m.slots.reduce((sum,s)=>sum+(s.at<=i*64.5+.25?s.height:0),0)-m.surface.scrollTop;return {i,top};}).filter(r=>r.top+64.5>0&&r.top<box.height).map(r=>String(r.i));
      return {log:window.recycleLog.slice(-12),rows,expected,retained:m.surface===window.originalSurface,overflow:getComputedStyle(document.querySelector('#viewport')).overflowY};
    });
    assert.equal(report.retained,true,`same surface at ${y}`);
    assert.deepEqual(report.rows.filter(r=>r.native!==undefined).map(r=>r.native),report.expected,`no missing native viewport slots at ${y}`);
    assert.equal(report.overflow,'hidden');
    for(let i=0;i<report.rows.length;i++) {
      const r=report.rows[i];if(r.native!==undefined)seenNative.add(r.native);if(r.fomo)seenFomo.add(r.fomo);
      if(i){assert.ok(report.rows[i-1].bottom<=r.top+.6,`overlap at ${y}`);assert.ok(report.rows[i-1].ts>=r.ts,`chronology at ${y}: ${JSON.stringify(report)}`);}
    }
  }
  assert.equal(seenNative.size,100,`native indices missing ${Array.from({length:100},(_,i)=>String(i)).filter(i=>!seenNative.has(i))}; geometry ${JSON.stringify(await page.evaluate(()=>({outer:document.querySelector('.gdh-merged-tracker').scrollTop,native:document.querySelector('#viewport').scrollTop,height:document.querySelector('#viewport').scrollHeight,rows:[...document.querySelectorAll('.native-wrap')].map(e=>[e.firstChild.dataset.index,e.getBoundingClientRect().top,e.style.translate])})))}`);
  assert.equal(seenFomo.size,40,'all 40 interleaved FOMO rows reachable');
  // Keep a native anchor stable through simultaneous native + provider arrivals.
  await page.evaluate(()=>{
    const m=window.__merged.state(),at=45*64.5;
    m.surface.scrollTop=at+m.slots.reduce((sum,s)=>sum+(s.at<=at?s.height:0),0)+20;
    window.__merged.sync();
  });
  await page.waitForTimeout(250);
  const anchor=await page.evaluate(()=>({ts:window.stamps[45],top:document.querySelector('[data-index="45"]').getBoundingClientRect().top}));
  await page.evaluate(()=>{
    window.stamps.unshift(window.stamps[0]+1000);
    window.events.unshift({...window.events[0],key:'arrival',ts:window.stamps[0]+500});
    window.recycle(true);window.render();
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.__merged.state().surface===window.originalSurface),true);
  const after=await page.evaluate(ts=>[...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')].find(c=>Number(c.dataset.gdhTrackTs)===ts)?.getBoundingClientRect().top,anchor.ts);
  assert.ok(Math.abs(after-anchor.top)<1,`native arrival anchor ${anchor.top} -> ${after}`);
  // A FOMO card is a separate anchor, not a rounded native boundary.
  await page.evaluate(()=>{const m=window.__merged.state(),s=m.slots[10];window.anchorKey=s.key;m.surface.scrollTop=s.top+20;window.__merged.sync();});
  await page.waitForTimeout(250);
  const fomoAnchor=await page.evaluate(()=>document.querySelector(`[data-gdh-fomo-key="${window.anchorKey}"]`).getBoundingClientRect().top);
  await page.evaluate(()=>{window.events.unshift({...window.events[0],key:'arrival-2',ts:window.stamps[0]+1000});window.render();});
  await page.waitForTimeout(250);
  assert.ok(Math.abs(await page.evaluate(()=>document.querySelector(`[data-gdh-fomo-key="${window.anchorKey}"]`).getBoundingClientRect().top)-fomoAnchor)<1);
  // Style-only reuse must repair removed translates without a stamp mutation.
  await page.evaluate(()=>{window.styleWrites=0;window.styleObserver=new MutationObserver(r=>window.styleWrites+=r.length);window.styleObserver.observe(document.querySelector('#spacer'),{subtree:true,attributes:true,attributeFilter:['style']});for(const w of document.querySelectorAll('.native-wrap'))w.style.translate='';});
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.native-wrap')].some(w=>!!w.style.translate)),true);
  const writes=await page.evaluate(()=>window.styleWrites);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>window.styleWrites),writes,'style observer settles, no self-write loop');
  // Transform-only recycling must be observed even if bridge attributes have
  // not changed yet (temporarily move one pool wrapper into a different slot).
  await page.evaluate(()=>{const w=document.querySelector('.native-wrap');window.oldTransform=w.style.transform;w.style.transform='translateY(3225px)';});
  await page.waitForTimeout(200);
  const transformReport=await page.evaluate(()=>{
    const m=window.__merged.state(),w=document.querySelector('.native-wrap'),at=3225;
    return {actual:w.getBoundingClientRect().top-m.surface.getBoundingClientRect().top,expected:at+m.slots.reduce((sum,s)=>sum+(s.at<=at+.25?s.height:0),0)-m.surface.scrollTop};
  });
  assert.ok(Math.abs(transformReport.actual-transformReport.expected)<1,`transform-only pool reuse: ${JSON.stringify(transformReport)}`);
  await page.evaluate(()=>document.querySelector('.native-wrap').style.transform=window.oldTransform);
  await page.waitForTimeout(200);
  await page.evaluate(()=>window.styleObserver.disconnect());
  assert.equal(await page.evaluate(()=>window.originalButtons.every(c=>c.isConnected)),true,'native pool nodes never cloned/replaced');
  await page.evaluate(()=>{document.querySelector('.gdh-merged-tracker').scrollTop=0;window.__merged.sync();});
  await page.waitForTimeout(40);
  await page.locator('[data-index="0"]').click();
  assert.equal(await page.evaluate(()=>window.nativeClicks),1,'original native handler retained');
  await page.evaluate(()=>{window.stamps.unshift(window.stamps[0]+1000);window.recycle();window.render();});
  await page.waitForTimeout(30);
  assert.equal(await page.locator('.gdh-fomofeed').count(),40,'scanner retains existing 40-event cap');
  assert.equal(await page.locator('.gdh-merged-tracker').evaluate(el=>el.scrollTop),0,'top remains pinned on arrival');
  for(const width of [1280,768,390]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await page.locator('.gdh-merged-tracker').evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1));
  }
  // Timestamp lag may not keep an incompatible snapshot alive indefinitely.
  await page.evaluate(()=>{clearTimeout(window.stampTimer);document.querySelector('[data-sentry-component="TrackerListItem"]').dataset.gdhTrackTs='1';window.__merged.scan();});
  assert.equal(await page.locator('.gdh-merged-tracker').count(),1,'short metadata handoff retains surface');
  await page.waitForFunction(()=>!document.querySelector('.gdh-merged-tracker'),null,{timeout:3000});
  assert.equal(await page.evaluate(()=>window.render()),false,'stale rows cannot bootstrap');
  await page.evaluate(()=>window.recycle());
  assert.equal(await page.evaluate(()=>window.render()),true,'fresh validated snapshot recovers');
  await page.evaluate(()=>{document.querySelector('.native-wrap').style.height='80px';window.__merged.scan();});
  assert.equal(await page.locator('.gdh-merged-tracker').count(),0,'nonuniform unknown geometry fails closed immediately');
  await page.evaluate(()=>window.recycle());
  assert.equal(await page.evaluate(()=>window.render()),true);
  await page.evaluate(()=>window.__merged.destroy());
  // Keep the feature disabled while queued observer/scanner work drains.
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.gdh-merged-tracker').count(),0);
  assert.equal(await page.locator('#host > #viewport').count(),1);
  assert.equal(await page.locator('.native-wrap').evaluateAll(els=>els.every(el=>!el.style.translate)),true);
  assert.deepEqual(errors,[]);
  console.log('PASS merged scroll: 100 native + 40 FOMO reachable down/end/up, chronological/no missing slots, retained single surface, fractional in-place async recycling, native/FOMO arrival anchors, style-only reuse/no observer loop, original native handler/nodes, responsive widths, bounded stale rejection/recovery and teardown; synthetic host only');
} finally {await browser.close();}
