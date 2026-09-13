import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('..',import.meta.url));process.chdir(root);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gdh-native-visibility-'));
const proc=spawn(chromium.executablePath(),['--headless=new',...(process.platform==='linux'?['--no-sandbox']:[]),'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,`--load-extension=${root}`,`--disable-extensions-except=${root}`,'--host-resolver-rules=MAP * ~NOTFOUND','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
// Register before any asynchronous work: a signalled exit leaves exitCode null.
const procExited=new Promise(resolve=>proc.once('exit',resolve));
let browser;
try{
 const portFile=path.join(profile,'DevToolsActivePort'),deadline=Date.now()+15000;
 let port='';while(!port){if(proc.exitCode!==null||Date.now()>deadline)throw Error('Disposable Chrome failed readiness');const text=fs.existsSync(portFile)?fs.readFileSync(portFile,'utf8'):'';if(/^[0-9]+\n\/devtools\/browser\//.test(text))port=text.split('\n')[0];else await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});
 const context=browser.contexts()[0];
 const worker=context.serviceWorkers().find(w=>w.url().includes('bdhjiabmohplopjledcagfaejbgdeonf'))||await context.waitForEvent('serviceworker',{predicate:w=>w.url().includes('bdhjiabmohplopjledcagfaejbgdeonf'),timeout:10000});
 await worker.evaluate(()=>{globalThis.__visibilityReads=0;chrome.runtime.onMessage.addListener(m=>{if(m.type==='fomo-trending')globalThis.__visibilityReads++;return false;});});
 await worker.evaluate(()=>chrome.storage.local.set({enableFomoPanel:true,enableFomoFeed:false,enableHoldingSurge:false,enableMarkedHolders:false,markedListMigratedV2:true}));
 const test=fs.readFileSync('scripts/test-token-discovery-browser.mjs','utf8'),a=test.indexOf('const html='),z=test.indexOf('const browser=',a);
 const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222';
 const html=vm.runInNewContext(test.slice(a,z).replace('const html=',''),{A,B});
 await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://gmgn.ai/bsc/token/'+A);
 const original=await worker.evaluate(async()=>{const[t]=await chrome.tabs.query({url:'https://gmgn.ai/*'});await chrome.tabs.update(t.id,{active:true});return t.id;});
 await page.locator('.gdh-discovery-trending-tab').waitFor({timeout:10000});await page.locator('.gdh-discovery-trending-tab').click();
 assert.equal(await page.locator('.gdh-discovery-trending-tab').getAttribute('aria-pressed'),'true');
 const reads=await worker.evaluate(()=>__visibilityReads);assert.equal(reads,1);
 const temp=await worker.evaluate(async id=>{const t=await chrome.tabs.get(id);return(await chrome.tabs.create({windowId:t.windowId,url:'about:blank#away',active:true})).id;},original);
 const away=await page.evaluate(()=>({visibility:document.visibilityState,hidden:document.hidden}));assert.equal(away.visibility,'hidden');
 await page.waitForFunction(()=>document.visibilityState==='hidden',null,{polling:100,timeout:5000});
 assert.equal(await page.locator('.gdh-discovery-trending-tab').count(),0);assert.equal(await page.locator('#body').isVisible(),true);
 await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),original);
 await page.waitForFunction(()=>document.visibilityState==='visible'&&document.querySelector('.gdh-discovery-trending-tab')?.getAttribute('aria-pressed')==='true',null,{polling:100,timeout:5000});
 assert.equal(await page.locator('#body').isVisible(),false);assert.deepEqual(errors,[]);assert.equal(await worker.evaluate(()=>__visibilityReads),reads,'Visibility restoration does not read again');
 const result={realMV3:true,actualNativeVisibility:true,syntheticHost:true,liveAccount:false,visibilityPropertyOverrides:false,hiddenCleanup:true,selectionRestored:true,additionalReadsOnRestore:0};
 fs.writeFileSync('test-results/native-visibility-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 await worker.evaluate(id=>chrome.tabs.remove(id),temp);
}finally{
 if(browser)await browser.close().catch(()=>{});
 proc.kill();
 const forceKill=setTimeout(()=>proc.kill('SIGKILL'),5000);forceKill.unref();
 try{await procExited;}finally{clearTimeout(forceKill);}
 // Chromium descendants can finish profile writes after the parent exits.
 // Retry transient ENOTEMPTY/EBUSY with a bound; never swallow cleanup failure.
 await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 assert.equal(fs.existsSync(profile),false,'Disposable profile removed after shutdown');
 console.log('PASS owned Chromium exit and profile removal');
}
