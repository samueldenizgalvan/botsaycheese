// =========================
// Helpers y constantes
// =========================
// TENANT debe ser el ID lógico en backend (ej: 'samuel'), no el nombre de marca
const TENANT = window.CURRENT_TENANT || window.TENANT || 'samuel';
const $id = (id) => document.getElementById(id);
const setText = (id, txt) => { const el=$id(id); if(el) el.textContent = txt; };

// Toast minimal
function toast(msg, type='info'){
  const t = $id('toast');
  if(!t) return;
  t.textContent = String(msg||'');
  t.className = `toast ${type}`;
  t.style.opacity = '1';
  setTimeout(()=>{ t.style.opacity='0'; }, 2500);
}

// Marca dinámica
function computeBrandName(){
  const tenant = window.CURRENT_TENANT || window.TENANT || 'samuel';
  return tenant === 'samuel' ? 'SayCheese By Nestor' : String(tenant || 'Panel');
}
function applyBrand(brand){
  setText('brandText', brand);
  try { document.title = `${brand} · Panel`; } catch{}
}
try {
  applyBrand(computeBrandName());
  let tries=0; const iv=setInterval(()=>{
    applyBrand(computeBrandName());
    if(window.CURRENT_TENANT || ++tries>6) clearInterval(iv);
  }, 300);
} catch{}

// Loader no-op (placeholder por si existe barra)
let loaderCount=0;
function showLoader(){ const el=$id('loader-bar'); if(el){ loaderCount++; el.hidden=false; } }
function hideLoader(){ const el=$id('loader-bar'); if(el){ loaderCount=Math.max(0,loaderCount-1); if(loaderCount===0) el.hidden=true; } }

// Fetch helper con backoff
async function apiFetch(url, opt={}, attempt=0){
  const sep = url.includes('?') ? '&' : '?';
  const full= `${url}${sep}tenant=${encodeURIComponent(TENANT)}`;
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(), 10000);
  try{
    showLoader();
  const r = await fetch(full, { ...opt, signal: ac.signal, credentials:'same-origin', headers:{ 'Content-Type':'application/json', 'Cache-Control':'no-cache', 'Pragma':'no-cache', 'X-Tenant-Id': TENANT, ...(opt.headers||{}) } });
    if(!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  }catch(e){
    if(attempt<3){ await new Promise(r=>setTimeout(r, 500*Math.pow(2,attempt))); return apiFetch(url,opt,attempt+1); }
    toast(`Error de red (${e.message||e})`, 'err');
    throw e;
  } finally { clearTimeout(t); hideLoader(); }
}

// =========================
// Estado del bot (badge + polling suave)
// =========================
let statusTimer=null;
function stopStatusPolling(){ if(statusTimer){ clearInterval(statusTimer); statusTimer=null; } }
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
function setBadge(status){
  const badge=$id('botStatus'); if(!badge) return;
  const s=String(status||'').trim() || '—';
  badge.textContent=s;
  try { badge.className = `pill status ${s||'unknown'}`; } catch{}
  const map={ waiting_qr:'#f59e0b', ready:'#10b981', initializing:'#6b7280', authenticated:'#3b82f6', disconnected:'#ef4444', error:'#ef4444' };
  badge.style.background = map[s] || '#334155';
  badge.style.color = '#fff';
  const start=$id('btnStart');
  if(start){
    // Toggle label and action based on status
    const isReady = (s==='ready');
    start.textContent = isReady ? 'Apagar Bot' : 'Iniciar Bot';
    start.dataset.action = isReady ? 'stop' : 'start';
    // Only disable while initializing states
    start.disabled = ['initializing','waiting_qr','authenticated'].includes(s);
  }
}
async function fetchStatus(){
  const r = await fetch(`/bot/status?tenant=${encodeURIComponent(TENANT)}`, { credentials:'same-origin' });
  if(!r.ok) return null;
  const data = await r.json();
  const status = data?.status || data?.state || '';
  const st = { status, isReady: status==='ready' };
  setBadge(st.status);
  return st;
}
function startStatusPolling(){ stopStatusPolling(); statusTimer=setInterval(fetchStatus, 4000); }
async function refreshStatusNow(){ await fetchStatus(); }

