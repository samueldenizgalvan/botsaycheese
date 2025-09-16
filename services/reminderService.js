// services per spec
const { getConfigForTenant } = (()=>{ try { return require('./configService'); } catch { return {}; } })();
const store = require('./orderStore');
const wa = (()=>{ try { return require('./whatsappService'); } catch { return null; } })();

// Utilidades fecha
function parseDDMMYYYY(s) {
  if (!s) return null;
  const norm = String(s).trim().replace(/[\/]/g, '-');
  const parts = norm.split('-').filter(Boolean);
  const today = atStartOfDay(new Date());
  const pad = (n)=>String(n).padStart(2,'0');
  const diffDays = (a,b)=> Math.round((atStartOfDay(a) - atStartOfDay(b)) / 86400000);
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts.map(Number);
    const d = new Date(yyyy, (mm||1)-1, dd||1);
    return isNaN(d) ? null : d;
  }
  if (parts.length === 2) {
    const [dd, mm] = parts.map(Number);
    let d = new Date(today.getFullYear(), (mm||1)-1, dd||1);
    if (isNaN(d)) return null;
    // If date seems far in the past (e.g., 01-01 while today is 31-12), roll to next year
    if (diffDays(d, today) < -200) {
      d = new Date(today.getFullYear()+1, (mm||1)-1, dd||1);
    }
    return d;
  }
  return null;
}
function atStartOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function isTomorrow(date) {
  const today = atStartOfDay(new Date());
  const target = atStartOfDay(date);
  const diff = Math.round((target - today) / 86400000);
  return diff === 1;
}
function todayKey() { const d = atStartOfDay(new Date()); const pad=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

function normalizePhoneToJid(phone) {
  const digitsRaw = String(phone || '').replace(/\D/g, '');
  if (!digitsRaw) return null;
  // Default to Spain country code if a 9-digit local number is provided
  const digits = digitsRaw.length === 9 ? ('34' + digitsRaw) : digitsRaw;
  return `${digits}@c.us`;
}

function calcTotal(cfg, tamano, cantidad) {
  const precios = cfg?.options?.precios || {};
  const p = precios[tamano] || 0;
  return Math.round((p * (Number(cantidad)||0)) * 100) / 100;
}

// Construye el texto dulce
function buildReminderText(cfg, order) {
  const nombre  = '';
  const tamano  = order?.fields?.tamano;
  const sabores = (order?.fields?.sabores || []).join(', ');
  const cantidad= order?.fields?.cantidad || order?.fields?.porciones || order?.fields?.unidades || 1;
  const fecha   = order?.fields?.fecha;
  const total   = order?.total || calcTotal(cfg, tamano, cantidad);
  return `¡Hola! 😊
Te recordamos tu pedido para *mañana* (${fecha}) en *SayCheese By Nestor*.

• Tamaño: *${tamano}*
• Cantidad: *${cantidad}*
• Sabores: *${sabores || '—'}*
• Total aprox: *${total}€*

📍 C. Abián, 4, 35212 Marpequeña, Las Palmas
🕒 Recogida 11:00–13:00
Si necesitas cambiar algo, respóndeme por aquí.
¡Gracias por elegirnos! 🧀💛`;
}

async function sendTomorrowReminders(tenantId) {
  // Config: prefer configService, fallback to file
  let cfg = null;
  try { cfg = (typeof getConfigForTenant === 'function') ? (await getConfigForTenant(tenantId)) : null; } catch {}
  if(!cfg){
    try { cfg = require(`../data/${tenantId}/config.json`); } catch { cfg = {}; }
  }

  // 1) Obtener confirmados
  const all = await store.listConfirmed(tenantId);
  const due = [];
  const today = todayKey();

  for (const o of all) {
  if (o.status !== 'confirmed') continue;
    // saltar si ya recordado hoy (idempotencia por fecha)
    const already = o?.reminders?.tomorrowSentAt;
    if (already === today) continue;

    const fecha = parseDDMMYYYY(o?.fields?.fecha);
    if (!fecha) continue;
    if (!isTomorrow(fecha)) continue;

    // validar teléfono
    const phone = o?.customer?.phone || o?.fields?.telefono;
    const jid = normalizePhoneToJid(phone);
    if (!jid) continue;

    // Ensure total if missing
    try {
      if(!(Number.isFinite(o.total) && o.total>0)){
        const tam = o?.fields?.tamano;
        const qty = o?.fields?.cantidad || o?.fields?.porciones || o?.fields?.unidades || 1;
        o.total = calcTotal(cfg, tam, qty);
      }
    } catch {}

    due.push({ order: o, jid });
  }

  // 2) Enviar y marcar
  for (const {order, jid} of due) {
    try {
      const txt = buildReminderText(cfg, order);
      if(wa && typeof wa.sendMessage === 'function'){
        await wa.sendMessage(tenantId, jid, txt);
      } else {
        // fallback: use botService directly to avoid missing wrapper
        const { send } = require('./botService');
        await send(tenantId, jid, txt);
      }
      await store.markReminderTomorrowSent(tenantId, order.id, today);
      console.log('[reminder] sent', tenantId, order.id, jid);
    } catch (e) {
      console.error('[reminder] send error', order.id, e);
    }
  }
}

module.exports = { sendTomorrowReminders };
