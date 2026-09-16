(() => {
  'use strict';
  if (location.hostname !== 'gmgn.ai' || window.top !== window || window.__gdhCommunityThesis) return;
  window.__gdhCommunityThesis = true;
  const DEMAND = 'data-gdh-thesis-demand', RESULT = 'data-gdh-thesis-result';
  const CHAINS = {sol:'Solana',eth:'Ethereum',bsc:'BSC',base:'Base',robinhood:'Robinhood',arc:'Arc',monad:'Monad'};
  let settings = null, view = null, selected = false, request = null, sequence = 0, pending = null, stopped = false;
  let lastKey = '', refreshAfter = 0, retryAt = 0, retries = 0, sortOrder = 'newest';
  const route = () => {
    const m = location.pathname.match(/^\/([a-z]+)\/token\/([^/]+)\/?$/);
    if (!m || !Object.hasOwn(CHAINS, m[1])) return null;
    const [chain,address] = m.slice(1);
    if (!(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(address)) return null;
    return {chain,address:chain === 'sol' ? address : address.toLowerCase()};
  };
  const key = r => r ? `${r.chain}:${r.address}` : '';
  const visible = el => {
    if (!el?.isConnected || document.visibilityState !== 'visible') return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none';
  };
  function node(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function endDemand() {
    request = null; retryAt = 0;
    document.documentElement.removeAttribute(DEMAND);
    document.dispatchEvent(new Event('gdh-thesis-demand'));
  }
  function clearRows() {
    if (!view) return;
    view.items = []; view.rows.clear(); view.list.replaceChildren(); view.list.scrollTop = 0;
    view.symbol.textContent = ''; view.count.textContent = ''; view.updated.textContent = '';
  }
  function state(status, message) {
    if (!view) return;
    view.status.textContent = status;
    view.status.dataset.status = status.toLowerCase();
    view.message.textContent = message || ''; view.message.hidden = !message;
  }
  function startDemand() {
    const r = route();
    if (!selected || !view || !visible(view.root) || !r) return;
    clearRows();
    view.chain.textContent = CHAINS[r.chain];
    view.symbol.textContent = `${r.address.slice(0,6)}…${r.address.slice(-4)}`;
    state('Loading', 'Loading available token theses…');
    refreshAfter = Date.now() + 10000;
    request = {v:1,requestId:`thesis-${Date.now()}-${++sequence}`,...r};
    document.documentElement.setAttribute(DEMAND, JSON.stringify(request));
    document.dispatchEvent(new Event('gdh-thesis-demand'));
  }
  function restoreNative() {
    if (!view) return;
    view.panel.classList.remove('gdh-thesis-selected');
    view.header.classList.remove('gdh-thesis-native-tabs');
    for (const [tab,value] of view.nativeAria) if (tab.isConnected && tab.getAttribute('aria-selected') === 'false') tab.setAttribute('aria-selected', value);
    view.nativeAria.clear();
    view.button.setAttribute('aria-selected','false');
    view.root.hidden = true; view.root.dataset.active = '0';
  }
  function deactivate() { selected = false; endDemand(); clearRows(); restoreNative(); }
  function activate() {
    if (!view) return;
    selected = true; retries = 0;
    view.panel.classList.add('gdh-thesis-selected'); view.header.classList.add('gdh-thesis-native-tabs');
    for (const tab of view.nav.querySelectorAll('[role="tab"]')) if (tab !== view.button) {
      if (!view.nativeAria.has(tab)) view.nativeAria.set(tab,tab.getAttribute('aria-selected') || 'false');
      tab.setAttribute('aria-selected','false');
    }
    view.root.hidden = false; view.root.dataset.active = '1';
    view.button.setAttribute('aria-selected','true');
    view.button.scrollIntoView({block:'nearest',inline:'nearest'});
    size(); startDemand();
  }
  function dispose() {
    deactivate();
    if (!view) return;
    view.header.removeEventListener('click', view.onNative, true);
    view.tab.remove(); view.root.remove(); view.panel.removeAttribute('data-gdh-thesis-panel'); view = null;
  }
  function size() {
    if (!view || !selected) return;
    // Leave room for GMGN's fixed bottom toolbar; viewport height alone overlaps it.
    const max = `${Math.max(120,innerHeight - view.root.getBoundingClientRect().top - 64)}px`;
    if (view.root.style.maxHeight !== max) view.root.style.maxHeight = max;
  }
  function mount(feed) {
    const x = [...feed.querySelectorAll('[role="tab"]')].find(e => /-tab-x_tracker$/.test(e.id));
    const nav = x?.closest('.pi-tabs-nav-list'), header = nav?.closest('.pi-tabs-nav')?.parentElement?.parentElement;
    // Pin the observed CommunityFeed panel/header ancestry; never guess at other tabsets.
    const panel = feed.lastElementChild;
    if (!x || !nav || !panel || !header || header.parentElement !== panel) return;
    const nativeTabs = [...nav.querySelectorAll('[role="tab"]')];
    if (!nativeTabs.some(e => /-tab-community$/.test(e.id))) return;
    const tab = node('div','pi-tabs-tab gdh-thesis-tab');
    const button = node('button','pi-tabs-tab-btn','FOMO Thesis'); button.type = 'button';
    button.id = 'gdh-thesis-tab'; button.setAttribute('role','tab'); button.setAttribute('aria-controls','gdh-community-thesis');button.setAttribute('aria-selected','false');
    tab.append(button); x.closest('.pi-tabs-tab').after(tab);
    const root = node('div','gdh-community-thesis'); root.id = 'gdh-community-thesis';root.hidden = true;root.dataset.active = '0';root.setAttribute('role','tabpanel');root.setAttribute('aria-labelledby',button.id);
    const context = node('div','gdh-thesis-context'), symbol = node('strong'), chain = node('span'), status = node('span','gdh-thesis-status');
    status.title = 'Snapshot means history loaded. Updates means a matching stream update was received; it does not guarantee uninterrupted delivery.';
    context.append(symbol,chain,status);
    const tools = node('div','gdh-thesis-tools'), count = node('span'), order = node('select','gdh-thesis-sort');
    order.setAttribute('aria-label','Sort loaded theses');order.title='Sort loaded posts only, not the complete token history';
    for(const [value,label] of [['newest','Newest first'],['oldest','Oldest first'],['likes','Most liked']]){const option=node('option','',label);option.value=value;order.append(option);}
    order.value=sortOrder;
    const refresh = node('button','gdh-thesis-refresh','Refresh');refresh.type='button';refresh.title='Reload available token theses';
    tools.append(count,order,refresh);
    const message = node('div','gdh-thesis-message');message.setAttribute('role','status');
    const list = node('div','gdh-thesis-list');list.setAttribute('role','feed');list.setAttribute('aria-label','FOMO token theses');
    const footer = node('div','gdh-thesis-footer'), coverage = node('span','','Available history'), updated = node('span');
    coverage.tabIndex=0;coverage.title='Keeps up to 200 newest received posts in page memory. GMGN provides no verified pagination or total count; this is not complete history.';
    footer.append(coverage,updated);root.append(context,tools,message,list,footer);panel.append(root);panel.dataset.gdhThesisPanel='1';
    const onNative = e => { const t=e.target.closest('[role="tab"]');if(t && t!==button && nav.contains(t)) deactivate(); };
    view={feed,panel,nav,header,tab,button,root,symbol,chain,status,count,refresh,message,list,updated,items:[],rows:new Map(),nativeAria:new Map(),onNative};
    order.addEventListener('change',()=>{if(!['newest','oldest','likes'].includes(order.value))return;sortOrder=order.value;renderRows(true);});
    header.addEventListener('click',onNative,true);
    button.addEventListener('click', e => { if (!e.isTrusted) return; if(!selected) activate(); });
    refresh.addEventListener('click', e => { if(e.isTrusted && Date.now() >= refreshAfter) { endDemand();startDemand(); } });
  }
  function avatarUrl(value) {
    try {const u=new URL(value);return u.protocol==='https:' && (u.hostname==='prod-fomo-profile-pics.s3.amazonaws.com' || u.hostname==='gmgn.ai' || u.hostname.endsWith('.fomo.family')) && !u.username && !u.password ? u.href : '';}catch{return '';}
  }
  function normalize(raw,r) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200 || raw.chain !== r.chain) return null;
    if (typeof raw.token_address !== 'string' || (r.chain === 'sol' ? raw.token_address : raw.token_address.toLowerCase()) !== r.address) return null;
    if (typeof raw.thesis !== 'string' || raw.thesis.length > 20000 || !Number.isFinite(raw.fomo_created_at) || raw.fomo_created_at <= 0 || raw.fomo_created_at > Date.now()+300000) return null;
    const text=(k,n)=>typeof raw[k]==='string'?raw[k].slice(0,n):'';
    return {id:raw.id,thesis:raw.thesis,time:raw.fomo_created_at,name:text('author_name',200),handle:text('author_handle',200),symbol:text('token_symbol',100),avatar:avatarUrl(raw.author_avatar_url),dev:raw.author_is_dev===true,likes:Number.isSafeInteger(raw.like_count)&&raw.like_count>=0?raw.like_count:null};
  }
  function row(item) {
    const article=node('article','gdh-thesis-post');article.dataset.thesisId=item.id;
    const author=node('div','gdh-thesis-author'), avatar=node('div','gdh-thesis-avatar',(item.name||item.handle||'?').slice(0,1));
    if(item.avatar){const img=node('img');img.src=item.avatar;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>img.remove(),{once:true});avatar.append(img);}
    const person=node('div','gdh-thesis-person'), name=node('strong','',item.name||item.handle||'Unknown author');person.append(name);
    if(item.handle)person.append(node('span','',`@${item.handle}`));
    if(item.dev)person.append(node('span','gdh-thesis-dev','DEV'));
    const time=node('time');time.dateTime=new Date(item.time).toISOString();time.textContent=new Date(item.time).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});time.title=new Date(item.time).toLocaleString();
    author.append(avatar,person,time);
    const body=node('div','gdh-thesis-text',item.thesis||'No thesis text supplied.');
    article.append(author,body);
    if(item.likes!==null){const likes=node('div','gdh-thesis-likes',`♡ ${item.likes}`);likes.setAttribute('aria-label',`${item.likes} likes`);likes.title='Like count supplied by GMGN; read-only';article.append(likes);}
    return article;
  }
  function receive() {
    if(!view || !selected || !request || key(route())!==key(request) || !visible(view.root)) return;
    let data;try{const raw=document.documentElement.getAttribute(RESULT);if(!raw || raw.length>10000000)return;data=JSON.parse(raw);}catch{return;}
    if(data?.v!==1 || data.requestId!==request.requestId || data.chain!==request.chain || data.address!==request.address) return;
    if(data.status==='loading'){state('Loading','Loading available token theses…');return;}
    if(data.error==='rate_limited' && retries < 2){
      retries++;retryAt=Date.now()+(Number.isFinite(data.retryAfterMs)?Math.min(30000,Math.max(500,data.retryAfterMs)):3000)+100;
      clearRows();state('Loading','Waiting briefly before loading…');return;
    }
    if(data.status==='stopped' || (data.status==='error' && (!Array.isArray(data.items) || !data.items.length))){
      clearRows();state('Unavailable',data.error==='native_auth_failure' || data.error==='account_changed'?'GMGN session changed. Sign in if needed, then refresh.':data.error==='rate_limited'?'Please wait briefly, then refresh.':'Theses unavailable. Refresh to try again.');return;
    }
    if(!['snapshot','streaming','error'].includes(data.status) || !Array.isArray(data.items) || data.items.length>1000) return;
    const items=data.items.map(x=>normalize(x,request));
    if(items.some(x=>!x)){clearRows();state('Unavailable','GMGN returned unsupported thesis data.');return;}
    const unique=[...new Map(items.map(x=>[x.id,x])).values()];
    view.items=unique;renderRows();
    view.symbol.textContent=unique.find(x=>x.symbol)?.symbol || `${request.address.slice(0,6)}…${request.address.slice(-4)}`;
    view.count.textContent=`${unique.length} loaded`;
    view.updated.textContent='Updated '+new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    state(data.status==='error'?'Limited':data.status==='streaming'?'Updates':'Snapshot',data.status==='error'?'Available posts shown; history or updates are incomplete. Refresh to resync.':unique.length?'':'No theses supplied for this token.');
  }
  function renderRows(reset=false) {
    if(!view)return;
    const unique=[...view.items].sort((a,b)=>
      (sortOrder==='likes'?(b.likes??-1)-(a.likes??-1):0) ||
      (sortOrder==='oldest'?a.time-b.time:b.time-a.time) || a.id.localeCompare(b.id));
    const oldTop=view.list.scrollTop, box=view.list.getBoundingClientRect();
    const anchor=!reset && oldTop>4?[...view.list.children].find(e=>e.getBoundingClientRect().bottom>box.top):null;
    const anchorId=anchor?.dataset.thesisId, offset=anchor?anchor.getBoundingClientRect().top-box.top:0;
    const next=new Map(),frag=document.createDocumentFragment();
    for(const item of unique){const signature=JSON.stringify(item),old=view.rows.get(item.id),entry=old?.signature===signature?old:{signature,node:row(item)};next.set(item.id,entry);frag.append(entry.node);}
    view.rows=next;view.list.replaceChildren(frag);
    if(anchorId && next.has(anchorId))view.list.scrollTop+=next.get(anchorId).node.getBoundingClientRect().top-view.list.getBoundingClientRect().top-offset;
    else view.list.scrollTop=reset?0:oldTop>4?oldTop:0;
  }
  function scan() {
    pending=null;if(stopped)return;
    const r=route(),k=key(r);
    if(!settings?.enabled || !settings?.enableFomoPanel || !r){if(view)dispose();lastKey=k;return;}
    if(view && (!view.feed.isConnected || !view.root.isConnected || !view.button.isConnected)){dispose();}
    if(!view){const feeds=[...document.querySelectorAll('[data-sentry-component="CommunityFeed"]')].filter(visible);if(feeds.length===1)mount(feeds[0]);}
    if(k!==lastKey){endDemand();clearRows();retries=0;lastKey=k;if(selected)startDemand();}
    if(!view)return;
    size();view.refresh.disabled=Date.now()<refreshAfter || !selected;
    if(selected && retryAt && Date.now()>=retryAt && visible(view.root)){endDemand();startDemand();}
    if(selected){if(!visible(view.root)){if(request){endDemand();clearRows();state('Paused','Feed paused while hidden.');}}else if(!request)startDemand();}
  }
  function schedule() {if(!pending && !stopped)pending=setTimeout(scan,40);}
  document.addEventListener('gdh-thesis-result',receive);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible'){endDemand();clearRows();}schedule();});
  window.addEventListener('resize',schedule);window.addEventListener('popstate',schedule);
  window.addEventListener('pagehide',()=>{endDemand();clearRows();});
  const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true});
  const timer=setInterval(()=>{try{if(!chrome.runtime.id)throw Error('invalidated');scan();}catch{stopped=true;dispose();observer.disconnect();clearInterval(timer);}},500);
  try {
    chrome.storage.local.get({enabled:true,enableFomoPanel:true},value=>{if(chrome.runtime.lastError)return;settings=value;schedule();});
    chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local' || !settings)return;for(const k of ['enabled','enableFomoPanel'])if(changes[k])settings[k]=changes[k].newValue!==false;schedule();});
  } catch {stopped=true;observer.disconnect();clearInterval(timer);}
})();
