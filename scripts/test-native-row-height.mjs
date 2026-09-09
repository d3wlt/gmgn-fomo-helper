import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from 'playwright';
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const b=await chromium.launch({headless:true});
try{const p=await b.newPage();await p.route('**/*',r=>r.abort());
await p.setContent(`<style>*{box-sizing:border-box}.slot{height:64.5px;position:relative;width:400px}.native{display:flex;flex-direction:column;justify-content:center;gap:4px;height:64.5px;border-bottom:1px solid}.native>div{height:18px}.other{height:64.5px}</style><div class="slot"><a class="native" data-sentry-component="TrackerListItem" data-gdh-flap-room="1"><div>Wallet and status</div><div>Amount token market cap</div></a></div><div class="other" data-gdh-flap-room="1">Normal Flap card</div>`);
const old=await p.addStyleTag({content:css.replaceAll('[data-gdh-flap-room="1"]:not([data-sentry-component="TrackerListItem"])','[data-gdh-flap-room="1"]')});
assert.equal(await p.locator('.native').evaluate(e=>e.getBoundingClientRect().height),41,'old production selector reproduces short native row');await old.evaluate(e=>e.remove());await p.addStyleTag({content:css});
for(const width of [400,280]){await p.locator('.slot').evaluate((e,w)=>e.style.width=w+'px',width);for(const marker of [true,false,true]){await p.locator('.native').evaluate((e,on)=>{if(on)e.dataset.gdhFlapRoom='1';else delete e.dataset.gdhFlapRoom},marker);const g=await p.locator('.native').evaluate(e=>({height:e.getBoundingClientRect().height,slot:e.parentElement.getBoundingClientRect().height,contained:[...e.children].every(c=>c.getBoundingClientRect().bottom<=e.getBoundingClientRect().bottom)}));assert.equal(g.height,g.slot);assert.equal(g.contained,true);}}
assert.notEqual(await p.locator('.other').evaluate(e=>e.getBoundingClientRect().height),64.5,'non-native Flap auto-size preserved');
console.log('PASS native fixed slot: old CSS reproduces 41px in 64.5px slot; fixed CSS preserves 64.5px with/without recycled marker at 400/280px; contents fit; non-native auto-height retained.');
}finally{await b.close();}
