const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

// Sólo autenticado (se monta detrás de authRequired en server.js si se desea)
const DATA_ROOT = path.join(__dirname, '..', 'data', 'samuel');
const HISTORY_DIR = path.join(DATA_ROOT, 'history');
const PEDIDOS_FILE = path.join(DATA_ROOT, 'pedidos.json');

function safeJsonParse(line){ try { return JSON.parse(line); } catch { return null; } }
function parseFecha(fechaStr){ if(!fechaStr) return null; const m = fechaStr.match(/^(\d{1,2})[-\/]?(\d{1,2})(?:[-\/]?(\d{2,4}))?$/); if(!m) return null; let [_,d,M,y] = m; const year = y ? (y.length===2 ? 2000+parseInt(y,10):parseInt(y,10)) : new Date().getFullYear(); const month=parseInt(M,10)-1; const day=parseInt(d,10); const dt=new Date(year,month,day); return isNaN(dt)?null:dt; }

router.get('/', async (req,res)=>{
  try {
    const month = String(req.query.month||'').trim(); // formato YYYY-MM
    if(!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error:'month inválido (usar YYYY-MM)' });
    const histFile = path.join(HISTORY_DIR, month + '.ndjson');
    let historical = [];
    if(fs.existsSync(histFile)){
      const lines = fs.readFileSync(histFile,'utf8').split('\n').filter(Boolean);
      historical = lines.map(safeJsonParse).filter(Boolean);
    }
    // Pedidos actuales (no expirados) que pertenezcan al mes solicitado y estén confirmados
    let current = [];
    if(fs.existsSync(PEDIDOS_FILE)){
      try { current = JSON.parse(fs.readFileSync(PEDIDOS_FILE,'utf8')); } catch { current = []; }
    }
  const today = new Date(); today.setHours(0,0,0,0);
  const filteredCurrent = current.filter(o=> String(o.status||'').toLowerCase()==='confirmed' && ( ()=>{ const dt = parseFecha(o?.fields?.fecha); if(!dt) return false; dt.setHours(0,0,0,0); const y=dt.getFullYear(); const m=String(dt.getMonth()+1).padStart(2,'0'); if(`${y}-${m}`!==month) return false; if(dt>today) return false; return true; })());
  // También recortar históricos a no incluir registros con fecha futura accidental (defensivo)
  const filteredHistorical = historical.filter(p=>{ const dt=parseFecha(p?.fields?.fecha); if(!dt) return true; dt.setHours(0,0,0,0); return dt<=today; });
  const all = filteredHistorical.concat(filteredCurrent);
    // Agregaciones
    const totalPedidos = all.length;
    let totalImporte = 0;
    const saboresMap = {};
    const tiposMap = {}; // tamano
    for(const p of all){
      const items = (p?.fields?.items && Array.isArray(p.fields.items)) ? p.fields.items : [{ tamano: p?.fields?.tamano || p.tamano, cantidad: p?.fields?.cantidad || p.cantidad, sabores: p?.fields?.sabores || p.sabores, total: p.total }];
      for(const it of items){
        const tam = (it.tamano||'').toLowerCase();
        if(!tiposMap[tam]) tiposMap[tam]=0;
        const cant = Number(it.cantidad)||1;
        tiposMap[tam]+=cant;
        const sabores = Array.isArray(it.sabores)? it.sabores : [];
        const distrib = Array.isArray(it.sabores_distribucion)? it.sabores_distribucion : p?.fields?.sabores_distribucion;
        if(Array.isArray(distrib)){
          for(const d of distrib){
            const key = `${d.flavor} - ${tam}`;
            if(!saboresMap[key]) saboresMap[key]=0;
            saboresMap[key]+= Number(d.count)||0;
          }
        } else {
          for(const s of sabores){
            const key = `${s} - ${tam}`;
            if(!saboresMap[key]) saboresMap[key]=0;
            saboresMap[key]+= cant / (sabores.length||1);
          }
        }
        totalImporte += Number(it.total)||0;
      }
    }
    res.json({ month, totalPedidos, totalImporte, sabores: saboresMap, tamanos: tiposMap });
  } catch(e){
    console.error('[historico] error', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
