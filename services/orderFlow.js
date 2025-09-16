// orderFlow.js: lógica estructurada de pasos para 'new_order'
// Nuevos helpers formato DD-MM-AAAA
const isPhone9 = s => /^\d{9}$/.test(String(s).trim());
const isDMY = s => /^\d{2}-\d{2}-\d{4}$/.test(s);
function isFutureOrTodayDMY(s){
  if(!isDMY(s)) return false;
  const [dd,mm,yyyy] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(yyyy, mm-1, dd, 0,0,0));
  const today = new Date(); today.setHours(0,0,0,0);
  return dt >= today;
}

// Parser estricto DD-MM-YYYY y validador con mínimo 3 días
function parseDDMMYYYY(s){
  if(!isDMY(s)) return null;
  const [dd,mm,yyyy] = s.split('-').map(Number);
  const d = new Date(yyyy, mm-1, dd, 0,0,0,0);
  if(d.getFullYear()!==yyyy || (d.getMonth()+1)!==mm || d.getDate()!==dd) return null;
  return d;
}
function validateDateMin3d(s){
  const d = parseDDMMYYYY(String(s||''));
  if(!d) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const min = new Date(today); min.setDate(min.getDate()+3);
  return d.getTime() >= min.getTime();
}

// Nuevo motor basado en lista de pasos y función onStep(state, raw, cfg)
const orderedSteps = [
  'nombre','telefono','tamano','sabores','cantidad','sabores_por_porcion','fecha','obs','confirm'
];

