// =========================
// Helpers y constantes
// =========================
// TENANT debe ser el ID lógico en backend (ej: 'samuel'), no el nombre de marca
const TENANT = window.CURRENT_TENANT || window.TENANT || 'samuel';
const $id = (id) => document.getElementById(id);
const setText = (id, txt) => { const el=$id(id); if(el) el.textContent = txt; };
function safeEscape(sel){
  try { if(window.CSS && typeof window.CSS.escape==='function') return window.CSS.escape(String(sel)); } catch{}
  return String(sel).replace(/[^a-zA-Z0-9_\-]/g,'_');
}

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

// Persistencia de cancelados vistos (helpers ya definidos más abajo si no existen)
// (Aseguramos que no haya duplicados; si ya están definidos, no redefinimos.)
if(typeof loadSeenCanceled === 'undefined'){
  const LS_SEEN = 'seenCanceledIds';
  const LS_LAST = 'lastVisitCanceled';
  function loadSeenCanceled(){ try { return new Set(JSON.parse(localStorage.getItem(LS_SEEN) || '[]')); } catch { return new Set(); } }
  function saveSeenCanceled(set){ try { localStorage.setItem(LS_SEEN, JSON.stringify([...set])); } catch{} }
  function loadLastVisitCanceled(){ try { const v=Number(localStorage.getItem(LS_LAST)); return Number.isFinite(v)?v:0; } catch { return 0; } }
  function saveLastVisitCanceled(ms){ try { localStorage.setItem(LS_LAST, String(ms)); } catch{} }
  window.loadSeenCanceled = loadSeenCanceled;
  window.saveSeenCanceled = saveSeenCanceled;
  window.loadLastVisitCanceled = loadLastVisitCanceled;
  window.saveLastVisitCanceled = saveLastVisitCanceled;
}

// =========================
// Estado en memoria para cancelados vistos / frescos
// =========================
let seenCanceledIds = (typeof loadSeenCanceled === 'function') ? loadSeenCanceled() : new Set();
let lastVisitCanceled = (typeof loadLastVisitCanceled === 'function') ? loadLastVisitCanceled() : 0;
if(!Number.isFinite(lastVisitCanceled) || lastVisitCanceled <= 0){
  lastVisitCanceled = Date.now();
  if(typeof saveLastVisitCanceled === 'function') try { saveLastVisitCanceled(lastVisitCanceled); } catch{}
}

// Un pedido cancelado es "fresh" si:
//  - status === 'canceled'
//  - su id NO está en seenCanceledIds
//  - canceledAt (o createdAt fallback) > lastVisitCanceled
function isFreshCanceled(order){
  try {
    if(!order) return false;
    if(String(order.status||'').toLowerCase() !== 'canceled') return false;
    // Si es una cancelación originada por modificación (tiene replacedBy) mostrar siempre como fresh
    if(order.replacedBy) return true;
    const id = String(order.id);
    if(seenCanceledIds.has(id)) return false;
    const ts = Number(order.canceledAt || order.createdAt || 0);
    if(!Number.isFinite(ts)) return false;
    return ts > lastVisitCanceled;
  } catch { return false; }
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
    const isDisconnected = (s==='disconnected' || s==='error');
    start.textContent = isReady ? 'Apagar Bot' : 'Iniciar Bot';
    start.dataset.action = isReady ? 'stop' : 'start';
    // Deshabilitar solo en transición inicial QR/auth
    start.disabled = ['initializing','waiting_qr'].includes(s);
    // Siempre permitir volver a iniciar si está desconectado
    if(isDisconnected){ start.disabled = false; }
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
// apiFetch wrapper (añade tenant y reintentos)
// =========================
async function apiFetch(url, opt={}, attempt=0){
  try {
    const needsTenant = url.startsWith('/api/') || url.startsWith('/bot/') || url.startsWith('/records') || url.startsWith('/logs');
    const hasQuery = url.includes('?');
    const sep = hasQuery ? '&' : '?';
    const finalUrl = needsTenant ? `${url}${sep}tenant=${encodeURIComponent(TENANT)}` : url;
    const controller = new AbortController();
    const timeout = setTimeout(()=> controller.abort(), 12000);
    const res = await fetch(finalUrl, {
      credentials:'same-origin',
      headers: { 'X-Tenant-Id': TENANT, ...(opt.headers||{}) },
      signal: controller.signal,
      ...opt
    });
    clearTimeout(timeout);
    if(!res.ok){
      if(res.status===429 && attempt<2){
        await new Promise(r=>setTimeout(r, 500 * (attempt+1)));
        return apiFetch(url, opt, attempt+1);
      }
      let errJson=null; try { errJson=await res.json(); } catch{}
      return errJson || { ok:false, status: res.status };
    }
    const ct = res.headers.get('content-type')||'';
    if(ct.includes('application/json')) return await res.json();
    return await res.text();
  } catch(e){
    if(attempt < 2){
      await new Promise(r=>setTimeout(r, 400 * (attempt+1)));
      return apiFetch(url, opt, attempt+1);
    }
    return { ok:false, error: e.message || 'fetch_failed' };
  }
}

// =========================
// Tabs
// =========================
function switchTab(name){
  const tabs = document.querySelectorAll('.tabbar .tab');
  tabs.forEach(t=> t.classList.toggle('active', t.getAttribute('data-target')===name));
  const from = document.querySelector('.tabs-container .panel.active');
  const to = document.querySelector(`.tabs-container .panel[data-name="${safeEscape(String(name))}"]`);
  if(from === to) return;
  if(from){ from.classList.remove('active'); from.classList.add('leave-left'); setTimeout(()=> from.classList.remove('leave-left'), 350); }
  if(to){ to.classList.add('active'); }
  // Reaplicar filtro al cambiar de pestaña
  applyActiveFilter();

  // Eliminado auto-dismiss de cancelados: sólo botón "Marcar todos vistos" o borrado manual.
}
function wireTabs(){
  document.querySelectorAll('.tabbar .tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const target = btn.getAttribute('data-target');
      switchTab(target);
      try { updateProductionButtonVisibility(); } catch{}
      if(target==='historico'){
        try { ensureHistoricalLoaded(); } catch(e){ console.error(e); }
      }
    });
  });
}

