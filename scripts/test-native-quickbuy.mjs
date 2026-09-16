import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true});
try {
 for (const layout of ['card','table']) for (const initialChain of ['eth','arc']) {
 const page=await browser.newPage();await page.route('**/*',r=>r.abort());
 await page.setContent('<div id="native" data-sentry-component="TrackerListItem"></div><div class="gdh-fomofeed" data-gdh-fomo-key="event1"><div class="gdh-native-buy-host" data-event-key="event1" data-chain="eth" data-address="0x1111111111111111111111111111111111111111" data-symbol="ONE" tabindex="0">Buy</div></div>');
 if(layout==='table') await page.evaluate(()=>{const n=document.querySelector('#native'),table=document.createElement('div');table.dataset.sentryComponent='TrackerTable';n.before(table);table.append(n);n.dataset.sentryComponent='TableItem';});
 await page.locator('.gdh-native-buy-host').evaluate((e,chain)=>{e.dataset.chain=chain;},initialChain);
 await page.evaluate(()=>{
  window.actions=[];window.mounts=[];window.amount='0.04';window.nav=0;
  const context={$$typeof:Symbol.for('react.context')};context.Provider=context;
  window.provider={type:context,memoizedProps:{value:{account:'synthetic-A'}},return:null};
  document.querySelector('#native').__reactFiber$test={type:'div',return:window.provider};
  const React={Component:class{},createElement:(type,props,child)=>({type,props:{...props,children:child}})};
  function QuickBuy(props){window.mounts.push({chain:props.network,address:props.tokenInfo.address,symbol:props.tokenInfo.symbol,buyType:props.buyType});return props;}
  const DOM={createRoot:host=>({unmount:()=>host.replaceChildren(),render:el=>{
   while(el.type!==QuickBuy)el=el.props.children;
   const props=QuickBuy(el.props),button=document.createElement('button');button.dataset.testid='quickbuy';button.textContent='Native fixture buy';
   button.addEventListener('click',()=>window.actions.push({chain:props.network,address:props.tokenInfo.address,amount:window.amount}));host.append(button);
  }})};
  const modules={14232:React,524279:DOM,278695:{A:QuickBuy}};
  const chunks=[[[1],{14232:function(){},524279:function(){},278695:function(){return 'data-testid quickbuy QuickBuy tokenInfo buyType';}}]];
  chunks.push=function(value){Array.prototype.push.call(this,value);value[2]?.(id=>modules[id]);return this.length;};window.webpackChunk_N_E=chunks;
  document.querySelector('.gdh-fomofeed').addEventListener('click',e=>{if(!e.target.closest('.gdh-native-buy-host'))window.nav++});
 });
 await page.addScriptTag({content:fs.readFileSync(new URL('../native-quickbuy.js',import.meta.url),'utf8')});
 const host=page.locator('.gdh-native-buy-host');await host.hover();await page.waitForSelector('[data-testid=quickbuy]');await page.waitForTimeout(400);
 assert.equal(await page.evaluate(()=>actions.length),0,'mount never trades');
 assert.deepEqual(await page.evaluate(()=>mounts.at(-1)),{chain:initialChain,address:'0x1111111111111111111111111111111111111111',symbol:'ONE',buyType:'follow'});
 await page.locator('[data-testid=quickbuy]').click();assert.deepEqual(await page.evaluate(()=>actions),[{chain:initialChain,address:'0x1111111111111111111111111111111111111111',amount:'0.04'}]);
 assert.equal(await page.evaluate(()=>nav),0);
 await page.evaluate(()=>amount='0.08');await page.locator('[data-testid=quickbuy]').click();assert.equal(await page.evaluate(()=>actions.at(-1).amount),'0.08');
 await page.evaluate(()=>document.querySelector('[data-testid=quickbuy]').click());assert.equal(await page.evaluate(()=>actions.length),2,'scripted purchase rejected');
 await page.evaluate(()=>provider.memoizedProps.value={account:'synthetic-B'});await page.locator('[data-testid=quickbuy]').click();assert.equal(await page.evaluate(()=>actions.length),2,'stale context blocked');
 await page.mouse.move(700,500);await host.hover();await page.waitForSelector('[data-testid=quickbuy]');await page.waitForTimeout(400);
 await host.evaluate(e=>{e.dataset.chain='bsc'});await page.waitForTimeout(30);await page.mouse.move(700,500);await host.hover();await page.waitForSelector('[data-testid=quickbuy]');await page.waitForTimeout(400);await page.locator('[data-testid=quickbuy]').click();assert.equal(await page.evaluate(()=>actions.at(-1).chain),'bsc','same address different chain rebound');
 await page.evaluate(()=>{
  // A shared host retains stale return pointers but lives under new committed providers.
  const native=document.querySelector('#native'),hostFiber=native.__reactFiber$test;
  hostFiber.stateNode=native;
  const committedProvider={...provider,memoizedProps:{value:{account:'committed'}}};
  const committedRoot={child:committedProvider};committedProvider.child=hostFiber;
  // A real Fusion page placed the tracker beyond the old 20k-node limit.
  for(let i=0;i<25000;i++)committedRoot.child={type:'div',sibling:committedRoot.child};
  const oldRoot={stateNode:{current:committedRoot}};provider.return=oldRoot;
  window.committedProvider=committedProvider;
 });
 await page.mouse.move(700,500);await host.hover();await page.waitForSelector('[data-testid=quickbuy]');await page.waitForTimeout(400);
 await page.locator('[data-testid=quickbuy]').hover();await page.waitForTimeout(400);
 await page.evaluate(()=>committedProvider.memoizedProps.value={account:'changed-committed'});
 // Keep the pointer stationary: locator.click may move it and legitimately rebind
 // via pointerover, making this stale-context test depend on automation timing.
 await page.mouse.down();await page.mouse.up();assert.equal(await page.evaluate(()=>actions.length),3,'committed provider change blocked despite stale host return');
 await host.evaluate(e=>{e.dataset.address='bad'});await page.waitForTimeout(30);await page.mouse.move(700,500);await host.hover();assert.equal(await page.locator('[data-testid=quickbuy]').count(),0,'invalid address unavailable');
 assert.equal(await page.evaluate(()=>actions.length),3);
 await host.evaluate(e=>{e.dataset.address='0x2222222222222222222222222222222222222222';e.closest('.gdh-fomofeed').dataset.gdhFomoStale='1'});await page.mouse.move(700,500);await host.hover();assert.equal(await page.locator('[data-testid=quickbuy]').count(),0,'stale event unavailable');
 // Robinhood uses the native component with explicit identity, never BSC defaults.
 await host.evaluate(e=>{e.closest('.gdh-fomofeed').dataset.gdhFomoStale='0';e.dataset.chain='robinhood';});
 await page.mouse.move(700,500);await host.hover();await page.waitForSelector('[data-testid=quickbuy]');await page.waitForTimeout(400);
 assert.equal(await page.evaluate(()=>actions.length),3,'Robinhood mount cannot trade');
 assert.deepEqual(await page.evaluate(()=>mounts.at(-1)),{chain:'robinhood',address:'0x2222222222222222222222222222222222222222',symbol:'ONE',buyType:'follow'});
 await page.locator('[data-testid=quickbuy]').click();
 assert.deepEqual(await page.evaluate(()=>actions.at(-1)),{chain:'robinhood',address:'0x2222222222222222222222222222222222222222',amount:'0.08'});
 await host.evaluate(e=>{e.dataset.chain='bsc'});await page.waitForTimeout(30);await page.mouse.move(700,500);await host.hover();await page.waitForSelector('[data-testid=quickbuy]');await page.waitForTimeout(400);
 assert.equal(await page.evaluate(()=>mounts.at(-1).chain),'bsc','same EVM address cannot retain Robinhood context');
 await host.evaluate(e=>{e.dataset.chain='unsupported'});await page.waitForTimeout(30);await page.mouse.move(700,500);await host.hover();
 assert.equal(await page.locator('[data-testid=quickbuy]').count(),0,'unknown chain fails closed');
 assert.equal(await page.evaluate(()=>actions.length),4);
 console.log(`PASS native quick-buy adapter synthetic offline (${layout}, ${initialChain}): exact identity and cross-chain rebinding; no trade on mount; live amount; one action per click; no navigation; untrusted input, stale context, invalid identity and stale event rejected. Native execution itself is not exercised.`);
 await page.close();
 }
}finally{await browser.close();}