async function onStep(intentId, stepKey, raw, state, cfg){
  // Adaptamos al nuevo motor manteniendo firma usada por botService
  if(!state.awaiting) state.awaiting = stepKey; // compat
  const msgs = cfg.messages || {}; const cat = cfg.catalog || {}; const sizes = cat.sizes || [];
  const text = String(raw||'').trim(); const step = state.awaiting;

  // Helpers internos de respuesta
  const wrapAsk = (askKey, extraMsg)=> extraMsg ? { msg: extraMsg, ask: askKey } : { ask: askKey };

  // Paso: nombre
  if(step==='nombre'){
    state.fields ??= {}; state.fields.nombre = text; state.awaiting='telefono'; return wrapAsk('ask_telefono');
  }
  // Paso: telefono
  if(step==='telefono'){
    if(!isPhone9(text)) return { repeat:true, msg:'Formato de teléfono inválido. Deben ser 9 dígitos.' };
    state.customer = { name: state.fields.nombre, phone: text }; state.awaiting='tamano'; return wrapAsk('ask_tamano');
  }
  // Paso: tamano
  if(step==='tamano'){
    let picked = null; if(/^[123]$/.test(text)) picked = sizes[Number(text)-1]; if(!picked) picked = sizes.find(s=> text.toLowerCase().includes(s.id));
    if(!picked) return { repeat:true, msg:'Opción no válida. Responde 1, 2 o 3.' };
    state.meta = { size: picked }; state.fields.tamano = picked.id; state.awaiting='sabores';
    return { msg:(msgs.flavor_list||''), ask:'ask_sabores' };
  }
  // Paso: sabores
  if(step==='sabores'){
    const list = text.split(',').map(s=>s.trim()).filter(Boolean); if(!list.length) return { repeat:true, msg:'Indica al menos un sabor (separa por comas).' };
    state.fields.sabores = list; state.awaiting='cantidad'; const type = state.meta?.size?.type;
    if(type==='entera')   return wrapAsk('ask_cantidad_entera');
    if(type==='cajitas')  return wrapAsk('ask_cantidad_cajitas');
    if(type==='porciones'){ return wrapAsk('ask_porciones'); }
  }
  // Paso: cantidad
  if(step==='cantidad'){
    const n = Number(text); const type = state.meta?.size?.type;
    if(!Number.isInteger(n) || n<1) return { repeat:true, msg:'Cantidad inválida.' };
    if(type==='entera' && n>20) return { repeat:true, msg:'Máximo 20 tartas.' };
    if(type==='cajitas' && n>50) return { repeat:true, msg:'Máximo 50 cajitas.' };
    if(type==='porciones' && n>30) return { repeat:true, msg:'Máximo 30 porciones.' };
    if(type==='porciones') state.fields.porciones = n; else state.fields.cantidad = n;
    if(type==='porciones'){ state.awaiting='sabores_por_porcion'; return wrapAsk('ask_sabores_por_porcion'); }
    state.awaiting='fecha'; return wrapAsk('ask_fecha');
  }
  // Paso: sabores_por_porcion
  if(step==='sabores_por_porcion'){
    state.fields.sabores_por_porcion = text; state.awaiting='fecha'; return wrapAsk('ask_fecha');
  }
  // Paso: fecha (DD-MM-AAAA)
  if(step==='fecha'){
    if(!validateDateMin3d(text)){
      const min = new Date(); min.setHours(0,0,0,0); min.setDate(min.getDate()+3);
      const pad=n=>String(n).padStart(2,'0');
      const minStr = `${pad(min.getDate())}-${pad(min.getMonth()+1)}-${min.getFullYear()}`;
      return { repeat:true, msg:`Fecha inválida o muy próxima. Debe ser al menos con 3 días de antelación (>= ${minStr}). Formato: DD-MM-AAAA.` };
    }
    state.fields.fecha = text; state.awaiting='obs'; return wrapAsk('ask_obs');
  }
  // Paso: obs
  if(step==='obs'){
    state.fields.observacion = (text.toLowerCase()==='no') ? '' : text; const size = state.meta?.size; let total=0;
    if(size?.type==='entera' || size?.type==='cajitas'){ const q=Number(state.fields.cantidad||1); total = q*(size?.price||0); }
    else { const q=Number(state.fields.porciones||0); total = q*(size?.price||0); }
    state.total = Number(total.toFixed(2)); const cantidad = size?.type==='porciones'? (state.fields.porciones||0):(state.fields.cantidad||1);
    const conf = (msgs.confirm||'')
      .replace('{nombre}', state.customer?.name||'')
      .replace('{telefono}', state.customer?.phone||'')
      .replace('{tamano}', size?.label || state.fields.tamano)
      .replace('{cantidad}', String(cantidad))
      .replace('{sabores}', (state.fields?.sabores||[]).join(', '))
      .replace('{fecha}', state.fields?.fecha||'')
      .replace('{total}', String(state.total||0));
    state.awaiting='confirm'; return { text: conf || '¿Confirmas? (sí/no)' };
  }
  // Paso: confirm
  if(step==='confirm'){
    const ok = /^(si|sí|s|ok|vale|confirmo)$/i.test(text); if(!ok) return { repeat:true, msg: (msgs.confirm_yesno||'Responde sí o no, por favor.') };
    return { done:true };
  }
  return { repeat:true, msg:'No te entendí, repite por favor.' };
}

module.exports = { onStep };

