// services/whatsappService.js
// Manages WA clients per tenant, QR cache, and provides a simple event bus per tenant.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const botService = require('./botService');
let WA = null;
function ensureWA(){
  if(!WA){
    try { WA = require('whatsapp-web.js'); }
    catch(e){ console.error('[whatsappService] whatsapp-web.js missing:', e.message); }
  }
  return WA;
}
const QRCode = require('qrcode');

// In-memory stores
const clients = new Map(); // tenantId -> Client
// statusMap per prompt: 'initializing'|'waiting_qr'|'authenticated'|'ready'|'disconnected'|'error'
const statusMap = new Map();
const lastQrMap = new Map(); // tenant -> dataURL (png)
const buses = new Map(); // tenant -> EventEmitter
const handlersAttached = new Set(); // tenantId where handlers are attached
// Global guard for simple handler attachment API
const GLOBAL_HANDLER_KEY = '__global__';
// Global dedup for attachBotHandlers
const seen = new Set();
setInterval(() => { try { seen.clear(); } catch {} }, 60_000);
// Deduplication cache for incoming messages
const seenByTenant = new Map(); // tenantId -> Map<msgId, ts>
const MSG_TTL_MS = 5 * 60 * 1000; // 5 minutes
function shouldProcess(tenantId, msg){
  try {
    const id = (msg && msg.id && (msg.id.id || msg.id._serialized)) || msg._serialized || String(msg.timestamp||'')+':'+String(msg.from||'');
    if(!id) return true;
    let bucket = seenByTenant.get(tenantId);
    const now = Date.now();
    if(!bucket){ bucket = new Map(); seenByTenant.set(tenantId, bucket); }
    // periodic cleanup
    if(bucket._lastCleanupAt == null || (now - bucket._lastCleanupAt) > 60_000){
      for(const [k,ts] of bucket.entries()){ if((now - ts) > MSG_TTL_MS) bucket.delete(k); }
      bucket._lastCleanupAt = now;
    }
    if(bucket.has(id)) return false;
    bucket.set(id, now);
    return true;
  } catch { return true; }
}

function getEventBus(tenantId){
  if(!buses.has(tenantId)) buses.set(tenantId, new EventEmitter());
  return buses.get(tenantId);
}

function setState(tenantId, state){ statusMap.set(tenantId, state); }

async function setLastQr(tenantId, qr){
  try {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
    lastQrMap.set(tenantId, dataUrl);
  } catch{
    lastQrMap.set(tenantId, null);
  }
}

function getBasePath(tenantId){
  return path.join(__dirname, '..', 'data', tenantId);
}

// Unified persistent LocalAuth directory (shared with botService)
const AUTH_DIR = path.join(process.cwd(), 'data', '.wwebjs_auth');
try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}

// If true, an external module (server.js) manages the single WA client lifecycle.
let SERVER_MANAGED = false;
function setServerManagedWA(flag){ SERVER_MANAGED = !!flag; }
let serverReinitializer = null;
function setServerReinitializer(fn){ serverReinitializer = typeof fn === 'function' ? fn : null; }

// Register externally-created WA client for a tenant (server-managed mode)
function registerServerClient(tenantId, client){
  try { if(client) clients.set(tenantId, client); } catch {}
  // Do not change status here; lifecycle events will publish via publish* helpers
  return true;
}

// Allow server-managed client to publish lifecycle/QR events into this service so routes keep working
async function publishQr(tenantId, qr){
  try { await setLastQr(tenantId, qr); } catch {}
  try { setState(tenantId, 'waiting_qr'); } catch {}
  try { const bus = getEventBus(tenantId); bus.emit('qr'); bus.emit('status', { status:'waiting_qr' }); } catch {}
}
function publishAuthenticated(tenantId){
  try { lastQrMap.delete(tenantId); } catch {}
  try { setState(tenantId, 'authenticated'); } catch {}
  try { const bus = getEventBus(tenantId); bus.emit('authenticated'); bus.emit('status', { status:'authenticated' }); } catch {}
}
function publishReady(tenantId){
  try { lastQrMap.delete(tenantId); } catch {}
  try { setState(tenantId, 'ready'); } catch {}
  try { const bus = getEventBus(tenantId); bus.emit('ready'); bus.emit('status', { status:'ready' }); } catch {}
}
function publishStatus(tenantId, status, extra={}){
  try { setState(tenantId, status); } catch {}
  try { const bus = getEventBus(tenantId); bus.emit('status', { status, ...extra }); } catch {}
}

