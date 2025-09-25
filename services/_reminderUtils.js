/**
 * Internal utilities for reminder scheduling and formatting.
 * Pure functions only. No side effects, no I/O.
 *
 * @module reminderUtils
 */

/**
 * Return a copy of the date at 00:00:00.000 local time.
 * @param {Date|string|number} d - Any date-like input
 * @returns {Date}
 * @example
 * atStartOfDay(new Date('2025-09-16T13:45:00Z')) // -> local midnight
 */
function atStartOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }

/**
 * Parse a flexible date in DD-MM, DD/MM, or DD-MM-YYYY.
 * If DD-MM is clearly in the past year end, roll to next year.
 * @param {string} s
 * @returns {Date|null}
 * @example
 * parseDDMMYYYY('25-12-2025') instanceof Date // true
 * parseDDMMYYYY('01/01') instanceof Date // true
 */
function parseDDMMYYYY(s){
  if (!s) return null;
  const norm = String(s).trim().replace(/[\/]/g, '-');
  const parts = norm.split('-').filter(Boolean);
  const today = atStartOfDay(new Date());
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
    if (diffDays(d, today) < -200) {
      d = new Date(today.getFullYear()+1, (mm||1)-1, dd||1);
    }
    return d;
  }
  return null;
}

/**
 * True if the given date is exactly tomorrow (local time).
 * @param {Date} date
 * @returns {boolean}
 */
function isTomorrow(date){
  const today = atStartOfDay(new Date());
  const target = atStartOfDay(date);
  const diff = Math.round((target - today) / 86400000);
  return diff === 1;
}

/**
 * Today key as YYYY-MM-DD.
 * @returns {string}
 */
function todayKey(){ const d = atStartOfDay(new Date()); const pad=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

/**
 * Normalize a phone number to a WhatsApp JID (default ES country if 9 digits).
 * @param {string} phone
 * @returns {string|null}
 * @example
 * normalizePhoneToJid('657826485') // '34657826485@c.us'
 */
function normalizePhoneToJid(phone){
  const digitsRaw = String(phone || '').replace(/\D/g, '');
  if (!digitsRaw) return null;
  const digits = digitsRaw.length === 9 ? ('34' + digitsRaw) : digitsRaw;
  return `${digits}@c.us`;
}

/**
 * Calculate total from config prices, size and quantity.
 * @param {object} cfg - Config object with options.precios
 * @param {string} tamano - Size key (e.g., 'grande')
 * @param {number|string} cantidad - Quantity
 * @returns {number}
 */
function calcTotal(cfg, tamano, cantidad){
  const precios = cfg?.options?.precios || {};
  const p = precios[tamano] || 0;
  return Math.round((p * (Number(cantidad)||0)) * 100) / 100;
}

/**
 * Build the reminder message text. Preserves exact line breaks/spaces.
 * @param {object} cfg
 * @param {object} order
 * @returns {string}
 */
function buildReminderText(cfg, order){
  const tamano   = order?.fields?.tamano;
  const sabores  = (order?.fields?.sabores || []).join(', ');
  const cantidad = order?.fields?.cantidad || order?.fields?.porciones || order?.fields?.unidades || 1;
  const fecha    = order?.fields?.fecha;
  const total    = order?.total || calcTotal(cfg, tamano, cantidad);
  const brand    = (cfg && (cfg.brand || cfg.displayName)) || 'SayCheese By Nestor';
  // Mensaje sin saludo inicial para evitar parecer bienvenida; solo recordatorio directo
  return `Recordatorio de tu pedido para *mañana* (${fecha}) en *${brand}*:\n\n• Tamaño: *${tamano}*\n• Cantidad: *${cantidad}*\n• Sabores: *${sabores || '—'}*\n• Total aprox: *${total}€*\n\n📍 C. Abián, 4, 35212 Marpequeña, Las Palmas.`;
}

const api = {
  atStartOfDay,
  parseDDMMYYYY,
  isTomorrow,
  todayKey,
  normalizePhoneToJid,
  calcTotal,
  buildReminderText,
};
module.exports = api;
module.exports.default = api;
