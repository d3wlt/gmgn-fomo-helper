import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root = new URL('../', import.meta.url);
const browser = await chromium.launch({headless:true});
try {
 for (const height of [64.5,45]) {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*', r=>r.fulfill({body:'<!doctype html><body></body>',contentType:'text/html'}));
  await page.routeWebSocket('**/*', s=>s.close());
  await page.goto('https://gmgn.ai/');
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(()=>{
    window.diagnosticMessages=[];
    window.chrome={storage:{local:{get:(k,cb)=>cb?.({enabled:false}),set:(v,cb)=>cb?.()},onChanged:{addListener(){}}},runtime:{id:'fixture',getURL:p=>p,getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:(m,cb)=>{if(m.type==="debug-render")window.diagnosticMessages.push(m.fields);cb?.({ok:false});}}};
  });
  await page.addStyleTag({path:new URL('styles.css',root).pathname});
  let source=fs.readFileSync(new URL('content.js',root),'utf8');
  source=source.replace(/\}\)\(\);\s*$/, `window.__merged={render:(cards,events)=>{settings.enabled=true;settings.debugLogging=true;lastFullScanAt=Infinity;fomoFollowedLastPollAt=Infinity;fomoFollowedEvents=events;return renderMergedTracker(cards,visibleTrackingFeedEvents(nativeTrackingFeedRows(cards)));}, sync:syncMergedTracker, scan:scanFomoFeed, state:()=>mergedTracker, destroy:()=>{settings.enabled=false;teardownFomoFeed();}};})();`);
  source=source.replace('const anchor = mergedTrackerAnchor(m);', `const anchor = mergedTrackerAnchor(m); (window.renderLog ||= []).push({time:performance.now(),y:m.surface.scrollTop,old:m.stamps?.length,next:stamps.length,index:anchor?.index,offset:anchor?.offset,key:anchor?.key});if(window.renderLog.length>40)window.renderLog.shift();`);
  await page.addScriptTag({content:source});
  await page.waitForTimeout(100);
  await page.evaluate(height=>{
    window.rowHeight=height;window.poolSize=Math.ceil(700/height)+2;
    document.body.style.margin='0';
    document.body.innerHTML='<div id="host" style="height:700px;width:450px;max-width:100vw;display:flex"><div id="viewport" style="height:700px;flex:1;overflow:auto"><div id="spacer" style="height:6400px;position:relative"></div></div></div>';
    window.stamps=Array.from({length:180},(_,i)=>Date.now()-i*1000);
    window.nativeClicks=0;
    window.recycle=(delayed=false)=>{
      const v=document.querySelector('#viewport'), s=document.querySelector('#spacer');
      s.setAttribute('data-gdh-native-index',JSON.stringify(window.stamps));
      if(window.nativeKeys)s.setAttribute('data-gdh-native-rows',JSON.stringify(window.stamps.map((ts,i)=>({ts,tx:window.nativeKeys[i],addr:'native-address',side:'buy',chain:'eth'}))));
      s.style.height=`${window.stamps.length*window.rowHeight}px`;
      const start=Math.max(0,Math.min(window.stamps.length-window.poolSize,Math.floor(v.scrollTop/window.rowHeight)));
      (window.recycleLog ||= []).push([performance.now(),v.scrollTop,document.querySelector('.gdh-merged-tracker')?.scrollTop]);
      for(let j=0;j<window.poolSize;j++) {
        const i=start+j;
        let w=s.children[j];
        if(!w) {
          w=document.createElement('div');w.className='native-wrap';
          const c=document.createElement('button');c.dataset.sentryComponent='TrackerListItem';
          c.style.cssText=`height:${window.rowHeight}px;width:100%`;c.onclick=()=>window.nativeClicks++;
          w.append(c);s.append(w);
        }
        // A real pool retains the original native button/handler but replaces
        // wrapper cssText. Metadata lands in a later bridge turn.
        w.style.cssText=`position:absolute;top:0;transform:translateY(${i*window.rowHeight}px);height:${window.rowHeight}px;width:100%`;
        const c=w.firstChild;c.dataset.index=String(i);c.textContent=`Native ${i}`;
      }
      const stamp=()=>{for(const w of s.children){w.firstChild.dataset.gdhTrackTs=String(window.stamps[Number(w.firstChild.dataset.index)]);if(window.nativeKeys)w.firstChild.dataset.gdhTrackTx=window.nativeKeys[Number(w.firstChild.dataset.index)];}};
      clearTimeout(window.stampTimer);
      if(delayed) { window.__merged.scan();window.stampTimer=setTimeout(stamp,45); }
      else stamp();
    };
    document.querySelector('#viewport').addEventListener('scroll',()=>window.recycle(true));
    window.recycle();
    window.events=Array.from({length:72},(_,i)=>({key:`merged-${i}`,source:'fomo-followed',followed:true,type:'buy',userId:'alice',handle:'alice',symbol:'TEST',chain:'eth',addr:'0x3333333333333333333333333333333333333333',ts:window.stamps[i*2]-500,usd:1,...(i%3===0?{type:'thesis',comment:'Variable thesis '.repeat(1+i%11)}:{})}));
    window.render=()=>window.__merged.render([...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')],window.events);
  },height);
  assert.equal(await page.evaluate(()=>window.render()),true);
  assert.equal(await page.locator('.gdh-fomofeed').count(),72);
  assert.equal(await page.locator('.gdh-fomofeed-lane').count(),0);
  const seenNative=new Set(),seenFomo=new Set();
  await page.evaluate(()=>{window.originalSurface=document.querySelector('.gdh-merged-tracker');window.originalButtons=[...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')];});
  // Native overscan rows can retain stale stamps beyond the handoff deadline.
  await page.evaluate(()=>{window.overscan=document.querySelector('.native-wrap:last-child').firstChild;window.savedOverscanStamp=window.overscan.dataset.gdhTrackTs;window.overscan.dataset.gdhTrackTs='1';window.__merged.scan();});
  await page.waitForTimeout(1700);
  assert.equal(await page.evaluate(()=>document.querySelector('.gdh-merged-tracker')===window.originalSurface),true,'off-screen metadata cannot tear down the surface');
  await page.evaluate(()=>{window.overscan.dataset.gdhTrackTs=window.savedOverscanStamp;});
  for(const y of [...Array.from({length:64},(_,i)=>i*300),...Array.from({length:64},(_,i)=>(63-i)*300)]) {
    assert.equal(await page.locator('.gdh-merged-tracker').count(),1,`surface retained at ${y}; errors ${errors}`);
    await page.evaluate(y=>{document.querySelector('.gdh-merged-tracker').scrollTop=y;window.__merged.sync();},y);
    await page.waitForTimeout(150);
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')].every(c=>Number(c.dataset.gdhTrackTs)===window.stamps[Number(c.dataset.index)]));
    const report=await page.evaluate(()=>{
      const box=document.querySelector('.gdh-merged-tracker').getBoundingClientRect();
      const rows=[...document.querySelectorAll('[data-sentry-component="TrackerListItem"],.gdh-fomofeed')].map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,ts:Number(el.dataset.gdhTrackTs||el.querySelector('[data-gdh-fomo-ts]')?.dataset.gdhFomoTs),native:el.dataset.index,fomo:el.dataset.gdhFomoKey})).filter(r=>r.bottom>box.top&&r.top<box.bottom).sort((a,b)=>a.top-b.top);
      const m=window.__merged.state();
      const expected=window.stamps.map((_,i)=>{const top=i*window.rowHeight+m.slots.reduce((sum,s)=>sum+(s.at<=i*window.rowHeight+.25?s.height:0),0)-m.surface.scrollTop;return {i,top};}).filter(r=>r.top+window.rowHeight>0&&r.top<box.height).map(r=>String(r.i));
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
  assert.equal(seenNative.size,180,`native indices missing ${Array.from({length:180},(_,i)=>String(i)).filter(i=>!seenNative.has(i))}; geometry ${JSON.stringify(await page.evaluate(()=>({outer:document.querySelector('.gdh-merged-tracker').scrollTop,native:document.querySelector('#viewport').scrollTop,height:document.querySelector('#viewport').scrollHeight,rows:[...document.querySelectorAll('.native-wrap')].map(e=>[e.firstChild.dataset.index,e.getBoundingClientRect().top,e.style.translate])})))}`);
  assert.equal(seenFomo.size,72,'all 72 interleaved FOMO rows reachable');
  // Shrinking a provider snapshot at the bottom must reduce the real scroll
  // range. The absolutely positioned pinned native viewport is not an extent.
  const contraction=await page.evaluate(async()=>{
    const m=window.__merged.state();window.savedEvents=window.events;
    window.events=[...window.events,...Array.from({length:16},(_,i)=>({...window.events[0],key:`expired-tail-${i}`,type:'thesis',comment:'Tail thesis '.repeat(20),ts:window.stamps.at(-1)-1000-i}))];window.render();
    m.surface.scrollTop=1e9;window.__merged.sync();
    await new Promise(r=>setTimeout(r,180));
    window.events=window.events.slice(0,12);window.render();
    await new Promise(r=>setTimeout(r,250));
    const expected=Number.parseFloat(m.extent.style.height)-m.surface.clientHeight;
    return {y:m.surface.scrollTop,max:m.surface.scrollHeight-m.surface.clientHeight,expected};
  });
  assert.ok(contraction.y<=contraction.expected+1,`phantom bottom extent ${JSON.stringify(contraction)}`);
  assert.ok(Math.abs(contraction.max-contraction.expected)<1,`native viewport cannot enlarge outer extent ${JSON.stringify(contraction)}`);
  await page.evaluate(()=>{window.events=window.savedEvents;window.render();});
  // Browser scrollTop is rounded, native slots are fractional. Repeated idle
  // renders must be the identity mapping at every boundary, not just row centres.
  for (const boundary of [1,2,3,44,45,46,78,99]) {
    const drift=await page.evaluate(async index=>{
      const m=window.__merged.state(),at=index*window.rowHeight;
      m.surface.scrollTop=at+m.slots.reduce((n,s)=>n+(s.at<=at+.25?s.height:0),0);
      window.__merged.sync();
      await new Promise(r=>setTimeout(r,180));
      const before=m.surface.scrollTop;
      for(let i=0;i<12;i++) {window.render();await new Promise(r=>setTimeout(r,20));}
      return {before,after:m.surface.scrollTop,index};
    },boundary);
    assert.equal(drift.after,drift.before,`idle drift ${JSON.stringify(drift)}`);
  }
  // Keep a native anchor stable through repeated simultaneous native/provider arrivals.
  for (let arrival=0;arrival<8;arrival++) {
  await page.evaluate(()=>{
    const m=window.__merged.state(),at=45*window.rowHeight;
    m.surface.scrollTop=at+m.slots.reduce((sum,s)=>sum+(s.at<=at?s.height:0),0)+20;
    window.__merged.sync();
  });
  await page.waitForTimeout(250);
  const anchor=await page.evaluate(()=>({ts:window.stamps[45],top:document.querySelector('[data-index="45"]').getBoundingClientRect().top}));
  await page.evaluate(()=>{
    window.stamps.unshift(window.stamps[0]+1000);
    window.events.unshift({...window.events[0],key:`arrival-${window.stamps.length}`,ts:window.stamps[0]+500});
    window.recycle(true);window.render();
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.__merged.state().surface===window.originalSurface),true);
  // Measure the committed native row, not the asynchronously exported stamp on
  // a recycled node. The old timestamp lookup selected a different row during
  // the second scroll handoff (-20.5 -> 108 while the actual row stayed -21).
  const arrivalReport=await page.evaluate(ts=>({after:document.querySelector(`[data-index="${window.stamps.indexOf(ts)}"]`)?.getBoundingClientRect().top,m:(()=>{const m=window.__merged.state();return {y:m.surface.scrollTop,nativeY:m.viewport.scrollTop,pending:m.pendingSince,now:performance.now(),count:m.stamps.length,source:window.stamps.length,first:m.stamps[0],actualFirst:window.stamps[0],anchorIndex:m.stamps.indexOf(ts),slots:m.slots.slice(0,3),logs:window.recycleLog.slice(-12),renders:window.renderLog};})()}),anchor.ts);
  assert.ok(Math.abs(arrivalReport.after-anchor.top)<1,`native arrival anchor ${anchor.top} -> ${JSON.stringify(arrivalReport)}`);
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-sentry-component="TrackerListItem"]')].every(c=>Number(c.dataset.gdhTrackTs)===window.stamps[Number(c.dataset.index)]),null,{timeout:1500});
  }
  // A FOMO card is a separate anchor, not a rounded native boundary.
  await page.evaluate(()=>{const m=window.__merged.state(),s=m.slots[10];window.anchorKey=s.key;m.surface.scrollTop=s.top+20;window.__merged.sync();});
  await page.waitForTimeout(250);
  const fomoAnchor=await page.evaluate(()=>document.querySelector(`[data-gdh-fomo-key="${window.anchorKey}"]`).getBoundingClientRect().top);
  await page.evaluate(()=>{window.events.unshift({...window.events[0],key:'arrival-2',ts:window.stamps[0]+1000});window.render();});
  await page.waitForTimeout(250);
  assert.ok(Math.abs(await page.evaluate(()=>document.querySelector(`[data-gdh-fomo-key="${window.anchorKey}"]`).getBoundingClientRect().top)-fomoAnchor)<1);
  // A retained thesis/translation can grow without a new provider signature.
  // The observer must remeasure real fractional geometry and preserve the reader.
  const thesisResize=await page.evaluate(async()=>{
    const anchor=document.querySelector(`[data-gdh-fomo-key="${window.anchorKey}"]`),before=anchor.getBoundingClientRect().top;
    const thesis=document.querySelector('.gdh-fomofeed__thesis');
    thesis.append(document.createTextNode(' Late translated thesis.'.repeat(35)));
    await new Promise(r=>setTimeout(r,250));
    const m=window.__merged.state();
    return {before,after:anchor.getBoundingClientRect().top,exact:m.slots.every(s=>Math.abs(s.height-document.querySelector(`[data-gdh-fomo-key="${s.key}"]`).getBoundingClientRect().height)<.01)};
  });
  assert.ok(Math.abs(thesisResize.after-thesisResize.before)<1,`late thesis resize anchor ${JSON.stringify(thesisResize)}`);
  assert.equal(thesisResize.exact,true,'slot heights match actual fractional card rectangles');
  // Real wheel then an idle interval longer than bridge handoff/maintenance.
  await page.mouse.move(220,350);await page.mouse.wheel(0,420);await page.mouse.move(1000,800);
  await page.waitForTimeout(250);
  const idle=await page.evaluate(async()=>{
    const m=window.__merged.state(),before=m.surface.scrollTop;
    const samples=[];
    for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,160));samples.push(m.surface.scrollTop);}
    return {before,samples,same:m.surface===window.originalSurface};
  });
  assert.equal(idle.same,true);
  assert.ok(idle.samples.every(y=>y===idle.before),`wheel idle must not drift without arrivals ${JSON.stringify(idle)}`);
  // Same-second native bursts cannot be anchored by timestamp overlap alone.
  // Real transaction identities disambiguate recycled native index positions.
  const recycledAnchor=await page.evaluate(async()=>{
    const m=window.__merged.state();window.beforeRepeated={stamps:window.stamps,events:window.events};
    window.stamps=window.stamps.map(()=>window.stamps[0]);
    window.nativeKeys=window.stamps.map((_,i)=>`native-identity-${i}`);
    window.events=window.events.map(e=>({...e,ts:window.stamps[0]-500}));
    window.recycle();window.render();m.surface.scrollTop=45*window.rowHeight+20;window.__merged.sync();
    await new Promise(r=>setTimeout(r,200));
    const before=document.querySelector('[data-index="45"]').getBoundingClientRect().top;
    window.stamps.unshift(window.stamps[0]);window.nativeKeys.unshift('new-native-same-second');window.recycle(true);window.render();
    await new Promise(r=>setTimeout(r,300));
    return {before,after:document.querySelector(`[data-index="${window.nativeKeys.indexOf('native-identity-45')}"]`)?.getBoundingClientRect().top};
  });
  assert.ok(Math.abs(recycledAnchor.after-recycledAnchor.before)<1,`same-second native anchor ${JSON.stringify(recycledAnchor)}`);
  await page.evaluate(()=>{window.stamps=window.beforeRepeated.stamps;window.events=window.beforeRepeated.events;window.nativeKeys=null;document.querySelector('#spacer').removeAttribute('data-gdh-native-rows');window.recycle();window.render();});
  // Style-only reuse must repair removed translates without a stamp mutation.
  await page.evaluate(()=>{window.styleWrites=0;window.styleObserver=new MutationObserver(r=>window.styleWrites+=r.length);window.styleObserver.observe(document.querySelector('#spacer'),{subtree:true,attributes:true,attributeFilter:['style']});for(const w of document.querySelectorAll('.native-wrap'))w.style.translate='';});
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.native-wrap')].some(w=>!!w.style.translate)),true);
  const writes=await page.evaluate(()=>window.styleWrites);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>window.styleWrites),writes,'style observer settles, no self-write loop');
  // Transform-only recycling must be observed even if bridge attributes have
  // not changed yet (temporarily move one pool wrapper into a different slot).
  await page.evaluate(()=>{const w=document.querySelector('.native-wrap');window.oldTransform=w.style.transform;w.style.transform=`translateY(${50*window.rowHeight}px)`;});
  await page.waitForTimeout(200);
  const transformReport=await page.evaluate(()=>{
    const m=window.__merged.state(),w=document.querySelector('.native-wrap'),at=50*window.rowHeight;
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
  assert.equal(await page.locator('.gdh-fomofeed').count(),72+8+1,'all source events survive arrivals without a render cap');
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
  await page.evaluate(()=>{
    const viewport=document.querySelector("#viewport"),host=document.querySelector("#host");
    const toggle=document.createElement("button");toggle.dataset.icon="IconLayoutlist16pxRegular";document.body.append(toggle);
    toggle.addEventListener("click",()=>{window.nativeParentRestored=viewport.parentElement===host;host.removeChild(viewport);host.append(viewport);});
    toggle.click();toggle.remove();
  });
  assert.equal(await page.evaluate(()=>window.nativeParentRestored),true,"native layout handler receives original React parentage");
  await page.evaluate(()=>window.__merged.destroy());
  // Keep the feature disabled while queued observer/scanner work drains.
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.gdh-merged-tracker').count(),0);
  assert.equal(await page.locator('#host > #viewport').count(),1);
  assert.equal(await page.locator('.native-wrap').evaluateAll(els=>els.every(el=>!el.style.translate)),true);
  const diagnostics=await page.evaluate(()=>window.diagnosticMessages);
  for(const event of ['surface-created','surface-destroyed','validation-deferred','validation-failed','validation-recovered','scroll']) assert.ok(diagnostics.some(e=>e.event===event),event);
  assert.ok(diagnostics.some(e=>e.failure==='stamp-timeout'));
  assert.ok(diagnostics.some(e=>['nonuniform-rows','row-height-changed'].includes(e.failure)));
  assert.ok(diagnostics.filter(e=>e.event==='scroll').every(e=>Number.isFinite(e.scrollY)&&Number.isFinite(e.nativeY)));
  assert.deepEqual(errors,[]);
  await page.close();
  console.log('PASS merged scroll: 180 native + 72 FOMO reachable down/end/up, chronological/no missing slots, retained single surface, fractional in-place async recycling, native/FOMO arrival anchors, style-only reuse/no observer loop, original native handler/nodes, responsive widths, bounded stale rejection/recovery and teardown; synthetic host only',height);
 }
} finally {await browser.close();}
