// Retired-feature regression: real production popup/content, synthetic offline browser.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const read = f => fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const manifest = JSON.parse(read('manifest.json'));
for(const f of ['popup.js','content.js']) assert.doesNotMatch(read(f),/enableFlapTax|enableManifestoToast|enableManifestoTab|flapRpc/);
assert.doesNotMatch(read('background.js'),/flap-token-info|flapTokenInfo/);
assert.equal(manifest.optional_host_permissions,undefined);
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext();
 await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://gmgn.ai/');
 await page.evaluate(version=>{
  const state={enableFlapTax:true,enableManifestoToast:true,enableManifestoTab:true,flapRpc:'https://retired-rpc.invalid',enableHoldingSurge:false,enableFomoFeed:false,enablePumpFeed:false,enableFomoPanel:false,enableMarkedHolders:false,markedListMigratedV2:true};
  window.calls=[];
  const local={get(k,cb){const result=Array.isArray(k)?Object.fromEntries(k.filter(x=>x in state).map(x=>[x,state[x]])):{...k,...state};if(cb){queueMicrotask(()=>cb(result));return;}return Promise.resolve(result);},set(v,cb){Object.assign(state,v);cb?.();return Promise.resolve();},remove(k,cb){for(const x of Array.isArray(k)?k:[k])delete state[x];cb?.();return Promise.resolve();}};
  window.chrome={runtime:{id:'synthetic-extension',getManifest:()=>({version}),getURL:p=>p,onMessage:{addListener(){}},sendMessage(m,cb){calls.push(m.type);const res={ok:false,events:[],items:[]};cb?.(res);return Promise.resolve(res);}},storage:{local,onChanged:{addListener(){}}}};
 },manifest.version);
 await page.setContent(read('popup.html').replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'').replace(/<link[^>]+>/g,''));
 await page.addScriptTag({content:read('popup.js')});
 await page.waitForTimeout(150);
 for(const id of ['enable-manifesto-toast','enable-manifesto-tab','enable-flap-tax','flap-rpc'])assert.equal(await page.locator('#'+id).count(),0);
 await page.locator('#save').click();await page.waitForTimeout(150);assert.deepEqual(errors,[]);
 await page.setContent('<span data-sentry-component="ManifestoChipInner">Native manifesto</span><span>Native tax</span>');
 await page.addScriptTag({content:read('content.js')});await page.waitForTimeout(1000);
 assert.equal(await page.locator('.gdh-mani-toast-container,.gdh-mani-tab,.gdh-flap,.gdh-flap-row').count(),0);
 assert.equal(await page.getByText('Native manifesto',{exact:true}).isVisible(),true);
 assert.equal(await page.getByText('Native tax',{exact:true}).isVisible(),true);
 assert.equal(await page.evaluate(()=>calls.includes('flap-token-info')),false);
 assert.deepEqual(errors,[]);
 console.log('PASS retired manifesto/Flap/custom RPC controls absent; popup saves; legacy ON values cannot restore features; native content remains; zero browser errors.');
} finally {await browser.close();}
