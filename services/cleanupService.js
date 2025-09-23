const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Paths
const DATA_ROOT = path.join(__dirname, '..', 'data', 'samuel');
const PEDIDOS_FILE = path.join(DATA_ROOT, 'pedidos.json');
const BACKUP_DIR = path.join(DATA_ROOT, 'backups-auto');
const HISTORY_DIR = path.join(DATA_ROOT, 'history');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function parseFecha(fechaStr) {
  if (!fechaStr) return null;
  // soporta DD-MM o DD/MM opcional año
  const m = fechaStr.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/]?(\d{2,4}))?$/);
  if (!m) return null;
  let [_, d, M, y] = m;
  const year = y ? (y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10)) : new Date().getFullYear();
  const month = parseInt(M, 10) - 1;
  const day = parseInt(d, 10);
  const dt = new Date(year, month, day);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

function midnight(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  return d;
}

function loadPedidos() {
  if (!fs.existsSync(PEDIDOS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8'));
  } catch (e) {
    console.error('[cleanup] Error leyendo pedidos.json', e);
    return [];
  }
}

function savePedidos(pedidos) {
  fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2), 'utf8');
}

function backupPedidos(pedidos) {
  ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `pedidos.backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(pedidos, null, 2), 'utf8');
  return file;
}

function isExpired(pedido, todayMid) {
  const fecha = pedido?.fields?.fecha;
  const dt = parseFecha(fecha);
  if (!dt) return false; // si no se puede parsear, no lo borramos por seguridad
  return midnight(dt) < todayMid;
}

function cleanupOnce() {
  const all = loadPedidos();
  const todayMid = midnight(new Date());
  const kept = []; const removed = [];
  for (const p of all) {
    if (isExpired(p, todayMid)) removed.push(p); else kept.push(p);
  }
  if (removed.length === 0) {
    console.log(`[cleanup] Nada que eliminar. Pedidos actuales: ${all.length}`);
    return { removed: 0, kept: all.length, backup: null };
  }
  // Persistir histórico mensual (solo confirmados) antes de eliminar
  try {
    ensureDir(HISTORY_DIR);
    // agrupar por YYYY-MM derivado de fecha (si no se puede parsear, ignorar)
    const buckets = {};
    for (const r of removed) {
      if (String(r.status||'').toLowerCase() !== 'confirmed') continue; // solo confirmados para histórico
      const fechaStr = r?.fields?.fecha;
      const dt = parseFecha(fechaStr);
      if(!dt) continue;
      const y = dt.getFullYear();
      const m = String(dt.getMonth()+1).padStart(2,'0');
      const key = `${y}-${m}`;
      (buckets[key] = buckets[key] || []).push(r);
    }
    for (const key of Object.keys(buckets)) {
      const file = path.join(HISTORY_DIR, `${key}.ndjson`);
      const lines = buckets[key].map(o=> JSON.stringify(o)).join('\n') + '\n';
      fs.appendFileSync(file, lines, 'utf8');
    }
  } catch(e){ console.error('[cleanup] Error guardando histórico', e); }
  const backupFile = backupPedidos(all);
  savePedidos(kept);
  console.log(`[cleanup] Eliminados ${removed.length}, quedan ${kept.length}. Backup: ${path.basename(backupFile)}`);
  return { removed: removed.length, kept: kept.length, backup: backupFile };
}

let intervalHandle = null;

function startCleanupScheduler(everyMs) {
  if (intervalHandle) clearInterval(intervalHandle);
  console.log(`[cleanup] Iniciando scheduler cada ${everyMs}ms`);
  // Ejecuta inmediatamente para no esperar al primer intervalo.
  try { cleanupOnce(); } catch (e) { console.error('[cleanup] Error en ejecución inicial', e); }
  intervalHandle = setInterval(() => {
    try { cleanupOnce(); } catch (e) { console.error('[cleanup] Error en cleanup programado', e); }
  }, everyMs);
  return intervalHandle;
}

function stopCleanupScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[cleanup] Scheduler detenido');
  }
}

module.exports = {
  startCleanupScheduler,
  stopCleanupScheduler,
  cleanupOnce,
};
