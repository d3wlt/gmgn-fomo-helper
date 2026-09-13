// Full production content/CSS in isolated Chromium; synthetic responses only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root = new URL('../', import.meta.url);
const read = f => fs.readFileSync(new URL(f, root), 'utf8');
const output = new URL('test-results/', root).pathname;
fs.mkdirSync(output, {recursive:true});
const browser = await chromium.launch({headless:true});
const reports = [];
try {
 const page = await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*', r=>r.request().isNavigationRequest() ? r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="fr"><body style="margin:0;background:#101114;color:#ddd;font:13px system-ui"><div data-sentry-component="BaseInfoBar">Offline synthetic token fixture</div></body></html>'}) : r.abort());
 await page.routeWebSocket('**/*',s=>s.close());
 await page.goto('https://gmgn.ai/eth/token/0x1111111111111111111111111111111111111111');
 await page.evaluate(()=>{
  const state={enabled:true,enableFomoPanel:true,fomoPanelOpen:true,fomoTranslate:false,language:'zh',locale:'zh-CN',enableFomoFeed:false,enablePumpFeed:false,enableMarkedHolders:false,enableHoldingSurge:false,markedListMigratedV2:true};
  const listeners=[];
  window.calls=[];window.translationTargets=[];window.opened=[];window.open=(...args)=>opened.push(args);
  window.names=Array.from({length:60},(_,i)=>i===0?'frankdegods':`long_followed_holder_name_with_all_badges_${i}`);
  const avatar='https://fixture.invalid/avatar';
  window.items=names.map((name,i)=>({user:{id:String(i+1),userHandle:name,displayName:'Do not replace the handle',profilePictureLink:avatar},followed:true,humanAmount:10000,value:151900,pnl:175000,costBasis:100,averageEntryPrice:0.00000042,averageHoldTimeSeconds:86400,comment:{comment:'Bonjour tout le monde'}}));
  window.change=values=>listeners.forEach(fn=>fn(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{newValue:v}])),'local'));
  window.Translator={availability:async()=> 'available',create:async opts=>{translationTargets.push(opts.targetLanguage);return {translate:async()=> 'Hello everyone'};}};
  window.LanguageDetector={availability:async()=> 'available',create:async()=>({detect:async()=>[{detectedLanguage:'fr',confidence:1}]})};
  const local={get(keys,cb){const out=typeof keys==='object'&&!Array.isArray(keys)?{...keys}:{};for(const k of typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(out))if(k in state)out[k]=state[k];if(cb){queueMicrotask(()=>cb(out));return;}return Promise.resolve(out);},set(v,cb){Object.assign(state,v);cb?.();return Promise.resolve();}};
  function sendMessage(m,cb){calls.push(m);const result=m.type==='fomo-token-feed'?{ok:true,source:m.payload.kind==='holders'?'holders':'token-feed',followingKnown:true,fetchedAt:Date.now(),total:60,items:m.payload.kind==='holders'?items:items.slice(0,3)}:m.type==='fomo-user-pnl'?{ok:true,pnl:1600000,equity:2000000}:m.type==='token-supply'?{ok:true,supply:1000000000}:{ok:false,events:[]};if(cb){queueMicrotask(()=>cb(result));return;}return Promise.resolve(result);}
  window.chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),getURL:p=>p,sendMessage,onMessage:{addListener(){}}},storage:{local,onChanged:{addListener:fn=>listeners.push(fn)}}};
 });
 await page.route('https://fixture.invalid/avatar',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#8978b0"/></svg>'}));
 const hooks=`window.layoutTest={seed(){onchainBalances={key:'eth|0x1111111111111111111111111111111111111111',list:[20000,15000,10000,5000]};for(const name of window.names)FOMO_BOARD[name]='a2s7k';renderFomoUiItems();},english:()=>settings.fomoTranslate,card:(ev,table)=>buildFomoFeedCard(ev,table)};`;
 await page.addStyleTag({content:read('styles.css')});
 await page.addScriptTag({content:read('content.js').replace(/\}\)\(\);\s*$/,hooks+'})();')});
 await page.getByRole('button',{name:'Holders',exact:true}).click();
 await page.waitForSelector('.gdh-fomo__hrow');await page.evaluate(()=>layoutTest.seed());
 await page.waitForFunction(()=>document.querySelector('.gdh-fomo__tag')?.textContent.includes('1.6M'));
 await page.waitForSelector('.gdh-fomo__zh');
 assert.equal(await page.evaluate(()=>layoutTest.english()),true,'legacy saved false cannot disable English');
 await page.evaluate(()=>change({fomoTranslate:false,language:'zh',locale:'zh-CN'}));
 assert.equal(await page.evaluate(()=>layoutTest.english()),true,'storage updates cannot disable English');
 assert.equal(await page.locator('.gdh-fomo__tr').count(),0);
 assert.deepEqual(await page.evaluate(()=>[...new Set(translationTargets)]),['en']);
 assert.equal(await page.locator('.gdh-fomo-panel').getAttribute('lang'),'en');
 for(const width of [1280,390,320]) {
  await page.setViewportSize({width,height:900});
  await page.locator('.gdh-fomo__body').evaluate(el=>el.scrollTop=0);
  const metrics=await page.locator('.gdh-fomo-panel').evaluate(panel=>{
   const els=[panel,...panel.querySelectorAll('*')];
   const scroll=els.filter(el=>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY)&&el.scrollHeight>el.clientHeight+1).map(el=>el.className);
   const overflow=els.filter(el=>el.clientWidth&&el.scrollWidth>el.clientWidth+1).map(el=>({cls:el.className,w:el.clientWidth,scroll:el.scrollWidth}));
   const names=[...panel.querySelectorAll('.gdh-fomo__name')].map(el=>({text:el.textContent,width:el.getBoundingClientRect().width,full:el.scrollHeight<=el.clientHeight+1&&getComputedStyle(el).whiteSpace==='normal'}));
   return {viewport:innerWidth,width:panel.getBoundingClientRect().width,scroll,overflow,names};
  });
  assert.equal(metrics.viewport,width);assert.deepEqual(metrics.scroll,['gdh-fomo__body']);assert.deepEqual(metrics.overflow,[]);
  assert.equal(metrics.names.length,60);assert.ok(metrics.names.every(n=>n.full&&n.width>70),JSON.stringify(metrics));assert.ok(metrics.names.slice(1).every(n=>n.width>180));
  assert.deepEqual(metrics.names.map(n=>n.text),await page.evaluate(()=>names));
  for(const cls of ['gdh-fomo__board','gdh-fomo__following','gdh-fomo-rank','gdh-fomo__tag']) assert.equal(await page.locator('.gdh-fomo__hrow').first().locator('.'+cls).count(),1);
  await page.screenshot({path:output+`fomo-holders-layout-${width}.png`});
  await page.locator('.gdh-fomo__body').hover();await page.mouse.wheel(0,700);await page.waitForTimeout(200);
  assert.ok(await page.locator('.gdh-fomo__body').evaluate(el=>el.scrollTop>0),'wheel scroll remains usable');
  await page.locator('.gdh-fomo__body').focus();await page.keyboard.press('Control+End');
  await page.locator('.gdh-fomo__body').evaluate(el=>el.scrollTop=el.scrollHeight);
  const last=await page.locator('.gdh-fomo__hrow').last().evaluate(el=>{const r=el.getBoundingClientRect(),b=el.closest('.gdh-fomo__body').getBoundingClientRect();return r.bottom<=b.bottom+1&&r.bottom>b.top;});assert.ok(last,'last loaded holder reachable');
  reports.push({kind:'holders',width,scroll:metrics.scroll,horizontalOverflow:metrics.overflow.length,fullNames:metrics.names.length,lastReachable:last});
 }
 await page.setViewportSize({width:390,height:900});
 for(const tab of ['Narratives','Trades','Holders']){await page.getByRole('button',{name:tab,exact:true}).click();await page.waitForFunction(tab=>document.querySelector('.gdh-fomo__tab.is-active')?.textContent===tab,tab);assert.ok(await page.locator('.gdh-fomo__list').innerText());}
 await page.locator('.gdh-fomo__fold').click();assert.equal(await page.locator('.gdh-fomo__body').isVisible(),false);await page.locator('.gdh-fomo__fold').click();assert.equal(await page.locator('.gdh-fomo__body').isVisible(),true);
 await page.locator('.gdh-fomo__close').click();await page.waitForFunction(()=>!document.querySelector('.gdh-fomo-panel'));await page.locator('.gdh-fomo-launcher').click();await page.waitForSelector('.gdh-fomo-panel');
 await page.evaluate(()=>change({enableFomoPanel:false,enabled:false}));await page.waitForFunction(()=>!document.querySelector('.gdh-fomo-panel'));
 // The reported truncated rows are FOMO insertions, not native GMGN names.
 // Build the real card/table renderer without touching native rows or recycler.
 for(const width of [1000,570,390])for(const table of [true,false]){
  await page.setViewportSize({width,height:900});
  await page.evaluate(({width,table})=>{
   document.querySelector('#cards')?.remove();const host=document.createElement('div');host.id='cards';host.style.cssText=`width:${width}px;max-width:100%;margin-top:30px`;document.body.append(host);
   for(const handle of ['C0brahan_full_name','pinguchar_full_name','frankdegods','bluntz_capital','long_trader_handle_123456']){
    const card=layoutTest.card({key:handle,source:'fomo-followed',type:'buy',name:handle.slice(0,8),handle,userId:'fixture',symbol:'LEVERSTONE',chain:'sol',addr:'So11111111111111111111111111111111111111112',usd:1700,mc:151500,position:'More',ts:Date.now()-60000},table);host.append(card);
   }
  },{width,table});
  const metrics=await page.locator('#cards').evaluate(host=>({width:host.clientWidth,scroll:host.scrollWidth,rows:[...host.children].map(row=>({height:row.getBoundingClientRect().height,name:(()=>{const n=row.querySelector('.gdh-fomofeed__name');return {text:n.textContent,full:n.scrollHeight<=n.clientHeight+1&&n.scrollWidth<=n.clientWidth+1,ellipsis:getComputedStyle(n).textOverflow};})(),cells:[...row.querySelectorAll('.gdh-fomofeed__tcell')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:el.clientWidth,scroll:el.scrollWidth};})}))}));
  assert.equal(metrics.scroll,metrics.width);assert.ok(metrics.rows.every(r=>r.name.full&&r.name.ellipsis!=='ellipsis'),JSON.stringify({width,table,metrics}));
  assert.ok(metrics.rows.every(r=>Math.abs(r.height-(table?45:64.5))<.1),'fixed row heights preserved');
  for(const row of metrics.rows)for(let i=1;i<row.cells.length;i++)assert.ok(row.cells[i].left>=row.cells[i-1].right-.1,'columns do not overlap');
  await page.mouse.move(0,899);
  await page.screenshot({path:output+`fomo-trader-names-${table?'table':'card'}-${width}.png`});
  await page.locator('#cards .gdh-fomofeed__name').first().click();assert.match(await page.evaluate(()=>opened.at(-1)?.[0]||''),/C0brahan_full_name/i,'original profile action retained');
  reports.push({kind:table?'table':'card',width,metrics});
 }
 // Exceptional names: literal dots, full-name hover/focus, Unicode and recycling.
 for (const width of [1000,570,390,320]) for (const table of [true,false]) {
  await page.setViewportSize({width,height:900});
  const extreme = ['D'+'U'.repeat(300), '👩🏽‍💻e\u0301🇵🇱'.repeat(100), '<script>very_long_name</script>'.repeat(12)];
  await page.evaluate(({extreme,table}) => {
   const host=document.querySelector('#cards');host.replaceChildren();host.style.width='100%';
   for(const handle of extreme) host.append(layoutTest.card({key:handle,source:'fomo-followed',type:'buy',handle,name:handle,symbol:'TEST',ts:Date.now(),usd:5},table));
  },{extreme,table});
  await page.waitForFunction(()=>[...document.querySelectorAll('#cards .gdh-fomofeed__name')].every(n=>n.dataset.truncated==='true'));
  for(let i=0;i<extreme.length;i++) {
   const name=page.locator('#cards .gdh-fomofeed__name').nth(i);
   const text=await name.textContent();assert.ok(text.endsWith('...'));
   const segments=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(extreme[i]),p=>p.segment);
   assert.ok(segments.some((_,j)=>segments.slice(0,j+1).join('')===text.slice(0,-3)),'prefix ends on a grapheme boundary');
   await name.hover();const tip=page.locator('.gdh-fomofeed-name-tooltip');await tip.waitFor();assert.equal(await tip.textContent(),extreme[i]);
   await tip.hover();await page.waitForTimeout(180);assert.ok(await tip.isVisible(),'tooltip remains hoverable');
   await name.focus();assert.equal(await tip.textContent(),extreme[i]);
   assert.equal(await name.getAttribute('aria-describedby'),await tip.getAttribute('id'));
   const geometry=await name.evaluate(n=>{const r=n.closest('.gdh-fomofeed').getBoundingClientRect(),t=document.querySelector('.gdh-fomofeed-name-tooltip').getBoundingClientRect();return {height:r.height,fit:n.scrollHeight<=n.clientHeight+1&&n.scrollWidth<=n.clientWidth+1,bounded:t.left>=8&&t.top>=8&&t.right<=innerWidth-7&&t.bottom<=innerHeight-7};});
   assert.ok(geometry.fit&&geometry.bounded);assert.equal(geometry.height,table?45:64.5);
   if(i===0)await page.screenshot({path:output+`fomo-extreme-name-tooltip-${table?'table':'card'}-${width}.png`});
   await page.keyboard.press('Escape');assert.equal(await tip.count(),0);
   await name.evaluate(n=>n.blur());
  }
  if(width===320) {
   const name=page.locator('#cards .gdh-fomofeed__name').first();const narrow=await name.textContent();
   await page.setViewportSize({width:1000,height:900});
   await page.waitForFunction(narrow=>document.querySelector('#cards .gdh-fomofeed__name').textContent.length>narrow.length,narrow);
   await page.setViewportSize({width:320,height:900});
   await page.waitForFunction(narrow=>document.querySelector('#cards .gdh-fomofeed__name').textContent===narrow,narrow);
  }
  const name=page.locator('#cards .gdh-fomofeed__name').first();await name.focus();await name.evaluate(n=>n.closest('.gdh-fomofeed').remove());await page.waitForFunction(()=>!document.querySelector('.gdh-fomofeed-name-tooltip'));
  reports.push({kind:'exceptional-name-tooltip',width,table,unicode:true,bounded:true,hoverAndKeyboard:true,recycleCleanup:true});
 }
 assert.deepEqual(errors,[]);
 fs.writeFileSync(output+'fomo-panel-layout-results.json',JSON.stringify(reports,null,2));
 console.log('PASS FOMO holders: one reachable scroll region, no horizontal overflow, 60 full names/all badges at 1280/390/320; English legacy init/change, tabs/fold/close/reopen. Tracker full available handles at 1000/570/390 in table/card, fixed 45/64.5px rows, separate columns and profile actions. Synthetic data; no live accounts.');
} finally {await browser.close();}