async function createClientForTenant(tenantId){
  if(SERVER_MANAGED){
    // In server-managed mode, don't create new clients here.
    return clients.get(tenantId) || null;
  }
  const lib = ensureWA();
  if(!lib || !lib.Client || !lib.LocalAuth) throw new Error('whatsapp-web.js no disponible');
  const toClientId = (id)=>{
    const s = String(id||'').trim().replace(/[^A-Za-z0-9_-]/g,'_');
    return s || 'default';
  };
  const clientId = toClientId(tenantId);
  const client = new lib.Client({ authStrategy: new lib.LocalAuth({ clientId, dataPath: AUTH_DIR }), puppeteer:{ headless:true } });

  // Wire events
  const bus = getEventBus(tenantId);
  client.on('qr', async (qr)=>{ console.log(`[${tenantId}] [WA] qr`); await setLastQr(tenantId, qr); setState(tenantId,'waiting_qr'); try{ bus.emit('qr'); bus.emit('status',{ status:'waiting_qr' }); }catch{} });
  client.on('authenticated', ()=>{ console.log(`[${tenantId}] [WA] authenticated`); lastQrMap.delete(tenantId); setState(tenantId,'authenticated'); try{ bus.emit('authenticated'); bus.emit('status',{ status:'authenticated' }); }catch{} });
  client.on('ready', ()=>{ console.log(`[${tenantId}] [WA] ready`); lastQrMap.delete(tenantId); setState(tenantId,'ready'); try{ bus.emit('ready'); bus.emit('status',{ status:'ready' }); }catch{}; attachCoreHandlers(tenantId, client); });
  client.on('disconnected', reason=>{ console.warn(`[${tenantId}] [WA] disconnected: ${reason||''}`); setState(tenantId,'disconnected'); clients.delete(tenantId); try{ bus.emit('status', { status:'disconnected', reason }); }catch{} });
  client.on('auth_failure', msg=>{ console.error(`[${tenantId}] [WA] auth_failure: ${msg||''}`); setState(tenantId,'error'); clients.delete(tenantId); try{ bus.emit('status', { status:'error', msg }); }catch{} });

  clients.set(tenantId, client);
  setState(tenantId,'initializing');
  // fire initialize but don't await (non-blocking caller may proceed)
  client.initialize().catch(e=>{ setState(tenantId,'error'); console.error(`[${tenantId}] initialize error`, e); try{ bus.emit('status', { status:'error', error:e.message }); }catch{} });
  return client;
}

function get(tenantId){
  const client = clients.get(tenantId);
  return client ? { client, tenantId } : null;
}

async function ensureStarted(tenantId){
  if(SERVER_MANAGED) return true; // server creates and initializes the single client
  if(clients.has(tenantId)) return true;
  await createClientForTenant(tenantId);
  return true;
}

async function ensure(tenantId, opts={}){
  if(opts.forceRelink){ await relinkFresh(tenantId); return get(tenantId); }
  await ensureStarted(tenantId);
  return get(tenantId);
}

function getLastQr(tenantId){
  return lastQrMap.get(tenantId) || null;
}

async function relinkTenant(tenantId){
  return relinkFresh(tenantId);
}

function getClientStateForTenant(tenantId){
  return statusMap.get(tenantId) || 'disconnected';
}

function getStatus(tenantId){
  return statusMap.get(tenantId) || 'unknown';
}