function updateProductionButtonVisibility(){
  const btn = document.getElementById('btnProduction');
  if(!btn) return;
  const active = document.querySelector('.tabbar .tab.active');
  const name = active ? active.getAttribute('data-target') : 'pendientes';
  // Solo visible en confirmados
  btn.style.display = (name==='confirmados') ? 'inline-flex' : 'none';
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
  const wasReplaced = isCanceled && !!order.replacedBy;
  const isModified = !!order.modified || !!order.replaces;
  if(isCanceled){
    const fresh = isFreshCanceled(order);
    card.className = 'order-card canceled ' + (fresh ? 'is-fresh highlight-new' : 'dismissed');
  } else {
    card.className = 'order-card';
  }
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
      let sab;
      if(Array.isArray(it.sabores_distribucion) && it.sabores_distribucion.length){
        sab = it.sabores_distribucion.map(d=>`${safe(d.flavor)} x${safe(String(d.count))}`).join(', ');
      } else if (Array.isArray(it.sabores)) {
        sab = it.sabores.join(', ');
      } else if (Array.isArray(it.sabores_por_porcion)) {
        sab = it.sabores_por_porcion.map((arr,i)=>`${i+1}) ${arr.join(', ')}`).join(' | ');
      } else {
        sab = '';
      }
      const sub = (typeof it.total === 'number') ? `${it.total}€` : '';
      const obs = it.observacion ? ` • Obs: ${safe(String(it.observacion))}` : '';
      return `<div class="row"><strong>${idx+1})</strong> <span>${safe(label)} x${safe(String(cant))} • ${safe(sab||'-')}${sub?` • ${safe(sub)}`:''}${obs}</span></div>`;
    }).join('');
    itemsHtml = `<div class="rows">${rows}</div>`;
  } else {
    const sabores = joinSabores(order);
    const cantidad = getCantidad(order);
    const tamano = (order?.fields?.tamano ?? order?.tamano ?? '') || '';
    itemsHtml = `
      <div class="row"><strong>Tamaño:</strong> <span>${safe(tamano)}</span></div>
      <div class="row"><strong>Sabores:</strong> <span>${safe(sabores)}</span></div>
      <div class="row"><strong>Cantidad:</strong> <span>${safe(String(cantidad))}</span></div>
    `;
  }

  let statusLabel;
  if(isCanceled){
    if(wasReplaced){
      statusLabel = 'Cancelación modificación';
    } else {
      statusLabel = 'Cancelado';
    }
  } else if(isConfirmed){
    statusLabel = 'Confirmado';
  } else {
    statusLabel = isModified ? 'Modificado y pendiente' : 'Pendiente';
  }
  card.innerHTML = `
    <div class="row top">
      <span class="date">${safe(fmtDate(displayTs))}</span>
      <span class="status ${isCanceled?'canceled':(isConfirmed?'confirmed':'pending')} ${wasReplaced?'modified-cancel':''} ${(!isCanceled && !isConfirmed && isModified)?'modified-pending':''}">${safe(statusLabel)}</span>
    </div>
    <div class="row"><strong>Tel:</strong> <span>${safe(telefono)}</span></div>
    ${(isPending||isConfirmed) && fechaRecogida ? `<div class="row"><strong>Recogida:</strong> <span>${safe(fechaRecogida)}</span></div>` : ''}
    
    ${itemsHtml}
    ${total!=null? `<div class="row"><strong>Total:</strong> <span>${safe(String(total))}€</span></div>`:''}
    ${wasReplaced ? `<div class="row replaced"><strong>Reemplazado por:</strong> <span>#${safe(String(order.replacedBy))}</span></div>`:''}
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

  // Cancel button: allow for pending or confirmed
  if(isConfirmed || isPending){
      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn btn-warning';
      btnCancel.textContent='Cancelar';
      btnCancel.onclick = async ()=>{
        if(btnCancel.disabled) return; const prev=btnCancel.disabled; btnCancel.disabled=true;
        try { await cancelOrder(order.id); } finally { btnCancel.disabled=prev; }
      };
      actions.appendChild(btnCancel);
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
  if(listId==='list-cancelados'){
    ensureMarkSeenButton();
    // Attach dismiss handlers to all fresh canceled cards (batch render)
    try { cont.querySelectorAll('.order-card.canceled.is-fresh').forEach(c=> attachFreshDismissHandler(c)); } catch{}
  }
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

// =========================
// Helpers fecha / cache confirmados
// =========================
function ddmmToYmd(ddmm){
  const m = String(ddmm||'').trim().match(/^(\d{2})[\/-](\d{2})(?:[\/-](\d{2,4}))?$/);
  if(!m) return null;
  const now=new Date();
  const y = m[3] ? (m[3].length===2 ? 2000+Number(m[3]) : Number(m[3])) : now.getFullYear();
  return `${y}-${m[2]}-${m[1]}`;
}
async function ensureConfirmedCache(){
  if(Array.isArray(CACHE?.confirmed) && CACHE.confirmed.length) return CACHE.confirmed;
  const arr = await fetchPedidos('confirmed');
  CACHE.confirmed = Array.isArray(arr)? arr:[];
  return CACHE.confirmed;
}
async function getConfirmedByDate(ymd){
  const confirmed = await ensureConfirmedCache();
  return confirmed.filter(o=>{
    const raw = o?.fields?.fecha || o?.fecha || '';
    const cmp = ddmmToYmd(raw);
    return cmp === ymd;
  });
}

function summarizeProduction(orders){
  const out = { tartas:{ total:0, porSabor:{} }, cajitas:{ total:0, porSabor:{} }, rows:[] };
  const add = (tipo, sabor, qty)=>{
    const bucket = out[tipo]; bucket.total += qty; bucket.porSabor[sabor] = (bucket.porSabor[sabor]||0)+qty;
  };
  for(const o of orders){
    const items = Array.isArray(o.items) ? o.items : (Array.isArray(o.fields?.items) ? o.fields.items : []);
    for(const it of (items||[])){
      const tipo = (it.type==='cajitas' || it.tamano==='cajitas' || /cajitas/i.test(it.label||'')) ? 'cajitas' : 'tartas';
      const dist = Array.isArray(it.sabores_distribucion) ? it.sabores_distribucion : null;
      if(dist && dist.length){
        for(const d of dist){ add(tipo, String(d.flavor), Number(d.count)||0); }
      } else if(Array.isArray(it.sabores) && (it.cantidad!=null)) {
        const sabores = Array.isArray(it.sabores) ? it.sabores.filter(Boolean).map(String) : [];
        const n = Number(it.cantidad)||0;
        if(n <= 0) continue;
        if(sabores.length === 0){
          // Sin sabores listados -> usar 'Variado'
            add(tipo, 'Variado', n);
        } else if(sabores.length === 1){
          add(tipo, sabores[0], n);
        } else if(sabores.length === n){
          for(const s of sabores){ add(tipo, s, 1); }
        } else {
          for(let i=0;i<n;i++){ add(tipo, sabores[i % sabores.length], 1); }
        }
      } else {
        add(tipo, '—', Number(it.cantidad||1));
      }
    }
  }
  for(const [sabor,qty] of Object.entries(out.tartas.porSabor)) out.rows.push({ tipo:'Tarta', sabor, cantidad:qty });
  for(const [sabor,qty] of Object.entries(out.cajitas.porSabor)) out.rows.push({ tipo:'Cajitas', sabor, cantidad:qty });
  out.rows.sort((a,b)=> a.tipo===b.tipo ? a.sabor.localeCompare(b.sabor) : (a.tipo>b.tipo?1:-1));
  return out;
}

function renderProduction(sum){
  const el=$id('prodResult'); if(!el) return;
  const tot = `
    <h4>Totales</h4>
    <ul>
      <li>Tartas: ${sum.tartas.total}</li>
      <li>Cajitas: ${sum.cajitas.total}</li>
    </ul>`;
  const rows = sum.rows.map(r=>`<tr><td>${r.tipo}</td><td>${r.sabor}</td><td>${r.cantidad}</td></tr>`).join('');
  el.innerHTML = tot + `
    <h4>Por sabor</h4>
    <div class="table-wrap">
      <table><thead><tr><th>Tipo</th><th>Sabor</th><th>Cantidad</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">Sin datos</td></tr>'}</tbody></table>
    </div>
    <div class="actions">
      <button id="prodCopy" class="btn">Copiar</button>
    </div>`;
  $id('prodCopy')?.addEventListener('click', ()=>{
    const tsv = ['Tipo\tSabor\tCantidad', ...sum.rows.map(r=>`${r.tipo}\t${r.sabor}\t${r.cantidad}`)].join('\n');
    navigator.clipboard.writeText(tsv).then(()=> toast('Copiado ✅','ok')).catch(()=> toast('No se pudo copiar','err'));
  });
}

// Local cache for filtering without re-fetch
let CACHE = { pending: [], confirmed: [], canceled: [] };

// Utility: remove order by id from all caches
function removeFromCaches(id){
  const sid = String(id);
  CACHE.pending = CACHE.pending.filter(o=> String(o.id)!==sid);
  CACHE.confirmed = CACHE.confirmed.filter(o=> String(o.id)!==sid);
  // (Mantener filtrado centralizado aquí; líneas sueltas eliminadas)
  CACHE.canceled = CACHE.canceled.filter(o=> String(o.id)!==sid);
  return true;
}

// (Ya movido arriba) Persistencia de cancelados vistos: ver definiciones previas
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
  updateCanceledBadge();
}

