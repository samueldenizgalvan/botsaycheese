// Robust order store ensuring pedidos.json is always a JSON array
const { join, dirname } = require('path');
const fs = require('fs/promises');
const path = require('path');

const dataDir = join(process.cwd(), 'data');
const fileFor = (tenantId) => join(dataDir, tenantId, 'pedidos.json');

let _io = null;
function setIO(io){ _io = io; }

// Price calculator based on cfg.options.precios and cantidad
function calcTotal(cfg, tamano, cantidad){
  try{
    const precios = (cfg && cfg.options && cfg.options.precios) || {};
    const p = Number(precios[tamano] || 0);
    const n = Number(cantidad || 0);
    const total = p * (Number.isFinite(n) ? n : 0);
    return Math.round(total * 100) / 100;
  } catch { return 0; }
}

// Emite evento unificado tras cambios de pedidos
async function afterWrite(tenantId){
  try {
    const serverMod = require('../server');
    const io = (_io) || serverMod.io || (globalThis.app && globalThis.app.get && globalThis.app.get('io'));
    if(io) io.to(tenantId).emit('orders:update');
  if(serverMod.pushEvent) serverMod.pushEvent('order:changed', { tenantId });
  } catch(e){ /* silencioso */ }
}

// Migra / normaliza pedidos.json asegurando array y shape mínima
async function migratePedidosFile(tenantId){
  const f = fileFor(tenantId);
  try {
    const raw = await fs.readFile(f,'utf8');
    let arr = [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch(e) { parsed = null; }
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === 'object') {
      arr = [ parsed ];
    } else if (raw.trim().startsWith('{')) {
      // Posibles objetos sueltos concatenados
      const fixed = '[' + raw.trim().replace(/}\s*{/g,'},{') + ']';
      try { arr = JSON.parse(fixed); } catch { arr = []; }
    } else {
      arr = [];
    }
    if (!Array.isArray(arr)) arr = [];
    // Normalizar elementos
    let nextIdNum = 1;
    for (let i=0;i<arr.length;i++){
      let o = arr[i];
      if (!o || typeof o !== 'object') { o = {}; arr[i] = o; }
      if (!o.fields || typeof o.fields !== 'object') o.fields = {};
      if (!o.customer || typeof o.customer !== 'object') {
  o.customer = { phone: o.fields.telefono || o.telefono || '' };
      }
      if (o.total == null || isNaN(Number(o.total))) o.total = 0;
      if (!o.status) o.status = 'pending';
      if (!o.id) { o.id = String(nextIdNum); nextIdNum++; } else {
        // keep numeric progression reference
        const asNum = Number(o.id); if (!isNaN(asNum) && asNum >= nextIdNum) nextIdNum = asNum + 1;
      }
    }
    await saveAll(tenantId, arr);
    return arr;
  } catch { return []; }
}

async function readAll(tenantId){
  // Verificar existencia explícita para errores claros
  const f = fileFor(tenantId);
  try { await fs.access(f); } catch(e){ throw new Error(`Archivo pedidos no existe para tenant '${tenantId}'`); }
  return migratePedidosFile(tenantId);
}

