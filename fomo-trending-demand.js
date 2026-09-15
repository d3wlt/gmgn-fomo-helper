(() => {
  'use strict';
  // One shared producer, with demand scoped to validated GMGN top-level documents.
  function create({chrome, start, stop, refresh, snapshot, setTimeout:later=globalThis.setTimeout, clearTimeout:cancel=globalThis.clearTimeout}) {
    const ports=new Map();let running=false,closed=false;
    // Extension-only, browser-session/tab-scoped UI preference. Never persist feed data
    // or credentials, and never let a remembered choice count as live demand.
    const selectionKey='gdhTrendingSelectionV1';
    let selectionEpoch=null, selectionGeneration=0, selectionTabs=new Set(), selectionQueue=Promise.resolve();
    const newEpoch=()=>crypto.randomUUID();
    let selectionReady=null;
    const readySelection=()=>selectionReady ||= chrome.storage.session.get(selectionKey).then(stored=>{
      const saved=stored?.[selectionKey];
      selectionEpoch=typeof saved?.epoch==='string' && /^[a-f0-9-]{36}$/.test(saved.epoch) ? saved.epoch : newEpoch();
      selectionTabs=new Set(Array.isArray(saved?.tabs) ? saved.tabs.filter(id=>Number.isInteger(id)&&id>=0).slice(0,128) : []);
    }).catch(error=>{selectionReady=null;throw error;});
    const queueSelection=fn=>{const task=selectionQueue.catch(()=>{}).then(fn);selectionQueue=task;return task;};
    const persistSelection=()=>chrome.storage.session.set({[selectionKey]:{epoch:selectionEpoch,tabs:[...selectionTabs]}});
    function clearSelection() {
      selectionGeneration++;
      return queueSelection(async()=>{
        // Clearing does not depend on successful reads of an older preference.
        try { await readySelection(); } catch {}
        selectionEpoch=newEpoch();selectionTabs.clear();selectionReady=Promise.resolve();
        await persistSelection();
      });
    }
    async function handleSelection(message,sender) {
      const generation=selectionGeneration;
      if(closed||!['get','set'].includes(message?.action)||sender?.id!==chrome.runtime.id||!Number.isInteger(sender?.tab?.id)||sender.frameId!==0||!sender.documentId||!origin(sender.url)||message.action==='set'&&typeof message.selected!=='boolean')return {ok:false};
      return queueSelection(async()=>{
        await readySelection();
        const [tab,frame,settings]=await Promise.all([chrome.tabs.get(sender.tab.id),chrome.webNavigation.getFrame({tabId:sender.tab.id,frameId:0}),chrome.storage.local.get('enableFomoPanel')]);
        if(generation!==selectionGeneration||!origin(tab.url)||!origin(frame?.url)||frame.documentId!==sender.documentId)return {ok:false};
        const id=sender.tab.id;
        if(message.action==='set'){
          if(message.epoch!==selectionEpoch)return {ok:false};
          if(message.selected && settings.enableFomoPanel!==false){
            if(!selectionTabs.has(id)&&selectionTabs.size>=128)return {ok:false};
            selectionTabs.add(id);
          }else selectionTabs.delete(id);
          await persistSelection();
        }
        if(generation!==selectionGeneration)return {ok:false};
        return {ok:true,epoch:selectionEpoch,selected:settings.enableFomoPanel!==false&&selectionTabs.has(id)};
      }).catch(()=>({ok:false}));
    }
    const tabRemoved=id=>{void queueSelection(async()=>{await readySelection();if(selectionTabs.delete(id))await persistSelection();}).catch(()=>{});};
    chrome.tabs.onRemoved?.addListener(tabRemoved);
    const origin=value=>{try{const u=new URL(value);return u.protocol==='https:'&&(u.hostname==='gmgn.ai'||u.hostname.endsWith('.gmgn.ai'))&&!u.username&&!u.password;}catch{return false;}};
    const reconcile=()=>{const wanted=[...ports.values()].some(p=>p.valid&&p.active);if(wanted&&!running){running=true;start();}else if(!wanted&&running){running=false;stop();}};
    const send=record=>{if(!record.valid||!record.active)return;try{record.port.postMessage({type:'fomo-trending-live-update',data:snapshot()});}catch{remove(record);}};
    const remove=record=>{if(!ports.delete(record.port))return;cancel(record.timer);record.active=false;try{record.port.disconnect();}catch{}reconcile();};
    const lease=record=>{cancel(record.timer);record.timer=later(()=>remove(record),45000);};
    const connect=port=>{
      if(closed||port.name!=='gdh-trending-live-v1')return;
      const sender=port.sender;
      if(!Number.isInteger(sender?.tab?.id)||sender.frameId!==0||!sender.documentId||!origin(sender.url)||ports.size>=32){port.disconnect();return;}
      const record={port,valid:false,active:false,wanted:false,timer:null};ports.set(port,record);lease(record);
      port.onDisconnect.addListener(()=>remove(record));
      port.onMessage.addListener(message=>{
        if(!ports.has(port)||!message||!['active','heartbeat','refresh'].includes(message.type))return;
        if(message.type==='active')record.wanted=message.active===true;
        if(!record.valid)return;
        record.active=record.wanted;lease(record);reconcile();
        if(message.type==='refresh'&&record.active)refresh();else if(message.type==='active')send(record);
      });
      void (async()=>{
        try{
          const [tab,frame,settings]=await Promise.all([chrome.tabs.get(sender.tab.id),chrome.webNavigation.getFrame({tabId:sender.tab.id,frameId:0}),chrome.storage.local.get('enableFomoPanel')]);
          if(!ports.has(port))return;
          if(!origin(tab.url)||!origin(frame?.url)||frame.documentId!==sender.documentId||settings.enableFomoPanel===false)return remove(record);
          for(const other of [...ports.values()])if(other!==record&&other.port.sender.tab.id===sender.tab.id&&other.port.sender.documentId===sender.documentId)remove(other);
          if(!ports.has(port))return;
          record.valid=true;record.active=record.wanted;lease(record);reconcile();send(record);
        }catch{remove(record);}
      })();
    };
    const settingsChanged=(changes,area)=>{if(area==='local'&&changes.enableFomoPanel?.newValue===false){void clearSelection().catch(()=>{});for(const record of [...ports.values()])remove(record);}};
    chrome.runtime.onConnect.addListener(connect);chrome.storage.onChanged.addListener(settingsChanged);
    return Object.freeze({
      publish(){for(const record of [...ports.values()])send(record);},
      handleSelection, clearSelection,
      hasDemand(){return running;},
      shutdown(){closed=true;chrome.tabs.onRemoved?.removeListener(tabRemoved);chrome.runtime.onConnect.removeListener(connect);chrome.storage.onChanged.removeListener(settingsChanged);for(const record of [...ports.values()])remove(record);}
    });
  }
  Object.defineProperty(globalThis,'gdhCreateTrendingDemand',{value:create});
})();
