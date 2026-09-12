import fs from 'node:fs';

// Synthetic React props, consumed by the real MAIN-world bridge. Never seed
// data-gdh-native-index or content-script timestamps directly.
export async function installNativeBridge(page) {
  const source = fs.readFileSync(new URL('../page-bridge.js', import.meta.url), 'utf8');
  await page.addScriptTag({content:source.replace(/\}\)\(\);\s*$/, 'window.__scanNativeFixture = scanCards;})();')});
  await page.evaluate(() => {
    window.__mountNativeFixture = ({count=2, height=70, now=Date.now(), mode='fixed', untimed=false}={}) => {
      document.querySelector('#native-fixture')?.remove();
      const host=document.createElement('div');host.id='native-fixture';host.style.cssText='position:relative;width:100%;max-width:1000px;height:600px';
      const viewport=document.createElement('div');viewport.style.cssText='height:600px;overflow:auto';
      const spacer=document.createElement('div');spacer.style.cssText=`position:relative;height:${count*height}px`;
      const records=Array.from({length:count},(_,i)=>({token_address:'0x8888888888888888888888888888888888888888',maker:'synthetic-maker',side:'buy',chain:'eth',timestamp:untimed?0:now-i*10000,base_symbol:'NATIVE'}));
      const root={current:null}, rootFiber={stateNode:root}, list={memoizedProps:{items:records},return:rootFiber};
      root.current=rootFiber;rootFiber.child=list;let previous=null;
      for(let i=0;i<count;i++) {
        const wrap=document.createElement('div');
        if(mode==='fixed')wrap.style.cssText=`position:absolute;top:${i*height}px;height:${height}px;width:100%`;
        const card=document.createElement('div');card.dataset.sentryComponent='TrackerListItem';card.style.height=`${height}px`;
        card.innerHTML='<span data-testid="follow-tracking-row-symbol">NATIVE</span><span data-testid="follow-tracking-row-maker">synthetic maker</span>';
        card.__reactFiber$fixture={stateNode:card,memoizedProps:{record:records[i]},return:list};
        if(previous)previous.sibling=card.__reactFiber$fixture;else list.child=card.__reactFiber$fixture;
        previous=card.__reactFiber$fixture;
        wrap.append(card);spacer.append(wrap);
      }
      viewport.append(spacer);host.append(viewport);document.body.append(host);
      window.__scanNativeFixture();
      return {now, records};
    };
  });
}