// Destructive fresh relink (stop + delete session + start) - only called on explicit relink
async function relinkFresh(tenantId){
  const existing = clients.get(tenantId);
  if(existing){
    try { existing.removeAllListeners && existing.removeAllListeners(); } catch{}
    try { setState(tenantId,'initializing'); } catch{}
    try { await existing.destroy(); } catch{}
    clients.delete(tenantId);
  }
  // Remove only the unified LocalAuth session directory for this tenant
  // whatsapp-web.js LocalAuth uses folder name pattern: "session-<clientId>"
  const toClientId = (id)=> String(id||'').trim().replace(/[^A-Za-z0-9_-]/g,'_') || 'default';
  const cid = toClientId(tenantId);
  // consider both sanitized and legacy names
  const candidates = [
    path.join(AUTH_DIR, `session-${cid}`),
    path.join(AUTH_DIR, `session-${tenantId}`),
    path.join(AUTH_DIR, cid),
    path.join(AUTH_DIR, tenantId)
  ];
  // In server-managed single-client mode we may have used 'default' as clientId
  if(SERVER_MANAGED){
    candidates.push(
      path.join(AUTH_DIR, 'session-default'),
      path.join(AUTH_DIR, 'default')
    );
  }
  // Optional backup under tenant data dir
  const base = getBasePath(tenantId);
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const backupRoot = path.join(base, `backup-${ts}`);
  try { await fs.promises.mkdir(backupRoot, { recursive:true }); } catch{}
  try {
    for(const sessionDir of candidates){
      try {
        const st = await fs.promises.stat(sessionDir).catch(()=>null);
        if(!st) continue;
        const dst = path.join(backupRoot, path.basename(sessionDir));
        try { await fs.promises.rename(sessionDir, dst); } catch{ /* ignore rename failures */ }
        try { await fs.promises.rm(sessionDir, { recursive:true, force:true }); } catch{}
      } catch{}
    }
  } catch{}
  // Reset caches and bus/listeners
  lastQrMap.delete(tenantId);
  statusMap.delete(tenantId);
  handlersAttached.delete(tenantId);
  buses.set(tenantId, new EventEmitter());
  if(SERVER_MANAGED){
    // Let server recreate and initialize the single client
    if(serverReinitializer){ try { await serverReinitializer(tenantId); } catch(e){ console.error('[whatsappService] serverReinitializer error', e); } }
  } else {
    // Create fresh client and initialize (non-blocking)
    await createClientForTenant(tenantId);
  }
  return true;
}

// Core message handlers, idempotent per tenant
function attachCoreHandlers(tenantId, client){
  if(handlersAttached.has(tenantId)) return;
  // Optional: prevent duplicate listeners from prior client instance
  // We don't remove all listeners globally to keep lifecycle events; only attach message family
  try {
  // Ensure we start clean for 'message' without touching lifecycle listeners
  try { client.removeAllListeners('message'); } catch {}
  client.on('message', async (msg) => {
      try {
        if(msg.fromMe) return;
        const isGroup = msg.from?.endsWith('@g.us') || msg.author?.endsWith?.('@g.us');
        if(isGroup) return;
  if(!shouldProcess(tenantId, msg)) return;
    const text = (msg.body||'').toString();
        console.log(`[${tenantId}] IN ${msg.from}: ${text}`);
        const st = statusMap.get(tenantId);
        if(st !== 'ready') console.warn(`[${tenantId}] message received while status=${st}`);
    const reply = await botService.manejarMensajeTenant(tenantId, client, msg);
        if(reply){
          await client.sendMessage(msg.from, String(reply));
          console.log(`[${tenantId}] OUT ${msg.from}: ${String(reply).slice(0,200)}`);
        }
      } catch(e){ console.error(`[${tenantId}] message error`, e); }
    });
    client.on('message_ack', (msg, ack) => {
      try { console.log(`[${tenantId}] ACK ${msg.id?.id||''}: ${ack}`); } catch {}
    });
  } catch(e){ console.error(`[${tenantId}] attachCoreHandlers error`, e); }
  handlersAttached.add(tenantId);
  console.log(`[${tenantId}] handlers attached`);
}

