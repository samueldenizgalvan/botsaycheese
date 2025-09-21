require('dotenv').config();
// Zona horaria por defecto antes de usar fechas
process.env.TZ = process.env.TZ || 'Europe/Madrid';
const DISABLE_WA = /^(1|true|yes)$/i.test(String(process.env.DISABLE_WA||''));
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const http = require('http');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const authRequired = require('./middleware/authRequired');
const app = express();

// Middlewares principales (orden: parse -> compression -> cors -> static)
app.use(express.json());
app.use(express.urlencoded({ extended:true }));
// Cookies + Sesiones (global)
app.use(cookieParser());
app.use(session({
  name: 'sid',
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8 // 8h
  }
}));
// Evitar comprimir Server-Sent Events
app.use(compression({
  filter: (req,res)=>{
    const type = (res.getHeader && res.getHeader('Content-Type')) || '';
    if(/text\/event-stream/i.test(type)) return false;
    return compression.filter(req,res);
  }
}));
app.use(cors());

// Rutas rápidas de prueba
app.get('/health', (_,res)=> res.send('ok'));
app.get('/ping', (_,res)=> res.json({ pong:true, t:Date.now() }));

// Login abierto
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Servir index.html SOLO si está autenticado
app.get('/index.html', authRequired, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/', (req, res) => res.redirect('/index.html'));

// Archivos estáticos sólo bajo /public para evitar servir index.html sin auth
app.use('/public', express.static(path.join(__dirname,'public'), { maxAge:0, etag:false }));

// --- Server Sent Events simple bus ---
const clients = new Set();
app.get('/events', (req,res)=>{
  res.set({
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive'
  });
  // Evitar compresión explícita
  res.setHeader('Content-Encoding','identity');
  if(res.flushHeaders) res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.add(res);
  const ping = setInterval(()=>{
    try { res.write('event: ping\ndata: ok\n\n'); } catch { /* ignore */ }
  },25000);
  req.on('close', ()=>{ clearInterval(ping); clients.delete(res); });
});

function pushEvent(type,payload){
  const data = `event: ${type}\n`+`data: ${JSON.stringify(payload||{})}\n\n`;
  for(const c of clients){
    try { c.write(data); } catch { /* ignore */ }
  }
}

// Rutas
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);
app.use('/tenant', require('./routes/tenant'));
app.use('/records', require('./routes/records'));
app.use('/logs', require('./routes/logs'));
app.use('/messages', require('./routes/messages'));
// Proteger APIs
app.use('/api', authRequired);
// Bot router con contrato estable
app.use('/bot', authRequired, require('./routes/bot'));
app.use('/api/pedidos', require('./routes/pedidosRoutes'));
app.use('/api/pedidosq', require('./routes/pedidosQueryRoutes'));

// --- Pedidos API ---
const orderStore = require('./services/orderStore');
const { sendTomorrowReminders } = require('./services/reminderService');

function extractTenant(req){
  return String((req.query.tenant || req.body?.tenant || req.headers['x-tenant-id'] || '')).trim();
}

// Bot endpoints se manejan por routes/bot.js

