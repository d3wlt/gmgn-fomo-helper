import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from 'playwright';
const root=new URL('../',import.meta.url),read=f=>fs.readFileSync(new URL(f,root),'utf8');
const ca='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const browser=await chromium.launch({headless:true});
try{
 for(const width of [360,320,220]){
 const page=await browser.newPage({viewport:{width,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><body></body>'}));
 await page.goto('https://gmgn.ai/robinhood/token/'+ca);
 await page.setContent(`<style>body{margin:0;background:#0a0a0a;color:#eee;font:14px Arial}.panel{display:flex;flex-direction:column;height:760px;width:100%}.header{height:48px;display:flex;align-items:center;flex-shrink:0;padding:0 12px}.pi-tabs{max-width:100%}.pi-tabs-nav-list{display:flex;gap:14px;width:max-content}.pi-tabs-tab{white-space:nowrap}.pi-tabs-tab-active{color:white}.native-body{flex:1}</style><div data-sentry-component="CommunityFeed"><div data-resizer></div><div class="panel"><div class="header"><div class="pi-tabs"><div class="pi-tabs-nav"><div class="pi-tabs-nav-wrap"><div class="pi-tabs-nav-list"><div class="pi-tabs-tab pi-tabs-tab-active"><button role="tab" aria-selected="true" id="fixture-tab-community">Callout</button></div><div class="pi-tabs-tab"><button role="tab" aria-selected="false" id="fixture-tab-x_tracker">X Tracker</button></div></div></div></div></div></div><div class="native-body">Original native Callout content</div></div></div>`);
 await page.evaluate(()=>{
  window.demands=[];window.storageListeners=[];window.nativeClicks=0;
  window.chrome={runtime:{id:'synthetic'},storage:{local:{get(defaults,cb){queueMicrotask(()=>cb(defaults));}},onChanged:{addListener(fn){storageListeners.push(fn);}}}};
  document.querySelector('#fixture-tab-x_tracker').addEventListener('click',()=>{nativeClicks++;document.querySelector('.native-body').textContent='Original native X Tracker content';});
  document.addEventListener('gdh-thesis-demand',()=>{const s=document.documentElement.getAttribute('data-gdh-thesis-demand');if(s)demands.push(JSON.parse(s));});
  window.send=(items,status='snapshot',req=demands.at(-1))=>{document.documentElement.setAttribute('data-gdh-thesis-result',JSON.stringify({...req,status,items}));document.dispatchEvent(new Event('gdh-thesis-result'));};
 });
 await page.addStyleTag({content:read('community-thesis.css')});await page.addScriptTag({content:read('community-thesis.js')});
 await page.locator('#gdh-thesis-tab').waitFor();assert.equal(await page.evaluate(()=>demands.length),0,'closed feed never requests');
 await page.locator('#gdh-thesis-tab').click();await page.waitForFunction(()=>demands.length===1);
 assert.equal(await page.locator('.native-body').isVisible(),false);assert.equal(await page.locator('#gdh-community-thesis').getAttribute('data-active'),'1');
 const items=Array.from({length:40},(_,i)=>({id:'thesis-'+i,chain:'robinhood',token_address:ca,token_symbol:'TEST',author_name:i===0?'A very long complete author name for narrow layouts':'Author '+i,author_handle:'synthetic_author_'+i,thesis:i===0?'Actual thesis body <script>throw Error("never execute")</script>\nSecond paragraph with details.':'Synthetic thesis '+i+' with full text shown in the native list.',like_count:i%3,fomo_created_at:Date.now()-i*60000}));
 await page.evaluate(items=>send(items),items);await page.waitForFunction(()=>document.querySelectorAll('.gdh-thesis-post').length===40);
 assert.equal(await page.locator('.gdh-thesis-post').first().locator('.gdh-thesis-person strong').textContent(),items[0].author_name);
 assert.equal(await page.locator('.gdh-thesis-text').first().textContent(),items[0].thesis);
 assert.equal(await page.locator('#gdh-community-thesis script').count(),0);assert.equal(await page.locator('.gdh-thesis-status').textContent(),'Snapshot');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal page overflow even at native 220px');
 assert.equal(await page.locator('.gdh-thesis-list').evaluate(e=>e.scrollHeight>e.clientHeight),true,'one scrollable feed');
 await page.locator('.gdh-thesis-list').evaluate(e=>e.scrollTop=520);const anchor=await page.locator('.gdh-thesis-list').evaluate(e=>{const b=e.getBoundingClientRect(),row=[...e.children].find(x=>x.getBoundingClientRect().bottom>b.top);return{id:row.dataset.thesisId,offset:row.getBoundingClientRect().top-b.top};});
 const newest={...items[1],id:'newest',fomo_created_at:Date.now()+1000};await page.evaluate(items=>send(items,'streaming'),[newest,...items]);
 const offset=await page.locator('.gdh-thesis-list').evaluate((e,id)=>e.querySelector(`[data-thesis-id="${id}"]`).getBoundingClientRect().top-e.getBoundingClientRect().top,anchor.id);assert.ok(Math.abs(offset-anchor.offset)<2,'new posts preserve reading anchor');
 await page.locator('.gdh-thesis-list').evaluate(e=>e.scrollTop=e.scrollHeight);assert.equal(await page.locator('[data-thesis-id=thesis-39]').isVisible(),true);
 await page.evaluate(items=>send(items,'error'),[newest,...items]);assert.equal(await page.locator('.gdh-thesis-post').count(),41);assert.equal(await page.locator('.gdh-thesis-status').textContent(),'Limited','partial valid records remain visible without claiming a complete snapshot');
 // Late prior-token packets cannot leak into the new token view.
 await page.evaluate(other=>{window.oldReq=demands.at(-1);history.pushState({},'',`/robinhood/token/${other}`);},other);await page.waitForFunction(()=>demands.length===2);
 assert.equal(await page.locator('.gdh-thesis-post').count(),0);await page.evaluate(items=>send(items,'snapshot',oldReq),items);assert.equal(await page.locator('.gdh-thesis-post').count(),0);
 await page.evaluate(()=>send([]));assert.match(await page.locator('.gdh-thesis-message').textContent(),/No theses/);
 await page.evaluate(()=>send([],'error'));assert.equal(await page.locator('.gdh-thesis-status').textContent(),'Unavailable');
 await page.locator('#fixture-tab-x_tracker').click();assert.equal(await page.evaluate(()=>nativeClicks),1);assert.equal(await page.locator('.native-body').isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-gdh-thesis-demand')),false);
 await page.locator('#gdh-thesis-tab').click();await page.waitForFunction(()=>demands.length===3);await page.evaluate(items=>send(items.map(i=>({...i,token_address:location.pathname.split('/').at(-1)}))),items.slice(0,5));
 await page.screenshot({path:new URL(`test-results/community-thesis-${width}.png`,root).pathname});
 await page.evaluate(()=>storageListeners.forEach(fn=>fn({enableFomoPanel:{newValue:false}},'local')));await page.waitForFunction(()=>!document.querySelector('#gdh-community-thesis'));
 assert.equal(await page.locator('.native-body').isVisible(),true);assert.equal(await page.locator('#fixture-tab-community').getAttribute('aria-selected'),'true');assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-gdh-thesis-demand')),false);
 assert.deepEqual(errors,[]);console.log(`PASS Community thesis UI ${width}px: opt-in lifecycle, exact plaintext/full names, bounded token identity, row anchors, empty/error, native tab preservation, disable teardown and no overflow`);
 await page.close();
 }
}finally{await browser.close();}