// Start/Stop helpers for tenant client
async function stopTenant(tenantId){
  try {
    const c = clients.get(tenantId);
    if(c){
      try { c.removeAllListeners && c.removeAllListeners(); } catch{}
      try { await c.destroy(); } catch{}
      clients.delete(tenantId);
    }
    setState(tenantId, 'disconnected');
    try { const bus = getEventBus(tenantId); bus.emit('status', { status:'disconnected' }); } catch{}
    lastQrMap.delete(tenantId);
    handlersAttached.delete(tenantId);
    return true;
  } catch(e){
    console.error('[whatsappService.stopTenant]', e);
    throw e;
  }
}

async function startTenant(tenantId){
  if(SERVER_MANAGED){
    if(serverReinitializer){ await serverReinitializer(tenantId); return true; }
    // If no reinitializer, assume already managed/started
    return true;
  }
  await ensureStarted(tenantId);
  return true;
}

module.exports = { get, ensure, getLastQr, relinkTenant, getClientStateForTenant, ensureStarted, relinkFresh, getEventBus, getStatus, setServerManagedWA, setServerReinitializer, registerServerClient, publishQr, publishAuthenticated, publishReady, publishStatus, stopTenant, startTenant };

// Lightweight wrapper to send a message using the tenant-specific client
function normalizeToJid(jid){
  const raw = String(jid||'');
  if(/@c\.us$/.test(raw)) return raw;
  let digits = raw.replace(/\D/g,'');
  // Default country code ES (34) if 9-digit local number
  if(digits.length===9) digits = '34' + digits;
  return `${digits}@c.us`;
}

async function sendMessage(tenantId, jid, text){
  const to = normalizeToJid(jid);
  await ensureStarted(tenantId);
  const ctx = get(tenantId);
  if(!ctx || !ctx.client) throw new Error('WA client not started');
  try {
    const preview = String(text||'').slice(0, 120).replace(/\s+/g,' ').trim();
    console.log(`[WA][sendMessage] tenant=${tenantId} to=${to} preview="${preview}"`);
  } catch {}
  return ctx.client.sendMessage(to, text);
}

module.exports.sendMessage = sendMessage;

// Simple, idempotent handler attachment for external bots
function attachBotHandlers(client, manejarMensajeTenant){
  try {
    if (client.__boundMessageHandler) {
      console.log('[WA] message handler already bound');
      return;
    }
    client.removeAllListeners('message');
    client.on('message', async (msg) => {
      try {
        if (!msg || msg.fromMe) return;
        // Ignore groups and status broadcasts: only respond to private chats (@c.us)
        const from = String(msg.from||'');
        const author = String(msg.author||'');
        const isGroup = /@g\.us$/.test(from) || /@g\.us$/.test(author);
        const isStatus = from === 'status@broadcast';
        const isPrivate = /@c\.us$/.test(from);
        if (isGroup || isStatus || !isPrivate) return;
        const id = msg?.id?._serialized;
        if (id) { if (seen.has(id)) return; seen.add(id); }
  // Call provided handler; server.js already binds tenant when needed
  const reply = await manejarMensajeTenant(client, msg);
        if (typeof reply === 'string' && reply.trim()) {
          await client.sendMessage(msg.from, String(reply));
          console.log(`[WA] OUT ${msg.from}: ${String(reply).slice(0,200)}`);
        }
      } catch (e) { console.error('[whatsappService] message handler error:', e); }
    });
    client.__boundMessageHandler = true;
    console.log('[WA] message handler bound');
  } catch (e) { console.error('[whatsappService] attachBotHandlers setup error:', e); }
}

module.exports.attachBotHandlers = attachBotHandlers;