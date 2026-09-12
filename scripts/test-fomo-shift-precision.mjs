import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({body:'<body></body>',contentType:'text/html'}));
 await page.goto('https://gmgn.ai/');
 await page.evaluate(()=>{window.chrome={storage:{local:{get:(k,c)=>c({enabled:false}),set(){}},onChanged:{addListener(){}}},runtime:{getURL:x=>x,getManifest:()=>({version:'test'}),onMessage:{addListener(){}},sendMessage:(m,c)=>c?.({ok:false})}}});
 const source=fs.readFileSync(new URL('../content.js',import.meta.url),'utf8').replace(/\}\)\(\);\s*$/, 'window.__precision={set:setFomoFeedRowShift,row:fomoFeedFixedRow,usd:fomoUsd,build:buildFomoFeedTableRow};})();');
 await page.addScriptTag({content:source});
 const results=await page.evaluate(()=>{
  const parent=document.createElement('div');parent.style.cssText='position:relative;height:500px';
  const wrap=document.createElement('div');wrap.style.cssText='position:absolute;top:90px;height:45px';const card=document.createElement('div');wrap.append(card);parent.append(wrap);document.body.append(parent);
  return [71.3333333333,107.19999694824219,48.123456789].map(amount=>{__precision.set(wrap,amount);const top=__precision.row(card).top;const serialized=wrap.style.translate;__precision.set(wrap,amount);const same=serialized===wrap.style.translate;wrap.style.translate='';const cleared=__precision.row(card).top;return{amount,serialized,top,same,cleared}});
 });
 for(const r of results){assert.ok(Math.abs(r.top-90)<.01,JSON.stringify(r));assert.equal(r.same,true);assert.equal(r.cleared,90);}
 const compact=await page.evaluate(()=>{
  const card=document.createElement('div');__precision.build({source:'fomo-followed',name:'ReturnOfThe',handle:'ReturnOfThe',type:'buy',ts:Date.now(),mc:98993500000},card,{label:'Buy'});
  return {star:!!card.querySelector('.gdh-fomofeed__src'),name:card.querySelector('.gdh-fomofeed__name').textContent,mc:card.querySelector('.gdh-fomofeed__tmc').textContent,formats:[1e12,999950000,999950,111600].map(__precision.usd)};
 });
 assert.equal(compact.star,false);assert.equal(compact.name,'ReturnOfThe');assert.equal(compact.mc,'$99.0B');assert.deepEqual(compact.formats,['$1.0T','$1.0B','$1.0M','$111.6K']);
 console.log('PASS compact row: no redundant star, intact name, B/T market-cap units');
 console.log('PASS actual CSSOM fractional translation roundtrip preserves native geometry and removed-shift detection',results);
}finally{await browser.close()}
