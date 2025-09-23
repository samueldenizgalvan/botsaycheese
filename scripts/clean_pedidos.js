#!/usr/bin/env node
/**
 * Limpia pedidos anteriores a la fecha actual (según zona horaria del servidor)
 * Ruta de trabajo: backend-bot/data/samuel/pedidos.json
 * Crea backup antes de sobrescribir.
 */
const fs = require('fs');
const path = require('path');

const pedidosPath = path.join(__dirname, '..', 'data', 'samuel', 'pedidos.json');

function parseFecha(str, fallbackYear){
  if(!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{2})[\/-](\d{2})(?:[\/-](\d{2,4}))?$/);
  if(!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  let yyyy = fallbackYear;
  if(m[3]){
    yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  }
  const dt = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
  if(isNaN(dt.getTime())) return null;
  return dt;
}

(function main(){
  if(!fs.existsSync(pedidosPath)){
    console.error('No existe pedidos.json en', pedidosPath);
    process.exit(1);
  }
  const raw = fs.readFileSync(pedidosPath, 'utf8');
  let arr;
  try { arr = JSON.parse(raw); } catch(err){
    console.error('JSON inválido:', err.message);
    process.exit(1);
  }
  if(!Array.isArray(arr)){
    console.error('Formato no es array, abortando.');
    process.exit(1);
  }
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);

  const kept = [];
  const removed = [];

  for(const o of arr){
    // Buscar fecha en fields.fecha o items[0].fecha
    const fechaStr = o?.fields?.fecha || (Array.isArray(o?.fields?.items) && o.fields.items[0]?.fecha) || null;
    const dt = parseFecha(fechaStr, now.getFullYear());
    if(!dt){
      // Si no se puede parsear, conservar por seguridad
      kept.push(o);
      continue;
    }
    if(dt.getTime() >= todayMidnight.getTime()){
      kept.push(o);
    } else {
      removed.push(o);
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const backupName = `pedidos.backup-${ts}.json`;
  const backupPath = path.join(path.dirname(pedidosPath), backupName);
  fs.writeFileSync(backupPath, JSON.stringify(arr, null, 2), 'utf8');
  fs.writeFileSync(pedidosPath, JSON.stringify(kept, null, 2), 'utf8');

  console.log(`Backup creado: ${backupName}`);
  console.log(`Pedidos originales: ${arr.length}`);
  console.log(`Eliminados (anteriores a hoy): ${removed.length}`);
  console.log(`Conservados: ${kept.length}`);
})();