async function renderPedidos(){
  try{
    const [pending, confirmed, canceled] = await Promise.all([
      fetchPedidos('pending'),
      fetchPedidos('confirmed'),
      fetchPedidos('canceled')
    ]);
    // Helper to parse DD-MM or DD/MM (no year -> current year)
    const parsePickupTs = (o)=>{
      try{
        const raw = (o?.fields?.fecha || o?.fecha || '').trim();
        if(!raw) return Number.MAX_SAFE_INTEGER;
        const m = raw.match(/^(\d{2})[\/-](\d{2})(?:[\/-](\d{2,4}))?$/);
        if(!m) return Number.MAX_SAFE_INTEGER;
        const dd = Number(m[1]); const mm = Number(m[2]);
        const now = new Date();
        const yyyy = (m[3]? (m[3].length===2 ? 2000+Number(m[3]) : Number(m[3])) : now.getFullYear());
        const dt = new Date(yyyy, mm-1, dd, 0,0,0,0);
        if(isNaN(dt.getTime())) return Number.MAX_SAFE_INTEGER;
        return dt.getTime();
      }catch{ return Number.MAX_SAFE_INTEGER; }
    };
    CACHE.pending = Array.isArray(pending)? pending:[];
    CACHE.confirmed = Array.isArray(confirmed)? [...confirmed].sort((a,b)=> parsePickupTs(a) - parsePickupTs(b)) : [];
    CACHE.canceled = Array.isArray(canceled)? canceled:[];
    // Dev-only mock: si vacío y en localhost, intentar cargar mock de confirmados
    try{
      if(CACHE.confirmed.length===0 && (location.hostname==='localhost' || location.hostname==='127.0.0.1')){
        const mockResp = await fetch('/public/pedidos_confirmados_mock.json', { cache:'no-store' });
        if(mockResp.ok){
          const mockData = await mockResp.json().catch(()=>[]);
          if(Array.isArray(mockData) && mockData.length){
            CACHE.confirmed = mockData.map(o=>({ ...o }));
          }
        }
      }
    }catch{}
    // Rellenamos listas sin filtrar inicialmente y aplicamos filtro a la activa
    clearAndFill('list-pendientes', CACHE.pending);
    clearAndFill('list-confirmados', CACHE.confirmed);
    clearAndFill('list-cancelados', CACHE.canceled);
    // Sólo añadir highlight si hay fresh; no quitarlo aquí (se limpia al entrar en la pestaña)
    const anyFresh = document.querySelector('#list-cancelados .order-card.canceled.is-fresh');
    if(anyFresh){
      const cancelTab = document.querySelector('.tabbar .tab[data-target="cancelados"]');
      if(cancelTab) cancelTab.classList.add('highlight-cancelados');
    }
    applyActiveFilter();
    // Asegurar badge y alarma actualizados tras render completo
    updateCanceledBadge();
    ensureCancelTabAlarm();
    try { console.log('[freshCount]', countFreshCanceled()); } catch{}
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
  // Centralized removal via helper to avoid stray filter lines
  removeFromCaches(sid);
      const idx = CACHE.pending.findIndex(o=> String(o.id)===sid);
      if(idx>=0) CACHE.pending[idx] = ord; else CACHE.pending.push(ord);
      applyActiveFilter();
      // Refresco de seguridad: reconsultar listas para evitar estados intermedios
      // (p. ej. si llegan eventos fuera de orden)
      renderPedidos().then(()=>{ try { ensureCancelTabAlarm(); } catch{} }).catch(()=>{});
    }catch{}
  });
  es.addEventListener('order_canceled', e=>{ try{ const d=JSON.parse(e.data||'{}'); if(d?.order){ moveToCanceled(d.order); ensureCancelTabAlarm(); ensureMarkSeenButton(); } }catch{} });
  es.addEventListener('order_confirmed', e=>{ try{ const d=JSON.parse(e.data||'{}'); if(d?.order){ moveToConfirmed(d.order); toast('Pedido confirmado ✅','ok'); } }catch{} });
  es.addEventListener('error', ()=>{ try{ es.close(); }catch{}; setTimeout(startEvents, 2500); });
}
window.addEventListener('beforeunload', ()=>{ if(es) try{ es.close(); }catch{} });