// =========================
// Tabs
// =========================
function switchTab(name){
  const tabs = document.querySelectorAll('.tabbar .tab');
  tabs.forEach(t=> t.classList.toggle('active', t.getAttribute('data-target')===name));
  const from = document.querySelector('.tabs-container .panel.active');
  const to = document.querySelector(`.tabs-container .panel[data-name="${CSS.escape(String(name))}"]`);
  if(from === to) return;
  if(from){ from.classList.remove('active'); from.classList.add('leave-left'); setTimeout(()=> from.classList.remove('leave-left'), 350); }
  if(to){ to.classList.add('active'); }
  // Reaplicar filtro al cambiar de pestaña
  applyActiveFilter();
}
function wireTabs(){
  document.querySelectorAll('.tabbar .tab').forEach(btn=>{
    btn.addEventListener('click', ()=> switchTab(btn.getAttribute('data-target')));
  });
}

// =========================
// Render de pedidos como tarjetas
// =========================
function safe(str){ return String(str??'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }
function fmtDate(ts){ if(!ts) return '-'; const d=new Date(ts); if(isNaN(d)) return '-'; const pad=n=>String(n).padStart(2,'0'); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
const joinSabores = (o) => (o?.fields?.sabores ?? o?.sabores ?? []).join(', ');
const getTamano = (o) => (o?.fields?.tamano ?? o?.tamano ?? '').toLowerCase();
const getCantidad = (o) => {
  const t=getTamano(o);
  const isPorciones = ['porciones','porcion','porción'].includes(t);
  if(isPorciones) return o?.fields?.porciones ?? o?.porciones ?? o?.fields?.cantidad ?? o?.cantidad ?? o?.fields?.unidades ?? '';
  let val = o?.fields?.cantidad ?? o?.cantidad ?? o?.fields?.unidades ?? o?.unidades;
  if((val===''||val==null) && (o?.fields?.porciones || o?.porciones)) val = o?.fields?.porciones ?? o?.porciones;
  return val ?? '';
};
const getObs  = (o) => o?.fields?.observacion ?? o?.observacion ?? '';
const getTelefono = (o) => o?.customer?.phone ?? o?.fields?.telefono ?? o?.phone ?? o?.telefono ?? '';

function renderCard(order){
  const card = document.createElement('div');
  const isCanceled = String(order.status||'').toLowerCase()==='canceled';
  const isPending = String(order.status||'').toLowerCase()==='pending' || (!order.status);
  const isConfirmed = String(order.status||'').toLowerCase()==='confirmed';
  card.className = 'order-card' + (isCanceled ? ' canceled' : '');
  card.setAttribute('data-card-id', String(order.id));
  const telefono = getTelefono(order);
  const obs = getObs(order);
  const displayTs = order.canceledAt ? order.canceledAt : order.createdAt;
  const fechaRecogida = order?.fields?.fecha || order?.fecha || '';
  const items = Array.isArray(order.items) ? order.items : (Array.isArray(order.fields?.items) ? order.fields.items : null);
  const total = (typeof order.total === 'number') ? order.total : (items ? items.reduce((a,it)=> a + (Number(it.total)||0), 0) : null);

  // Build items block (multi-item friendly)
  let itemsHtml = '';
  if(items && items.length){
    const rows = items.map((it,idx)=>{
      const label = it.label || it.tamano || '';
      const cant = it.cantidad != null ? it.cantidad : '';
      const sab = Array.isArray(it.sabores) ? it.sabores.join(', ') : (Array.isArray(it.sabores_por_porcion)? it.sabores_por_porcion.map((arr,i)=>`${i+1}) ${arr.join(', ')}`).join(' | ') : '');
      const sub = (typeof it.total === 'number') ? `${it.total}€` : '';
      const obs = it.observacion ? ` • Obs: ${safe(String(it.observacion))}` : '';
      return `<div class="row"><strong>${idx+1})</strong> <span>${safe(label)} x${safe(String(cant))} • ${safe(sab||'-')}${sub?` • ${safe(sub)}`:''}${obs}</span></div>`;
    }).join('');
    itemsHtml = `<div class="rows">${rows}</div>`;
  } else {
    // Fallback to legacy single fields
    const sabores = joinSabores(order);
    const cantidad = getCantidad(order);
    const tamano = (order?.fields?.tamano ?? order?.tamano ?? '') || '';
    itemsHtml = `
      <div class="row"><strong>Tamaño:</strong> <span>${safe(tamano)}</span></div>
      <div class="row"><strong>Sabores:</strong> <span>${safe(sabores)}</span></div>
      <div class="row"><strong>Cantidad:</strong> <span>${safe(String(cantidad))}</span></div>
    `;
  }

  card.innerHTML = `
    <div class="row top">
      <span class="date">${safe(fmtDate(displayTs))}</span>
  <span class="status ${isCanceled?'canceled':(isConfirmed?'confirmed':'pending')}">${isCanceled?'Cancelado':(isConfirmed?'Confirmado':(order.modified?'Modificado y pendiente':'Pendiente'))}</span>
    </div>
    <div class="row"><strong>Tel:</strong> <span>${safe(telefono)}</span></div>
    ${(isPending||isConfirmed) && fechaRecogida ? `<div class="row"><strong>Recogida:</strong> <span>${safe(fechaRecogida)}</span></div>` : ''}
    
    ${itemsHtml}
    ${total!=null? `<div class="row"><strong>Total:</strong> <span>${safe(String(total))}€</span></div>`:''}
    ${(!items || !items.length) && obs ?`<div class="row"><strong>Obs.:</strong> <span>${safe(obs)}</span></div>`:''}
    <div class="actions"></div>
  `;
  const actions = card.querySelector('.actions');
  const btnCancelDel = document.createElement('button');
  btnCancelDel.className = 'btn btn-danger';
  if(isCanceled){
    // Canceled: only delete
    btnCancelDel.textContent='Borrar';
    btnCancelDel.onclick = () => deleteOrder(order.id, 'canceled');
    actions.appendChild(btnCancelDel);
  } else {
    // Confirm button for pending orders
    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'btn btn-primary';
    btnConfirm.textContent = 'Confirmar';
    btnConfirm.onclick = async ()=>{
      const prev=btnConfirm.disabled; btnConfirm.disabled=true;
      try{
        const res = await apiFetch(`/api/pedidos/${encodeURIComponent(order.id)}/confirm`, { method:'POST' });
        const { ok, order:ord } = res||{};
        if(!ok||!ord) throw new Error('confirm_failed');
        // Mark card as confirmed without removing from list
        markCardConfirmed(order.id);
        toast('Pedido confirmado ✅','ok');
      } catch{ toast('No se pudo confirmar','err'); }
      finally { btnConfirm.disabled=prev; }
    };
    if(!isConfirmed && !isCanceled){ actions.appendChild(btnConfirm); }

  // Cancel button: only for confirmed orders (clients can cancel only confirmed)
  if(isConfirmed){
      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn btn-warning';
      btnCancel.textContent='Cancelar';
      btnCancel.onclick = async ()=>{
        const prev=btnCancel.disabled; btnCancel.disabled=true;
        try{
          const res = await apiFetch(`/api/pedidos/${encodeURIComponent(order.id)}/cancel`, { method:'POST' });
          const { ok, order:ord } = res||{};
          if(!ok||!ord) throw new Error('cancel_failed');
          removeFromCaches(order.id);
          const el = document.querySelector(`[data-card-id="${CSS.escape(String(order.id))}"]`);
          if(el) el.remove();
          CACHE.canceled.push(ord);
          addCanceledCard(ord);
        } catch{ toast('No se pudo cancelar','err'); }
        finally { btnCancel.disabled=prev; }
      };
      actions.appendChild(btnCancel);
    } else if (isPending) {
      // Optional UX: explain restriction if they try to cancel pending
      const btnInfo = document.createElement('button');
      btnInfo.className = 'btn';
      btnInfo.textContent='Cancelar';
      btnInfo.onclick = ()=> toast('Solo se pueden cancelar pedidos confirmados', 'info');
      actions.appendChild(btnInfo);
    }

    // Delete button for pending and confirmed
    btnCancelDel.textContent='Borrar';
    btnCancelDel.onclick = () => deleteOrder(order.id, isConfirmed ? 'confirmed' : 'pending');
    actions.appendChild(btnCancelDel);
  }
  return card;
}

function clearAndFill(listId, items){
  const cont=$id(listId); if(!cont) return;
  cont.innerHTML='';
  (items||[]).forEach(o=> cont.appendChild(renderCard(o)));
}

function updateEmptyStates(){
  const p=$id('list-pendientes'); const ep=$id('empty-pendientes'); if(p&&ep) ep.style.display = p.childElementCount? 'none':'block';
  const cf=$id('list-confirmados'); const ecf=$id('empty-confirmados'); if(cf&&ecf) ecf.style.display = cf.childElementCount? 'none':'block';
  const c=$id('list-cancelados'); const ec=$id('empty-cancelados'); if(c&&ec) ec.style.display = c.childElementCount? 'none':'block';
}

async function fetchPedidos(estado='pending'){
  const pedidos = await apiFetch(`/api/pedidos?estado=${encodeURIComponent(estado)}`);
  if(Array.isArray(pedidos)){
    return pedidos.map(p=>({
      ...p,
      cantidad: p?.fields?.cantidad ?? p?.cantidad ?? '',
      observacion: p?.fields?.observacion ?? p?.observacion ?? '',
      items: Array.isArray(p?.items) ? p.items : (Array.isArray(p?.fields?.items) ? p.fields.items : undefined),
      total: typeof p?.total === 'number' ? p.total : (Array.isArray(p?.fields?.items) ? p.fields.items.reduce((a,it)=> a + (Number(it.total)||0),0) : undefined)
    }));
  }
  return pedidos;
}

// Local cache for filtering without re-fetch
let CACHE = { pending: [], confirmed: [], canceled: [] };

function applyPhoneFilter(arr){
  const f = ($id('phoneFilter')?.value||'').trim();
  if(!f) return arr;
  const needle = f.replace(/\D/g,'');
  if(!needle) return arr;
  return arr.filter(o=> String(getTelefono(o)).replace(/\D/g,'').includes(needle));
}

function activePanelName(){
  const el = document.querySelector('.tabs-container .panel.active');
  return el?.getAttribute('data-name') || 'pendientes';
}

function applyActiveFilter(){
  const name = activePanelName();
  if(name==='pendientes'){
    clearAndFill('list-pendientes', applyPhoneFilter(CACHE.pending));
  } else if(name==='confirmados'){
    clearAndFill('list-confirmados', applyPhoneFilter(CACHE.confirmed));
  } else if(name==='cancelados'){
    clearAndFill('list-cancelados', applyPhoneFilter(CACHE.canceled));
  }
  updateEmptyStates();
}

async function renderPedidos(){
  try{
    const [pending, confirmed, canceled] = await Promise.all([
      fetchPedidos('pending'),
      fetchPedidos('confirmed'),
      fetchPedidos('canceled')
    ]);
    CACHE.pending = Array.isArray(pending)? pending:[];
    CACHE.confirmed = Array.isArray(confirmed)? confirmed:[];
    CACHE.canceled = Array.isArray(canceled)? canceled:[];
    // Rellenamos listas sin filtrar inicialmente y aplicamos filtro a la activa
    clearAndFill('list-pendientes', CACHE.pending);
    clearAndFill('list-confirmados', CACHE.confirmed);
    clearAndFill('list-cancelados', CACHE.canceled);
    applyActiveFilter();
  }catch{}
}

// =========================
// SSE eventos
// =========================
let es=null;
function renderStatus(st){ if(!st) return; setBadge(st.isReady?'ready':(st.status||'')); }
async function loadStatus(){ const st=await fetchStatus(); if(st) renderStatus(st); }
async function loadTables(){ await renderPedidos(); }
function startEvents(){
  if(es){ try{ es.close(); }catch{} }
  es = new EventSource('/events');
  es.addEventListener('open', async ()=>{ await renderPedidos(); });
  es.addEventListener('order:changed', async ()=>{ await renderPedidos(); });
  es.addEventListener('bot:status', e=>{ try{ const d=JSON.parse(e.data); renderStatus(d); }catch{} });
  es.addEventListener('order_created', e=>{
    try{
      const d = JSON.parse(e.data||'{}');
      const ord = d?.order;
      if(!ord) return;
      // Si este nuevo pedido reemplaza a otro, elimínalo de cachés y UI inmediatamente
      if(ord.replaces){
        const rid = String(ord.replaces);
        CACHE.pending = CACHE.pending.filter(o=> String(o.id)!==rid);
        CACHE.confirmed = CACHE.confirmed.filter(o=> String(o.id)!==rid);
        removeCard(rid);
      }
      // Dedupe: elimina cualquier rastro previo del id en caches y luego inserta/actualiza en pending
      const sid = String(ord.id);
      CACHE.pending = CACHE.pending.filter(o=> String(o.id)!==sid);
      CACHE.confirmed = CACHE.confirmed.filter(o=> String(o.id)!==sid);
      CACHE.canceled = CACHE.canceled.filter(o=> String(o.id)!==sid);
      const idx = CACHE.pending.findIndex(o=> String(o.id)===sid);
      if(idx>=0) CACHE.pending[idx] = ord; else CACHE.pending.push(ord);
      applyActiveFilter();
    }catch{}
  });
  es.addEventListener('order_canceled', e=>{ try{ const d=JSON.parse(e.data||'{}'); if(d?.order){ moveToCanceled(d.order); } }catch{} });
  es.addEventListener('order_confirmed', e=>{ try{ const d=JSON.parse(e.data||'{}'); if(d?.order){ moveToConfirmed(d.order); toast('Pedido confirmado ✅','ok'); } }catch{} });
  es.addEventListener('error', ()=>{ try{ es.close(); }catch{}; setTimeout(startEvents, 2500); });
}
window.addEventListener('beforeunload', ()=>{ if(es) try{ es.close(); }catch{} });

// Helpers SSE mutations
function removeCard(id){ const el=document.querySelector(`[data-card-id="${CSS.escape(String(id))}"]`); if(el){ el.remove(); updateEmptyStates(); } }
function addPendingCard(order){ const list=$id('list-pendientes'); if(!list) return; list.appendChild(renderCard(order)); updateEmptyStates(); }
function addCanceledCard(order){ const list=$id('list-cancelados'); if(!list) return; const o={...order}; if(o.canceledAt) o.createdAt=o.canceledAt; if(list.firstChild) list.insertBefore(renderCard(o), list.firstChild); else list.appendChild(renderCard(o)); updateEmptyStates(); }

function markCardConfirmed(id){
  const el = document.querySelector(`[data-card-id="${CSS.escape(String(id))}"]`);
  if(!el) return;
  const statusEl = el.querySelector('.row.top .status');
  if(statusEl){ statusEl.textContent = 'Confirmado'; statusEl.classList.remove('pending','canceled'); statusEl.classList.add('confirmed'); }
  // Remove confirm button if still present
  const confirmBtn = el.querySelector('.actions .btn.btn-primary');
  if(confirmBtn){ confirmBtn.remove(); }
}

function moveToConfirmed(order){
  const id = order.id;
  // Remove from pending cache if present
  CACHE.pending = CACHE.pending.filter(o=> String(o.id)!==String(id));
  // Update/insert into confirmed cache
  const existingIdx = CACHE.confirmed.findIndex(o=> String(o.id)===String(id));
  if(existingIdx>=0) CACHE.confirmed[existingIdx] = order; else CACHE.confirmed.push(order);
  // Update UI lists according to current filter
  removeCard(id);
  applyActiveFilter();
}

function moveToCanceled(order){
  const id = order.id;
  CACHE.pending = CACHE.pending.filter(o=> String(o.id)!==String(id));
  CACHE.confirmed = CACHE.confirmed.filter(o=> String(o.id)!==String(id));
  removeCard(id);
  addCanceledCard(order);
  applyActiveFilter();
}

function removeFromCaches(id){
  const sid = String(id);
  CACHE.pending = CACHE.pending.filter(o=> String(o.id)!==sid);
  CACHE.confirmed = CACHE.confirmed.filter(o=> String(o.id)!==sid);
  CACHE.canceled = CACHE.canceled.filter(o=> String(o.id)!==sid);
}

async function deleteOrder(id, from){
  try{
    if(!confirm('¿Eliminar definitivamente este pedido?')) return;
    await apiFetch(`/api/pedidos/${encodeURIComponent(id)}`, { method:'DELETE' });
    removeFromCaches(id);
    removeCard(id);
    updateEmptyStates();
    toast('Pedido eliminado 🗑️','ok');
  } catch{ toast('No se pudo eliminar','err'); }
}

// =========================
// QR Modal + Relink
// =========================
let qrES=null; let qrTimeout=null; let relinkInProgress=false;
function setStatusBadge(state){ setBadge(state); setText('qrStatus', state||'—'); }
function openQrModal(){ const m=$id('modal-qr'); if(!m) return; m.classList.add('open'); const img=$id('qrImage'); if(img){ img.removeAttribute('src'); } setText('qrStatus','Esperando QR…'); setStatusBadge('initializing'); }
function closeQrModal(){ const m=$id('modal-qr'); if(!m) return; m.classList.remove('open'); if(qrES){ try{ qrES.close(); }catch{} qrES=null; } if(qrTimeout){ clearTimeout(qrTimeout); qrTimeout=null; } relinkInProgress=false; }
function startQrSSE(){
  const url = `/bot/qr?tenant=${encodeURIComponent(TENANT)}&ts=${Date.now()}`;
  if(qrES){ try{ qrES.close(); }catch{} }
  qrES = new EventSource(url);
  const img=$id('qrImage');
  if(qrTimeout) clearTimeout(qrTimeout);
  qrTimeout = setTimeout(()=>{ setText('qrStatus','No se pudo generar el QR'); relinkInProgress=false; try{ qrES?.close(); }catch{} qrES=null; }, 45000);
  qrES.addEventListener('qr', (e)=>{
    const data=e.data||'';
    if(typeof data==='string' && data.startsWith('data:')){ if(img) img.src=data; setText('qrStatus','Escanéalo con WhatsApp > Dispositivos vinculados'); }
    setStatusBadge('waiting_qr');
  });
  qrES.addEventListener('authenticated', ()=>{ setStatusBadge('authenticated'); if(qrTimeout){ clearTimeout(qrTimeout); qrTimeout=null; } try{ img?.removeAttribute('src'); }catch{} closeQrModal(); fetchStatus().catch(()=>{}); renderPedidos().catch(()=>{}); });
  qrES.addEventListener('ready', async ()=>{ setStatusBadge('ready'); if(qrTimeout){ clearTimeout(qrTimeout); qrTimeout=null; } try{ img?.removeAttribute('src'); }catch{} closeQrModal(); await loadStatus(); await renderPedidos(); });
  qrES.addEventListener('status', e=>{ try{ const d=JSON.parse(e.data||'{}'); if(d?.status) setStatusBadge(d.status); }catch{} });
}
async function startRelinkFlow(){ if(relinkInProgress) return; relinkInProgress=true; openQrModal(); try{ const r=await fetch(`/bot/relink?tenant=${encodeURIComponent(TENANT)}`, { method:'POST', credentials:'same-origin' }); if(!r.ok) throw new Error('Relink failed'); setStatusBadge('initializing'); startQrSSE(); } catch{ setText('qrStatus','No se pudo iniciar el relink'); relinkInProgress=false; } }

function wireButtons(){
  const btnStart=$id('btnStart'); if(btnStart){ btnStart.disabled=false; btnStart.onclick=async ()=>{
    if(btnStart.disabled) return;
    const action = btnStart.dataset.action || 'start';
    btnStart.disabled=true;
    try{
      const endpoint = action==='stop' ? '/bot/stop' : '/bot/start';
      await fetch(`${endpoint}?tenant=${encodeURIComponent(TENANT)}`, { method:'POST', credentials:'same-origin', headers:{ 'X-Tenant-Id': TENANT } });
      await refreshStatusNow();
      await loadTables();
    } finally { btnStart.disabled=false; }
  }; }
  const btnRelink=$id('btnRelink'); if(btnRelink){ btnRelink.onclick=async ()=>{ if(btnRelink.disabled||relinkInProgress) return; if(!confirm('Esto desconectará la cuenta actual y borrará la sesión. ¿Continuar?')) return; btnRelink.disabled=true; try{ await startRelinkFlow(); } finally { btnRelink.disabled=false; } }; }
  // QR oculto: sin wiring
  const btnCloseQr=$id('btnCloseQr'); if(btnCloseQr){ btnCloseQr.onclick=()=> closeQrModal(); }
  const btnLogout=$id('btnLogout'); if(btnLogout){ btnLogout.onclick=()=>{ location.href='/login.html?logout=1'; }; }
  // Filtro único por teléfono (aplica a la pestaña activa)
  const input=$id('phoneFilter'); const clearBtn=$id('clearFilter');
  const onInput = debounce(()=> applyActiveFilter(), 160);
  if(input){ input.addEventListener('input', onInput); input.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ input.value=''; applyActiveFilter(); } }); }
  if(clearBtn){ clearBtn.addEventListener('click', ()=>{ if(input){ input.value=''; input.focus(); } applyActiveFilter(); }); }
}

// =========================
// Socket opcional (solo para compat)
// =========================
let socket=null;
function initSocketOnce(){ if(socket) return socket; if(typeof io==='undefined') return null; socket = io({ query:{ tenant:TENANT } }); socket.off('orders:update'); socket.on('orders:update', ()=>{ loadTables(); }); return socket; }

// =========================
// Reloj (encabezado)
// =========================
function startClock(){ const el=$id('clock'); if(!el) return; const upd=()=>{ const d=new Date(); const pad=n=>String(n).padStart(2,'0'); el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`; }; upd(); setInterval(upd, 15000); }

// =========================
// App bootstrap
// =========================
const App=(function(){ let started=false; return { init: async function(){ if(started) return; started=true; wireTabs(); wireButtons(); initSocketOnce(); if(!es) startEvents(); await loadStatus(); startStatusPolling(); await loadTables(); startClock(); updateEmptyStates(); } }; })();

window.addEventListener('DOMContentLoaded', ()=>{ App.init(); });

// Expose debug helpers
window.loadStatus = loadStatus;
window.loadTables = loadTables;
window.addPendingCard = addPendingCard;
window.addCanceledCard = addCanceledCard;
