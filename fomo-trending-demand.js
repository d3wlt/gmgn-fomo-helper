(() => {
  'use strict';
  // One shared producer, with demand scoped to validated GMGN top-level documents.
  function create({chrome, start, stop, refresh, snapshot, setTimeout:later=globalThis.setTimeout, clearTimeout:cancel=globalThis.clearTimeout}) {
    const ports=new Map();let running=false,closed=false;
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
    const settingsChanged=(changes,area)=>{if(area==='local'&&changes.enableFomoPanel?.newValue===false)for(const record of [...ports.values()])remove(record);};
    chrome.runtime.onConnect.addListener(connect);chrome.storage.onChanged.addListener(settingsChanged);
    return Object.freeze({
      publish(){for(const record of [...ports.values()])send(record);},
      hasDemand(){return running;},
      shutdown(){closed=true;chrome.runtime.onConnect.removeListener(connect);chrome.storage.onChanged.removeListener(settingsChanged);for(const record of [...ports.values()])remove(record);}
    });
  }
  Object.defineProperty(globalThis,'gdhCreateTrendingDemand',{value:create});
})();