// Helpers SSE mutations
function removeCard(id){ const el=document.querySelector(`[data-card-id="${safeEscape(String(id))}"]`); if(el){ el.remove(); updateEmptyStates(); } }
function addPendingCard(order){ const list=$id('list-pendientes'); if(!list) return; list.appendChild(renderCard(order)); updateEmptyStates(); }
function addCanceledCard(order){
  const list=$id('list-cancelados'); if(!list) return;
  const o={...order}; if(o.canceledAt) o.createdAt=o.canceledAt;
  let newCard;
  if(list.firstChild){ newCard = renderCard(o); list.insertBefore(newCard, list.firstChild); }
  else { newCard = renderCard(o); list.appendChild(newCard); }
  updateEmptyStates();
  updateCanceledBadge();
  ensureMarkSeenButton();
}

function markCardConfirmed(id){
  const el = document.querySelector(`[data-card-id="${safeEscape(String(id))}"]`);
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
  updateCanceledBadge();
  ensureCancelTabAlarm();
  try { console.log('[freshCount]', countFreshCanceled()); } catch{}
}

function countFreshCanceled(){
  return document.querySelectorAll('#list-cancelados .order-card.canceled.is-fresh').length;
}
function updateCanceledBadge(){
  const n = countFreshCanceled();
  const badge = document.getElementById('badge-cancelados');
  if(!badge) return;
  if(n>0){ badge.textContent = String(n); badge.hidden=false; } else { badge.hidden=true; }
}
function ensureCancelTabAlarm(){
  const tab = document.querySelector('.tabbar .tab[data-target="cancelados"]');
  if(!tab) return;
  if(countFreshCanceled()>0) tab.classList.add('highlight-cancelados');
}
function ensureMarkSeenButton(){
  const panel = document.getElementById('panel-cancelados'); if(!panel) return;
  let bar = panel.querySelector('.mark-seen-bar');
  if(!bar){
    bar = document.createElement('div');
    bar.className = 'mark-seen-bar';
    const btn = document.createElement('button');
    btn.className = 'btn-mark-seen';
    btn.textContent = 'Marcar todos vistos';
    btn.addEventListener('click', ()=> markAllCanceledSeen());
    bar.appendChild(btn);
    panel.insertBefore(bar, panel.firstChild);
  }
  bar.hidden = countFreshCanceled() === 0;
}
function markAllCanceledSeen(){
  const now=Date.now(); saveLastVisitCanceled(now); lastVisitCanceled=now;
  document.querySelectorAll('#list-cancelados .order-card.canceled.is-fresh').forEach(el=>{
    const id=el.getAttribute('data-card-id'); if(id) seenCanceledIds.add(String(id));
    el.classList.remove('is-fresh'); el.classList.add('dismissed');
  });
  saveSeenCanceled(seenCanceledIds);
  updateCanceledBadge();
  ensureMarkSeenButton();
  const cancelTab = document.querySelector('.tabbar .tab[data-target="cancelados"]');
  if(cancelTab) cancelTab.classList.remove('highlight-cancelados');
}
// Eliminada línea suelta de filtrado redundante