// --- Implementación simplificada solicitada (simpleOnStep) ---
function simpleOnStep(state, raw, cfg){
  const msg = cfg.messages || {};
  const cat = cfg.catalog || {}; const sizes = cat.sizes || [];
  const text = String(raw||'').trim();
  if(!state.fields) state.fields = {};

  if(!state.awaiting) state.awaiting = 'nombre';
  const step = state.awaiting;

  if(step==='nombre'){
    state.fields.nombre = text; state.awaiting='telefono';
    return msg.ask_telefono;
  }
  if(step==='telefono'){
    if(!isPhone9(text)) return "Formato de teléfono inválido. Deben ser 9 dígitos.";
    state.customer = { name: state.fields.nombre, phone: text }; state.awaiting='tamano';
    return msg.ask_tamano;
  }
  if(step==='tamano'){
    let picked = null; if(/^[123]$/.test(text)) picked = sizes[Number(text)-1]; if(!picked) picked = sizes.find(s => text.toLowerCase().includes(s.id));
    if(!picked) return 'Opción no válida. Responde 1, 2 o 3.';
    state.meta = { size: picked }; state.fields.tamano = picked.id;
    state.awaiting='sabores';
    return (msg.flavor_list + "\n\n" + msg.ask_sabores).trim();
  }
  if(step==='sabores'){
    const list = text.split(',').map(s=>s.trim()).filter(Boolean);
    if(!list.length) return 'Indica al menos un sabor (separa por comas).';
    state.fields.sabores = list; state.awaiting='cantidad';
    const type = state.meta?.size?.type;
    if(type==='entera') return msg.ask_cantidad_entera;
    if(type==='cajitas') return msg.ask_cantidad_cajitas;
    if(type==='porciones') return msg.ask_porciones;
  }
  if(step==='cantidad'){
    const n = Number(text); const type = state.meta?.size?.type;
    if(!Number.isInteger(n) || n<1) return 'Cantidad inválida.';
    if(type==='entera' && n>20) return 'Máximo 20 tartas.';
    if(type==='cajitas' && n>50) return 'Máximo 50 cajitas.';
    if(type==='porciones' && n>30) return 'Máximo 30 porciones.';
    if(type==='porciones') state.fields.porciones = n; else state.fields.cantidad = n;
    if(type==='porciones'){ state.awaiting='sabores_por_porcion'; return msg.ask_sabores_por_porcion; }
    state.awaiting='fecha'; return msg.ask_fecha;
  }
  if(step==='sabores_por_porcion'){
    state.fields.sabores_por_porcion = text; state.awaiting='fecha'; return msg.ask_fecha;
  }
  if(step==='fecha'){
    if(!validateDateMin3d(text)){
      const min = new Date(); min.setHours(0,0,0,0); min.setDate(min.getDate()+3);
      const pad=n=>String(n).padStart(2,'0');
      const minStr = `${pad(min.getDate())}-${pad(min.getMonth()+1)}-${min.getFullYear()}`;
      return `Fecha inválida o muy próxima. Debe ser al menos con 3 días de antelación (>= ${minStr}). Formato: DD-MM-AAAA.`;
    }
    state.fields.fecha = text; state.awaiting='obs'; return msg.ask_obs;
  }
  if(step==='obs'){
    state.fields.observacion = (text.toLowerCase()==='no') ? '' : text;
    const size = state.meta?.size; let total=0;
    if(size?.type==='entera' || size?.type==='cajitas') total = (Number(state.fields.cantidad||1)) * (size?.price||0);
    else total = (Number(state.fields.porciones||0)) * (size?.price||0);
    state.total = Number(total.toFixed(2));
    const cantidad = size?.type==='porciones'? (state.fields.porciones||0):(state.fields.cantidad||1);
    const conf = (msg.confirm||'')
      .replace('{nombre}', state.customer?.name||'')
      .replace('{telefono}', state.customer?.phone||'')
      .replace('{tamano}', size?.label || state.fields.tamano)
      .replace('{cantidad}', String(cantidad))
      .replace('{sabores}', (state.fields?.sabores||[]).join(', '))
      .replace('{fecha}', state.fields?.fecha||'')
      .replace('{total}', String(state.total||0));
    state.awaiting='confirm';
    return conf || '¿Confirmas? (sí/no)';
  }
  if(step==='confirm'){
    const ok = /^(si|sí|s|ok|vale|confirmo)$/i.test(text);
    if(!ok) return (msg.confirm_yesno||'Responde sí o no, por favor.');
    // Validar campos obligatorios antes de terminar
    const required = ['nombre','telefono','tamano','sabores','fecha'];
    const missing = required.filter(k=> !state.fields || !state.fields[k] || (Array.isArray(state.fields[k]) && !state.fields[k].length));
    if(missing.length){
      // Re-posicionar al primer campo faltante
      const first = missing[0];
      state.awaiting = first;
      return `Faltan datos (${missing.join(', ')}). Vamos a retomarlo: ${first}.`;
    }
    state.done = true; return null;
  }
  return 'No te entendí, repite por favor.';
}

module.exports.simpleOnStep = simpleOnStep;