app.get('/api/pedidos', async (req,res)=>{
  try {
    const tenant = extractTenant(req);
    if(!tenant) return res.status(400).json({ error:'tenant requerido'});
    const raw = await orderStore.readAllFast(tenant);
    const estado = String(req.query.estado||'').trim().toLowerCase();
    // Normalizar listado ligero: solo campos tabla
    const mapped = raw.map(p=>{
      const f = p.fields || {};
        // NUEVO: fallback de cantidad si no hay fields.cantidad usando porciones/unidades
        let cantidad = (f.cantidad != null && f.cantidad !== '') ? f.cantidad : null;
        if(cantidad == null){
          if(f.porciones != null && f.porciones !== '') cantidad = f.porciones;
          else if(f.unidades != null && f.unidades !== '') cantidad = f.unidades;
          else if(p.porciones != null && p.porciones !== '') cantidad = p.porciones; // fallback raíz legacy
        }
        // Regla específica: si tamano es 'porciones' y existe fields.porciones, usarlo siempre
        const tamanoNorm = (f.tamano || f.size || p.tamano || p.size || '').toLowerCase();
        if(tamanoNorm === 'porciones' && f.porciones != null && f.porciones !== ''){
          cantidad = f.porciones;
        }
        const items = Array.isArray(f.items) ? f.items : null;
        const total = (typeof p.total === 'number') ? p.total : (items ? items.reduce((acc, it)=> acc + (Number(it.total)||0), 0) : 0);
        return {
          id: p.id,
          createdAt: p.createdAt,
          canceledAt: p.canceledAt || null,
          phone: (p.customer && p.customer.phone) || f.telefono || '',
          nombre: '',
          fecha: f.fecha || p.fecha || '',
          tamano: f.tamano || f.size || p.tamano || p.size || '',
          sabores: Array.isArray(f.sabores)? f.sabores : (p.sabores || []),
          cantidad: (cantidad != null ? cantidad : ''),
          observacion: (f.observacion != null ? f.observacion : ''),
          status: p.status || 'pending',
          modified: Boolean(p.modified),
          replaces: p.replaces || null,
          replacedBy: p.replacedBy || null,
          items: items,
          total: total
        };
    });
    const filterStatus = (st)=> mapped.filter(o=> o.status === st);
    if(estado){
      if(['pendiente','pending'].includes(estado)) return res.json(filterStatus('pending'));
      if(['confirmado','confirmed'].includes(estado)) return res.json(filterStatus('confirmed'));
      if(['cancelado','canceled','cancelados'].includes(estado)) return res.json(filterStatus('canceled'));
      return res.status(400).json({ error:'estado inválido'});
    }
    return res.json({ pending: filterStatus('pending'), confirmed: filterStatus('confirmed'), canceled: filterStatus('canceled') });
  } catch(e){ console.error('GET /api/pedidos error', e); return res.status(500).json({ error:e.message }); }
});

app.post('/api/pedidos/:id/confirm', async (req,res)=>{
  try {
    const tenant = String(req.query.tenant||'').trim();
    if(!tenant) return res.status(400).json({ error:'tenant requerido'});
    const id = req.params.id;
    const order = await orderStore.confirm(tenant, id);
    if(!order) return res.status(404).json({ error:'no encontrado' });
    // Notificar por WhatsApp al cliente (best effort)
    try {
      const wa = require('./services/whatsappService');
      const phone = (order?.customer?.phone) || (order?.fields?.telefono) || '';
  const name  = '';
      if (phone) {
        const fecha = (order?.fields?.fecha) ? ` para el ${order.fields.fecha}` : '';
  const msg = `¡Hola! 🎉\nHemos confirmado tu pedido${fecha}. ✅\n Recuerda que los pagos son a la recogida en efectivo o tarjeta . Gracias por confiar en nosotros. 🧁🥳  .`;
        await wa.sendMessage(tenant, phone, msg).catch(()=>{});
      }
    } catch(e){ console.warn('[confirm notify] no WA message sent:', e.message); }
    return res.json({ ok:true, order });
  } catch(e){ console.error('POST /api/pedidos/:id/confirm error', e); return res.status(500).json({ error:e.message }); }
});

app.post('/api/pedidos/:id/cancel', async (req,res)=>{
  try {
    const tenant = String(req.query.tenant||'').trim();
    if(!tenant) return res.status(400).json({ error:'tenant requerido'});
    const id = req.params.id;
    const all = await orderStore.readAllFast(tenant);
    const target = all.find(o=> String(o.id)===String(id));
    if(!target) return res.status(404).json({ ok:false, error:'no encontrado' });
    const status = String(target.status||'').toLowerCase();
    if(status==='canceled') return res.status(400).json({ ok:false, error:'ya_cancelado' });
    if(!['pending','confirmed'].includes(status)) return res.status(400).json({ ok:false, error:'estado_no_cancelable' });
    // Mensaje admin personalizado (solo si pending o confirmed y se solicita cancelar)
    const adminCancelMsg = 'Hola 😊, sentimos decirte que el día elegido ya está completo 📅❌.\nEscribe menú 📲 para ver otras fechas y con todo el cariño haremos tu Cheesecake 🧀🍰.';
    const phone = (target?.customer?.phone) || (target?.fields?.telefono) || '';
    const wa = (()=>{ try { return require('./services/whatsappService'); } catch { return null; } })();
    if(status==='pending'){
      // Borrado duro: eliminar de pedidos.json
      try { await orderStore.remove(tenant, id); } catch(e){ return res.status(500).json({ ok:false, error:'remove_failed' }); }
      // Intentar enviar mensaje
      if(phone && wa){ try { await wa.sendMessage(tenant, phone, adminCancelMsg); } catch{} }
      return res.json({ ok:true, removed:true });
    } else {
      // confirmed -> marcar cancelado y notificar
      let order = null;
      try { order = await orderStore.cancel(tenant, id); } catch(e){ order = null; }
      if(!order) return res.status(500).json({ ok:false, error:'cancel_failed' });
      if(phone && wa){ try { await wa.sendMessage(tenant, phone, adminCancelMsg); } catch{} }
      return res.json({ ok:true, order });
    }
  } catch(e){ console.error('POST /api/pedidos/:id/cancel error', e); return res.status(500).json({ ok:false, error:e.message }); }
});