async function deleteOrder(id, from){
  try {
    if(!confirm('¿Eliminar definitivamente este pedido?')) return false;
    if(from === 'canceled'){
      try { seenCanceledIds.add(String(id)); saveSeenCanceled(seenCanceledIds); } catch{}
    }
    const res = await fetch(`/api/pedidos/${encodeURIComponent(id)}?tenant=${encodeURIComponent(TENANT)}`, { method:'DELETE', credentials:'same-origin', headers:{ 'X-Tenant-Id': TENANT } });
    if(!res.ok){
      let body='';
      try { body = (await res.text()) || res.statusText || 'Error'; } catch { body = res.statusText || 'Error'; }
      throw new Error(body);
    }
  removeFromCaches(id);
  removeCard(id);
  updateEmptyStates();
  await renderPedidos();
  try { ensureCancelTabAlarm(); } catch{}
    toast('Pedido eliminado 🗑️','ok');
    try { console.debug('SUCCESS delete', id); } catch{}
    return true;
  } catch(err){
    toast(`No se pudo eliminar: ${err && err.message ? err.message : 'Error'}`,'err');
    return false;
  }
}

// Cancel order (pending or confirmed) -> cancel OR remove (if pending)
async function cancelOrder(id){
  try {
    const res = await fetch(`/api/pedidos/${encodeURIComponent(id)}/cancel?tenant=${encodeURIComponent(TENANT)}`, { method:'POST', credentials:'same-origin', headers:{ 'X-Tenant-Id': TENANT } });
    if(!res.ok){
      let msg='';
      try { msg = (await res.text()) || res.statusText || 'Error'; } catch { msg = res.statusText || 'Error'; }
      throw new Error(msg);
    }
    const data = await res.json().catch(()=>({}));
    if(data.removed){
  removeFromCaches(id);
  removeCard(id);
  updateEmptyStates();
  await renderPedidos();
  try { ensureCancelTabAlarm(); } catch{}
      toast('Pedido eliminado','ok');
    } else if(data.order){
  removeFromCaches(id);
  removeCard(id);
  CACHE.canceled.push(data.order);
  addCanceledCard(data.order);
  updateEmptyStates();
  try { ensureCancelTabAlarm(); } catch{}
    } else {
  await renderPedidos();
  try { ensureCancelTabAlarm(); } catch{}
    }
    try { console.debug('SUCCESS cancel', id); } catch{}
    return true;
  } catch(err){
    toast(`No se pudo cancelar: ${err && err.message ? err.message : 'Error'}`,'err');
    return false;
  }
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
const App=(function(){ let started=false; return { init: async function(){ if(started) return; started=true; wireTabs(); wireButtons(); initSocketOnce(); if(!es) startEvents(); await loadStatus(); startStatusPolling(); await loadTables(); startClock(); updateEmptyStates(); try{ updateProductionButtonVisibility(); }catch{} } }; })();

// =========================
// Producción: abrir/cerrar modal + fecha por defecto
// =========================
try{
  const modal=$id('modalProduction');
  const btnOpen=$id('btnProduction');
  const btnClose=$id('prodClose');
  const btnCalc=$id('prodCalc');
  const inpDate=$id('prodDate');
  function openProd(){
    if(!modal) return;
    modal.classList.remove('hidden');
    if(inpDate){
      const t=new Date();
      const y=t.getFullYear();
      const m=String(t.getMonth()+1).padStart(2,'0');
      const d=String(t.getDate()).padStart(2,'0');
      inpDate.value=`${y}-${m}-${d}`;
      try{ inpDate.focus(); }catch{}
    }
  }
  function closeProd(){ if(!modal) return; modal.classList.add('hidden'); const r=$id('prodResult'); if(r) r.innerHTML=''; }
  btnOpen?.addEventListener('click', openProd);
  btnClose?.addEventListener('click', closeProd);
  modal?.addEventListener('click', (e)=>{ if(e.target===modal) closeProd(); });
  btnCalc?.addEventListener('click', async ()=>{
    const ymd = String(inpDate?.value||'').trim();
    if(!ymd) return;
    const orders = await getConfirmedByDate(ymd);
    const sum = summarizeProduction(orders);
    renderProduction(sum);
  });
}catch{}

window.addEventListener('DOMContentLoaded', ()=>{ App.init(); });

// =========================
// Histórico mensual
// =========================
let HIST_CACHE = { month:null, data:null };
async function fetchHistorico(month){
  const res = await fetch(`/historico?month=${encodeURIComponent(month)}&tenant=${encodeURIComponent(TENANT)}`, { credentials:'same-origin' });
  if(!res.ok) throw new Error('historico_failed');
  return await res.json();
}
function currentMonthStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
function ensureHistoricalMonthInput(){
  const inp = $id('histMonth'); if(!inp) return;
  if(!inp.value) inp.value = currentMonthStr();
}
function renderBarRows(container, map){
  if(!container) return; container.innerHTML='';
  const entries = Object.entries(map||{}).sort((a,b)=> b[1]-a[1]);
  let max = 0; for(const [,v] of entries) if(v>max) max=v;
  if(entries.length===0){ container.innerHTML='<div style="opacity:.6;font-size:.7rem;">Sin datos</div>'; return; }
  for(const [name,val] of entries){
    const intVal = Math.round(val);
    const row=document.createElement('div'); row.className='bar-row';
    row.innerHTML=`<div class="flavor" title="${safe(name)}">${safe(name)}</div><div class="bar-wrap"><div class="bar" style="width:${max? ((val/max)*100).toFixed(1):0}%;"></div></div><div class="count">${intVal}</div>`;
    container.appendChild(row);
  }
}
function renderHistorico(data){
  if(!data) return;
  const sumEl = $id('histSummary');
  if(sumEl){
    sumEl.innerHTML = `
      <div class="metric"><span class="label">Pedidos</span><span class="value">${data.totalPedidos}</span></div>
      <div class="metric"><span class="label">Importe €</span><span class="value">${Number(data.totalImporte||0).toFixed(2)}</span></div>
      <div class="metric"><span class="label">Sabores</span><span class="value">${Object.keys(data.sabores||{}).length}</span></div>
      <div class="metric"><span class="label">Tamaños</span><span class="value">${Object.keys(data.tamanos||{}).length}</span></div>
    `;
  }
  renderBarRows($id('histSabores'), data.sabores);
  renderBarRows($id('histTamanos'), data.tamanos);
}
async function loadHistorico(force=false){
  ensureHistoricalMonthInput();
  const month = $id('histMonth')?.value || currentMonthStr();
  if(!force && HIST_CACHE.month===month && HIST_CACHE.data){ renderHistorico(HIST_CACHE.data); return; }
  try {
    const data = await fetchHistorico(month);
    HIST_CACHE = { month, data };
    renderHistorico(data);
  } catch(e){ console.error('[historico] fetch error', e); const sumEl=$id('histSummary'); if(sumEl) sumEl.innerHTML='<div style="color:#b91c1c;font-size:.7rem;">Error cargando histórico</div>'; }
}
function ensureHistoricalLoaded(){ loadHistorico(false); }
// Wiring botones histórico
document.addEventListener('DOMContentLoaded', ()=>{
  const btn = $id('histReload'); if(btn){ btn.addEventListener('click', ()=> loadHistorico(true)); }
  const inp=$id('histMonth'); if(inp){ inp.addEventListener('change', ()=> loadHistorico(true)); }
});

// Expose debug helpers
window.loadStatus = loadStatus;
window.loadTables = loadTables;
window.addPendingCard = addPendingCard;
window.addCanceledCard = addCanceledCard;