// Lectura ligera sin migración (solo parse si existe) para endpoints de solo lectura rápidos
async function readAllFast(tenantId){
  const f = fileFor(tenantId);
  try { await fs.access(f); } catch { return []; }
  try {
    const raw = await fs.readFile(f,'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveAll(tenantId, orders){
  const f = fileFor(tenantId);
  await fs.mkdir(dirname(f), { recursive:true });
  const arr = Array.isArray(orders) ? orders : [];
  await fs.writeFile(f, JSON.stringify(arr, null, 2), 'utf8');
  return arr;
}

function nextId(arr){
  const last = arr.at(-1);
  const base = last && last.id && !isNaN(Number(last.id)) ? Number(last.id) : arr.length;
  return String(base + 1);
}

async function append(tenantId, order){
  const all = await readAll(tenantId);
  const rec = { id: nextId(all), status: order.status || 'pending', createdAt: Date.now(), ...order };
  if(!rec.status) rec.status = 'pending';
  all.push(rec);
  await saveAll(tenantId, all);
  if(_io) _io.to(tenantId).emit('order:new', rec);
  await afterWrite(tenantId);
  try { scheduleReminder(tenantId, rec).catch(()=>{}); } catch{}
  // SSE: evento específico de creación
  try { const serverMod = require('../server'); if(serverMod.pushEvent) serverMod.pushEvent('order_created', { tenantId, order: rec }); } catch{}
  return rec;
}

async function listByStatus(tenantId, status){
  return (await readAll(tenantId)).filter(o=>o.status===status);
}

async function confirm(tenantId, id){
  const all = await readAll(tenantId);
  const idx = all.findIndex(o=>o.id===String(id));
  if (idx<0) throw new Error(`Pedido ${id} no encontrado`);
  all[idx].status = 'confirmed';
  all[idx].confirmedAt = Date.now();
  await saveAll(tenantId, all);
  if(_io) _io.to(tenantId).emit('order:confirmed', { id: all[idx].id });
  await afterWrite(tenantId);
  // SSE: evento específico de confirmación con orden
  try { const serverMod = require('../server'); if(serverMod.pushEvent) serverMod.pushEvent('order_confirmed', { tenantId, order: all[idx] }); } catch{}
  return all[idx];
}

async function cancel(tenantId, id){
  const all = await readAll(tenantId);
  const idx = all.findIndex(o=>o.id===String(id));
  if (idx<0) throw new Error(`Pedido ${id} no encontrado`);
  all[idx].status = 'canceled';
  all[idx].canceledAt = Date.now();
  await saveAll(tenantId, all);
  if(_io) _io.to(tenantId).emit('order:canceled', { id: all[idx].id });
  await afterWrite(tenantId);
  // SSE: evento específico de cancelación con orden
  try { const serverMod = require('../server'); if(serverMod.pushEvent) serverMod.pushEvent('order_canceled', { tenantId, order: all[idx] }); } catch{}
  return all[idx];
}

async function remove(tenantId, id){
  const all = await readAll(tenantId);
  const idx = all.findIndex(o=>o.id===String(id));
  if (idx<0) throw new Error(`Pedido ${id} no encontrado`);
  const removed = all.splice(idx,1)[0];
  await saveAll(tenantId, all);
  if(_io) _io.to(tenantId).emit('order:deleted', { id: removed.id });
  await afterWrite(tenantId);
  return { ok:true };
}

async function list(tenantId){
  const all = await readAll(tenantId);
  return {
    pending: all.filter(p=>p.status!=='confirmed'),
    confirmed: all.filter(p=>p.status==='confirmed')
  };
}

// Mark reminder flag for idempotence
async function markReminderTomorrowSent(tenantId, id, dayKey){
  const all = await readAll(tenantId);
  const idx = all.findIndex(o=> String(o.id)===String(id));
  if(idx<0) return false;
  const key = dayKey || (new Date()).toISOString().slice(0,10);
  all[idx].reminders = all[idx].reminders || {};
  all[idx].reminders.tomorrowSentAt = key;
  all[idx].reminders.lastSentAt = Date.now();
  await saveAll(tenantId, all);
  await afterWrite(tenantId);
  return true;
}

// Helpers: find/delete pending by phone
function normalizePhone(s){
  const digits = String(s||'').replace(/\D/g,'');
  if(digits.length<=9) return digits;
  return digits.slice(-9);
}

async function findPendingByPhone(tenantId, phone){
  const needle = normalizePhone(phone);
  const all = await readAllFast(tenantId);
  // Permitir acciones sobre pedidos pendientes o confirmados
  return all.filter(o => ((o.status==='confirmed') || (o.status==='pending')) && normalizePhone(o?.customer?.phone || o?.fields?.telefono) === needle);
}

async function deletePendingByPhone(tenantId, phone){
  const needle = normalizePhone(phone);
  const all = await readAll(tenantId);
  // Solo eliminar pedidos confirmados asociados al teléfono
  const filtered = all.filter(o => !((o.status === 'confirmed') && normalizePhone(o?.customer?.phone || o?.fields?.telefono) === needle));
  if (filtered.length !== all.length){
    await saveAll(tenantId, filtered);
    await afterWrite(tenantId);
  }
  return { removed: all.length - filtered.length };
}

// Move many orders to canceled in a single write
async function moveToCanceled(tenantId, ids){
  const idSet = new Set((ids||[]).map(String));
  if(idSet.size===0) return { changed: 0 };
  const all = await readAll(tenantId);
  let changed = 0;
  const now = Date.now();
  for(const o of all){
    // Cancelar pedidos confirmados o pendientes
    if(idSet.has(String(o.id)) && o.status !== 'canceled'){
      o.status = 'canceled';
      o.canceledAt = now;
      changed++;
    }
  }
  if(changed>0){
    await saveAll(tenantId, all);
    // Emit per-order event for UI targeting and a global refresh
    try {
      const serverMod = require('../server');
      if(serverMod.io){
        for(const id of idSet){ serverMod.io.to(tenantId).emit('order:canceled', { id }); }
      }
      if(serverMod.pushEvent){
        for(const o of all){ if(idSet.has(String(o.id))) serverMod.pushEvent('order_canceled', { tenantId, order: o }); }
      }
    } catch {}
    await afterWrite(tenantId);
  }
  return { changed };
}

// Backwards compatibility helpers
async function add(tenantId, order){ return append(tenantId, order); }
async function listPending(tenantId){ return listByStatus(tenantId, 'pending'); }
async function listConfirmed(tenantId){ return listByStatus(tenantId, 'confirmed'); }
async function listCanceled(tenantId){ return listByStatus(tenantId, 'canceled'); }

module.exports = { readAll, readAllFast, saveAll, listByStatus, confirm, cancel, append, add, listPending, listConfirmed, listCanceled, remove, setIO, list, findPendingByPhone, deletePendingByPhone, calcTotal, moveToCanceled, afterWrite, markReminderTomorrowSent };

// --- Simple in-process reminder scheduler (best-effort) ---
async function scheduleReminder(tenantId, order){
  // Delegate to daily reminder service for idempotent handling; no per-order timers
  return; 
}

// --- Helpers for modify-order flow ---
function _normalizePhone9(s){ const d=String(s||'').replace(/\D/g,''); return d.slice(-9); }

async function findLatestByPhone(tenantId, phone){
  const needle = _normalizePhone9(phone);
  const all = await readAllFast(tenantId);
  const candidates = all.filter(o => o.status !== 'canceled' && _normalizePhone9(o?.customer?.phone || o?.fields?.telefono) === needle);
  if(candidates.length === 0) return null;
  // Prefer confirmed over pending; then most recent by createdAt
  candidates.sort((a,b)=>{
    const sa = (a.status==='confirmed') ? 1 : 0;
    const sb = (b.status==='confirmed') ? 1 : 0;
    if(sb!==sa) return sb-sa;
    const ta = Number(a.createdAt||0); const tb = Number(b.createdAt||0);
    return tb - ta;
  });
  return candidates[0];
}

async function updateAndResetPending(tenantId, id, update){
  const all = await readAll(tenantId);
  const idx = all.findIndex(o => String(o.id) === String(id));
  if(idx < 0) throw new Error(`Pedido ${id} no encontrado`);
  const now = Date.now();
  const prev = all[idx];
  const next = { ...prev };
  if(update.customer && update.customer.phone){ next.customer = { ...(next.customer||{}), phone: update.customer.phone }; }
  if(update.fields){ next.fields = { ...(next.fields||{}), ...update.fields }; }
  if(Array.isArray(update.items)) next.items = update.items;
  // Recompute total if not provided
  if(typeof update.total === 'number'){ next.total = update.total; }
  else if(Array.isArray(next.items)){
    next.total = next.items.reduce((acc,it)=> acc + (Number(it.total)||0), 0);
  }
  next.status = 'pending';
  delete next.confirmedAt;
  next.updatedAt = now;
  all[idx] = next;
  await saveAll(tenantId, all);
  try { if(_io) _io.to(tenantId).emit('order:changed', { id: next.id }); } catch{}
  await afterWrite(tenantId);
  // SSE event for UI refresh with full order
  try { const serverMod = require('../server'); if(serverMod.pushEvent) serverMod.pushEvent('order_changed', { tenantId, order: next }); } catch{}
  return next;
}

module.exports.findLatestByPhone = findLatestByPhone;
module.exports.updateAndResetPending = updateAndResetPending;

// Create a NEW order from an existing one (modification), canceling the old
// Returns the newly created order
async function cloneAsModifiedNew(tenantId, id, update={}){
  const all = await readAll(tenantId);
  const idx = all.findIndex(o => String(o.id) === String(id));
  if(idx < 0) throw new Error(`Pedido ${id} no encontrado`);
  const now = Date.now();
  const prev = all[idx];
  const base = { ...prev };
  const next = {
    id: nextId(all),
    status: 'pending',
    createdAt: now,
    customer: base.customer || {},
    fields: { ...(base.fields||{}) },
    items: Array.isArray(base.fields?.items) ? base.fields.items : (Array.isArray(base.items)? base.items : undefined),
    total: typeof base.total==='number' ? base.total : 0,
    modified: true,
    replaces: String(base.id)
  };
  if(update.customer && update.customer.phone){ next.customer = { ...(next.customer||{}), phone: update.customer.phone }; }
  if(update.fields){ next.fields = { ...(next.fields||{}), ...update.fields }; }
  if(Array.isArray(update.items)) next.items = update.items;
  if(typeof update.total === 'number'){
    next.total = update.total;
  } else if(Array.isArray(next.items)){
    next.total = next.items.reduce((acc,it)=> acc + (Number(it.total)||0), 0);
  }

  // Cancel original and link to new
  all[idx] = { ...prev, status: 'canceled', canceledAt: now, replacedBy: String(next.id) };
  all.push(next);
  await saveAll(tenantId, all);
  // Emit socket/io events and SSE
  try {
    if(_io){ _io.to(tenantId).emit('order:canceled', { id: prev.id }); _io.to(tenantId).emit('order:new', next); }
    const serverMod = require('../server');
    if(serverMod.pushEvent){
      serverMod.pushEvent('order_canceled', { tenantId, order: all[idx] });
      serverMod.pushEvent('order_created', { tenantId, order: next });
    }
  } catch{}
  await afterWrite(tenantId);
  try { scheduleReminder(tenantId, next).catch(()=>{}); } catch{}
  return next;
}

module.exports.cloneAsModifiedNew = cloneAsModifiedNew;