app.delete('/api/pedidos/:id', async (req,res)=>{
  try {
    const tenant = String(req.query.tenant||'').trim();
    if(!tenant) return res.status(400).json({ error:'tenant requerido'});
    const id = req.params.id;
    const r = await orderStore.remove(tenant, id);
    if(!r.ok) return res.status(404).json({ error:'no encontrado' });
    return res.json({ ok:true });
  } catch(e){ console.error('DELETE /api/pedidos/:id error', e); return res.status(500).json({ error:e.message }); }
});

// --- Bot relink endpoint (non-bloqueante) ---
app.post('/api/bot/relink', async (req, res) => {
  try {
    const tenant = String(req.query.tenant || req.body?.tenant || '').trim();
    if(!tenant) return res.status(400).json({ error:'tenant requerido' });
    // Disparar relink en background; QR llegará por SSE
    const waSvc = require('./services/whatsappService');
    (async ()=>{ try { await waSvc.relinkTenant(tenant); } catch(e){ console.error('[relink] error', e); } })();
    return res.status(202).json({ status: 'relinking' });
  } catch(e){
    console.error('[POST /api/bot/relink] error', e);
    return res.status(500).json({ error: e.message });
  }
});

// (health ya definido arriba)

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// HTTP server y Socket.io con rooms por tenant
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*'} });
app.set('io', io);
require('./services/orderStore').setIO(io);
io.on('connection', socket => {
  const tenant = (socket.handshake.query && socket.handshake.query.tenant) || 'samuel';
  socket.join(tenant);
});

const PORT = Number(process.env.PORT || 3000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`El puerto ${PORT} ya está en uso. Libéralo o cambia PORT en .env.`);
  } else {
    console.error('Error del servidor:', err);
  }
  // Eliminado process.exit para depurar.
});

// Log básico de cada request (se puede desactivar luego)
app.use((req,res,next)=>{ console.log('[REQ]', req.method, req.url); next(); });

async function initHttp(){
  await new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`Servidor escuchando en puerto ${PORT}`);
      resolve();
    });
  });
}

// Global error handlers
process.on('unhandledRejection', (e) => {
  try {
    const msg = (e && (e.message || String(e))) || '';
    if (/Execution context was destroyed/i.test(msg)) {
      console.warn('[UNHANDLED][WA] Navegación de Puppeteer (benigno). Continuando…');
      return;
    }
  } catch {}
  console.error('[UNHANDLED]', e);
});
process.on('uncaughtException', (e) => {
  try {
    const msg = (e && (e.message || String(e))) || '';
    if (/Execution context was destroyed/i.test(msg)) {
      console.warn('[UNCAUGHT][WA] Navegación de Puppeteer (benigno).');
      return;
    }
  } catch {}
  console.error('[UNCAUGHT]', e);
});

// Eliminado heartbeat para no saturar logs

