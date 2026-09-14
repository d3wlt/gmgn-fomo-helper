// Offline retirement regression: execute the complete production worker with hostile legacy storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.ok(!JSON.stringify({...manifest,key:''}).match(/j7tracker|debot|socket\.io/i));
assert.ok(!fs.existsSync(new URL('../j7-content.js', import.meta.url)));
assert.ok(!fs.existsSync(new URL('../vendor/socket.io.min.js', import.meta.url)));
for (const file of ['content.js','popup.js','popup.html']) {
  assert.doesNotMatch(read(file), /j7tracker|j7Ui|scheduleJ7|enablePumpFeed|['"](?:fomo-feed|pump-feed|gdh-fomo-push|gdh-pump-push)['"]/i, file);
}
assert.doesNotMatch(read('scripts/build-release.ps1'), /j7-content|socket\.io/);
assert.ok(!JSON.parse(read('package.json')).devDependencies['socket.io-client']);
for (const file of ['debot-content.js','debot-bridge.js','debot-styles.css']) assert.ok(!fs.existsSync(new URL(`../${file}`,import.meta.url)));
assert.doesNotMatch(read('scripts/build-release.ps1'), /debot/);
const legacy = () => ({enableFomoFeed:true, enablePumpFeed:true, debotFomoPanelOpen:true, debotFomoPanelTab:'swaps',
  j7TrackerSessionV1:{token:'SYNTHETIC_ONLY',accountId:'old-account'},
  j7TrackerSyncStateV1:{connected:true},j7TrackerFomoConfigV1:{connected:true,trackedCount:9},
  j7TrackerPumpConfigV1:{connected:true,trackedCount:9}});
for (const cleanupFails of [false,true]) {
  const local=legacy(), session={j7TrackerCacheV1:{fomo:[{key:'old-fomo'}],pump:[{key:'old-pump'}]}};
  const calls=[], reads=[], writes=[], timers=[], listeners={};
  const event=name=>({addListener:fn=>(listeners[name]??=[]).push(fn)});
  const storage=(store,area)=>({
    get:async keys=>{reads.push({area,keys});return typeof keys==='string'?{[keys]:store[keys]}:Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,store[k]])):{...keys,...store};},
    set:async value=>{writes.push(value);Object.assign(store,value);},
    remove:async keys=>{if(cleanupFails)throw Error('synthetic storage failure');for(const key of [keys].flat())delete store[key];},
  });
  const alarms=new Map([['985gmgn-j7tracker-sync',{}]]);
  const ctx=vm.createContext({console,URL,URLSearchParams,Date,atob,btoa,crypto:webcrypto,TextEncoder,TextDecoder,AbortController,
    fetch:async(...args)=>{calls.push(['fetch',...args]);throw Error('NO NETWORK');},
    WebSocket:class{constructor(...args){calls.push(['socket',...args]);}},
    io:(...args)=>calls.push(['io',...args]),
    setInterval:fn=>{timers.push(fn);return 1;},clearInterval(){},setTimeout:fn=>{timers.push(fn);return 1;},clearTimeout(){},
    importScripts(...names){for(const name of names){assert.ok(['debug-log.js','fomo-trending-session.js','fomo-trending-live.js','fomo-trending-demand.js'].includes(name));if(name!=='debug-log.js')vm.runInContext(read(name),ctx,{filename:name});}},
    chrome:{runtime:{onInstalled:event('installed'),onStartup:event('startup'),onMessage:event('message')},
      alarms:{clear:async name=>alarms.delete(name),get:async name=>alarms.get(name),create:(...args)=>calls.push(['alarm-create',...args]),onAlarm:event('alarm')},
      tabs:{query:async()=>[],sendMessage:async(...args)=>calls.push(['push',...args]),onRemoved:event('removed'),onUpdated:event('updated')},
      storage:{local:storage(local,'local'),session:storage(session,'session'),onChanged:event('changed')}}});
  {
    vm.runInContext(read('background.js'),ctx,{filename:'background.js'});
    await new Promise(resolve=>setImmediate(resolve));
    for(const name of ['installed','startup','alarm'])for(const fn of listeners[name]||[])fn({name:'985gmgn-j7tracker-sync'});
    Object.assign(local,legacy());
    for(const fn of listeners.changed||[])fn(Object.fromEntries(Object.entries(legacy()).map(([k,v])=>[k,{newValue:v}])), 'local');
    for(const type of ['j7tracker-session-updated','fomo-feed','pump-feed'])for(const fn of listeners.message||[]){
      let answered=false;
      assert.equal(fn({type},{url:'https://j7tracker.io/',tab:{id:1,url:'https://j7tracker.io/'}},()=>answered=true),false);
      assert.equal(answered,false);
    }
    for(const fn of [...timers])fn();
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.deepEqual(calls,[],`no requests, sockets, pushes or new alarms even if cleanup fails=${cleanupFails}`);
  assert.ok(!JSON.stringify(reads).match(/j7Tracker/),'legacy credentials/cache never read');
  assert.ok(!JSON.stringify(writes).match(/j7Tracker/),'no provider state written');
  assert.equal(alarms.has('985gmgn-j7tracker-sync'),false);
  if(!cleanupFails)assert.equal(session.j7TrackerCacheV1,undefined);
}
console.log('PASS J7/DeBot retirement: manifest/assets/controls/messages absent; saved ON/auth/cache inert through startup, install, old alarm, storage changes and timers, including cleanup failure. Real restart covered in test-extension.');
