// services per spec
const { getConfigForTenant } = (()=>{ try { return require('./configService'); } catch { return {}; } })();
const store = require('./orderStore');
const wa = (()=>{ try { return require('./whatsappService'); } catch { return null; } })();
const {
  atStartOfDay,
  parseDDMMYYYY,
  isTomorrow,
  todayKey,
  normalizePhoneToJid,
  calcTotal,
  buildReminderText,
} = require('./_reminderUtils');

/**
 * Send WhatsApp reminders for orders scheduled for tomorrow.
 * Keeps exact user-facing strings. No behavior change.
 * @param {string} tenantId
 * @returns {Promise<void>}
 */
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