// Graceful shutdown: destroy clients but preserve sessions
const { destroyAllClients } = require('./services/botService');
// --- WhatsApp bot single client wiring ---
const { attachBotHandlers, setServerManagedWA, setServerReinitializer, registerServerClient, publishQr, publishAuthenticated, publishReady, publishStatus } = require('./services/whatsappService');
const { manejarMensajeTenant } = require('./services/botService');
let waClient = null;
let waInitAttempts = 0;
const MAX_WA_ATTEMPTS = 3;
async function initWA(){
  waInitAttempts += 1;
  const attempt = waInitAttempts;
  try {
    console.log(`[WA] init attempt ${attempt}`);
    const { Client, LocalAuth } = require('whatsapp-web.js');
    const AUTH_DIR = path.join(process.cwd(), 'data', '.wwebjs_auth');
    try { require('fs').mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
    if(waClient){ try { waClient.destroy(); } catch {} waClient = null; }
    waClient = new Client({
      authStrategy: new LocalAuth({ clientId: 'default', dataPath: AUTH_DIR }),
      puppeteer: {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-domain-reliability',
          '--disable-extensions',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-popup-blocking',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--force-color-profile=srgb',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--password-store=basic',
          '--use-mock-keychain'
        ]
      }
    });
    const manejar = (client, msg) => manejarMensajeTenant('samuel', client, msg);
    setServerManagedWA(true);
    try { registerServerClient('samuel', waClient); } catch {}
    let readyTimeout = setTimeout(()=>{
      console.warn('[WA] ready not emitted within 40s');
    }, 40000);
    waClient.on('qr', async (qr) => { try { console.log('[bot] qr received'); await publishQr('samuel', qr); } catch {} });
    waClient.on('authenticated', () => { try { publishAuthenticated('samuel'); } catch {} });
    waClient.on('auth_failure', (msg) => { try { publishStatus('samuel', 'error', { msg }); } catch {} });
    waClient.on('disconnected', async (reason) => {
      try { publishStatus('samuel', 'disconnected', { reason }); } catch {}
      console.warn('[WA] disconnected', reason);
      if(waInitAttempts < MAX_WA_ATTEMPTS){
        const delay = 5000 * waInitAttempts;
        console.log(`[WA] retrying init in ${delay}ms`);
        setTimeout(()=>{ initWA().catch(()=>{}); }, delay);
      }
    });
    waClient.once('ready', () => {
      clearTimeout(readyTimeout);
      console.log('[bot] ready');
      waInitAttempts = 0; // reset attempts after success
      try { publishReady('samuel'); } catch {}
      try { waClient._externalHandlersManaged = true; } catch {}
      attachBotHandlers(waClient, manejar);
    });
    waClient.initialize();
  } catch(e){
    console.error('[server] whatsapp-web.js unavailable:', e.message);
    if(waInitAttempts < MAX_WA_ATTEMPTS){
      const delay = 5000 * waInitAttempts;
      console.log(`[WA] will retry in ${delay}ms`);
      setTimeout(()=>{ initWA().catch(()=>{}); }, delay);
    }
  }
}
// Provide reinitializer to whatsappService for /bot/relink to work in server-managed mode
setServerReinitializer(async () => { await initWA(); });
process.on('SIGINT', async () => {
  try { await destroyAllClients(); } catch {}
  process.exit(0);
});

module.exports = { app, io, pushEvent };

// --- Daily reminder job at 09:00 Europe/Madrid ---
function startDailyReminderJob(){
  let lastRunDate = null;
  setInterval(async () => {
    try {
      const now = new Date();
      const isNineAm = now.getHours() === 9 && now.getMinutes() === 0;
      const todayKey = now.toISOString().slice(0,10); // YYYY-MM-DD
      if (isNineAm && lastRunDate !== todayKey) {
        lastRunDate = todayKey;
        await sendTomorrowReminders('samuel');
        console.log('[reminder] run ok', new Date().toISOString());
      }
    } catch (err) {
      console.error('[reminder] error', err);
    }
  }, 60*1000);
}
async function bootstrap(){
  await initHttp();
  startDailyReminderJob();
  if (!DISABLE_WA) {
    await initWA();
  } else {
    console.log('[server] DISABLE_WA=1 → bot de WhatsApp deshabilitado (solo panel).');
  }
}
bootstrap().catch(err=>{
  console.error('[FATAL]', err);
  process.exit(1);
});

// Manual trigger for testing
app.post('/admin/run-reminders', async (req, res) => {
  try {
    await sendTomorrowReminders('samuel');
    res.json({ ok:true });
  } catch(e){
    console.error('[reminder] manual error', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});
