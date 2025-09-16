// Cancela pedidos por teléfono y responde siempre al usuario
async function cancelByPhoneAndReply(tenantId, client, chatId, phone, cfg) {
	const msgs = cfg.messages || {};
	const matches = await findPendingByPhone(tenantId, phone);
	if (!matches || matches.length === 0) {
		const preview = (msgs.no_pedidos || 'No hay pedidos pendientes con ese número.').slice(0, 80);
		console.log('[SEND]', phone, preview);
		try {
			await client.sendMessage(chatId, msgs.no_pedidos || 'No hay pedidos pendientes con ese número.');
		} catch (e) {
			console.error('[SEND][ERROR]', e && e.message);
		}
		return;
	}
	for (const m of matches) {
		try { await require('./orderStore').cancel(tenantId, m.id); } catch {}
	}
	{
		const preview = (msgs.cancelados_ok || 'Pedido(s) cancelado(s).').slice(0, 80);
		console.log('[SEND]', phone, preview);
		try {
			await client.sendMessage(chatId, msgs.cancelados_ok || 'Pedido(s) cancelado(s).');
		} catch (e) {
			console.error('[SEND][ERROR]', e && e.message);
		}
	}
}
// Centraliza el envío de prompts con antirrebote y persistencia
async function sendPrompt(tenantId, client, to, session, text, options = {}) {
	const opts = options || {};
	// Leer sesión fresca para evitar falsos positivos de rebote
	let fresh = session;
	try { fresh = (await convStore.readConv(tenantId, String(to).replace(/@.*/, ''))) || session || {}; } catch {}
	if (!opts.bypassDebounce && shouldSkipPromptDueToDebounce(fresh, text)) return;
	await setLastPrompt(tenantId, String(to).replace(/@.*/, ''), text);
	const preview = String(text).slice(0, 80);
	console.log('[SEND]', to, preview);
	try {
		await client.sendMessage(to, String(text));
	} catch (e) {
		console.error('[SEND][ERROR]', e && e.message);
	}
}
// Carga robusta de sesión
async function loadSessionState(tenantId, phone) {
	try {
		return await convStore.readConv(tenantId, phone) || {};
	} catch {
		return {};
	}
}
// Helper para avanzar de stage y guardar sesión correctamente
async function setStageAndSave(tenantId, phone, newStage, session) {
						if (typeof newStage !== 'string') {
							throw new Error('El nuevo stage debe ser un string');
						}
						// No mutar session.state.stage aquí; rely on saveSessionState + reload
						await saveSessionState(tenantId, phone, newStage);
						const newSession = await loadSessionState(tenantId, phone);
						console.log('[DEBUG] Estado después de guardar:', newSession.state);
						if (newSession.state.stage !== internalToSessionStage(newStage)) {
							throw new Error(`Stage no actualizado correctamente: esperado ${internalToSessionStage(newStage)}, real ${newSession.state.stage}`);
						}
}
// Clean consolidated bot service implementation (lazy-load WA lib to avoid early crashes)
const DISABLE_WA = /^(1|true|yes)$/i.test(String(process.env.DISABLE_WA||''));
let WA = null; // will hold { Client, LocalAuth }
function ensureWA(){
	if(DISABLE_WA) return null;
	if(!WA){
		try {
			WA = require('whatsapp-web.js');
		} catch(e){
			console.error('[botService] Error requiring whatsapp-web.js -> habilita DISABLE_WA=1 para arrancar sin WA.');
			console.error(e);
			throw e;
		}
	}
	return WA;
}
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const store = require('./store');
const runtime = require('./conversationRuntime');
const convStore = require('./conversationStore');
const orderStore = require('./orderStore');

// Persistent auth/data directories
const DATA_DIR = path.join(process.cwd(), 'data');
const AUTH_DIR = path.join(DATA_DIR, '.wwebjs_auth');
try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}

// Caches / maps
const clients = new Map();                 // tenantId -> whatsapp-web.js Client
const lifecycle = new Map();               // tenantId -> {status,isReady,...}
const qrCache = new Map();                 // tenantId -> dataURL
const configCache = new Map();             // tenantId -> config json
const loggedTenants = new Set();           // avoid repeating console log

// Helpers
const norm = s => (s||'').toString().trim().toLowerCase();
const isPhone9 = s => /^\d{9}$/.test(String(s).trim());

// Prompt debounce helpers (30s window)
function shouldSkipPromptDueToDebounce(session, promptText){
	try{
		const lp = session && session.lastPrompt ? session.lastPrompt : null;
		if(!lp || !lp.text) return false;
		if(String(lp.text) !== String(promptText)) return false;
		const within = (Date.now() - (lp.ts||0)) < 30*1000;
		const answered = Boolean(lp.answered);
		return within && !answered;
	}catch{ return false; }
}
async function setLastPrompt(tenantId, phone, promptText){
	try{
		const prev = await convStore.readConv(tenantId, phone) || {};
		const now = Date.now();
		const next = {
			...prev,
			lastPrompt: { text: String(promptText), ts: now, answered: false },
			lastPromptAt: now
		};
		await convStore.writeConv(tenantId, phone, next);
	}catch{}
}
async function markLastPromptAnswered(tenantId, phone){
	try{
		const prev = await convStore.readConv(tenantId, phone) || {};
		const lp = prev.lastPrompt || {};
		prev.lastPrompt = { ...lp, answered: true };
		await convStore.writeConv(tenantId, phone, prev);
	}catch{}
}

// Date utils: parse flexible DD-MM or DD/MM with optional year (defaults current year)
function parseDDMMYYYY(s){
	const str = String(s||'').trim();
	const m = /^(\d{2})[\/-](\d{2})(?:[\/-](\d{4}))?$/.exec(str);
	if(!m) return null;
	const dd = Number(m[1]);
	const mm = Number(m[2]);
	const yyyy = m[3] ? Number(m[3]) : (new Date()).getFullYear();
	const d = new Date(yyyy, mm-1, dd, 0,0,0,0);
	if(d.getFullYear()!==yyyy || (d.getMonth()+1)!==mm || d.getDate()!==dd) return null;
	return d;
}
function validateDateMin3d(text){
	const d = parseDDMMYYYY(text);
	if(!d) return false;
	const today = new Date(); today.setHours(0,0,0,0);
	const min = new Date(today); min.setDate(min.getDate()+3);
	return d.getTime() >= min.getTime();
}

// Render helpers
function renderFlavorList(cfg){
	const custom = cfg?.messages?.flavor_list;
	if (typeof custom === 'string' && custom.trim()) {
		return '\n' + custom.trim();
	}
	const flavors=(cfg.catalog?.flavors||cfg.flavors||[]);
	if(!flavors.length) return '';
	return '\n' + flavors.map(f=>`• ${f}`).join('\n');
}

// Allowed sizes helper (remove 'porciones')
function getAllowedSizes(cfg){
	const sizesArr = cfg.catalog?.sizes || [];
	return Array.isArray(sizesArr) ? sizesArr.filter(s => String(s.type||'').toLowerCase() !== 'porciones') : [];
}

function buildAskDatePrompt(){
	const today = new Date(); today.setHours(0,0,0,0);
	const min = new Date(today); min.setDate(min.getDate()+3);
	let max = new Date(min); max.setMonth(max.getMonth()+3);
	// Clamp to end of current year if it crosses year boundary (año fijo actual)
	if(max.getFullYear() > today.getFullYear()){
		max = new Date(today.getFullYear(), 11, 31);
	}
	const pad=n=>String(n).padStart(2,'0');
	const minStr = `${pad(min.getDate())}-${pad(min.getMonth()+1)}`;
	const maxStr = `${pad(max.getDate())}-${pad(max.getMonth()+1)}`;
	return `Indica fecha (DD-MM o DD/MM). Mínimo 3 días (>= ${minStr}) y máximo 3 meses (<= ${maxStr}).`;
}

function validateFlavorList(items, allowed){
	if(!allowed || !allowed.length) return { ok:true, invalid: [] };
	const canon = new Set(allowed.map(f=>f.toLowerCase()));
	const invalid = items.filter(f=> !canon.has(f.toLowerCase()));
	return { ok: invalid.length===0, invalid };
}

// --- Delete by phone helper ---
async function deleteByPhone(ctx, cfg, store, send){
	try{
		const tel = (ctx?.values?.telefono_del || '').toString();
		const list = await store.findPendingByPhone(ctx.tenantId, tel);
		if(!Array.isArray(list) || list.length===0){
			const msg = (cfg?.messages?.delete_none) || 'No encontré pedidos pendientes con ese número.';
			return send(msg);
		}
		// Persist temp state for confirmation y marca estado activo
		await convStore.writeConv(ctx.tenantId, ctx.phone, {
			...(await convStore.readConv(ctx.tenantId, ctx.phone) || {}),
			del_list: list.map(p=>String(p.id)),
			tel,
			state: { flow: 'delete_order', stage: 'delete_by_phone' },
			lastAsk: { stage: 'delete_by_phone', ts: Date.now() }
		});
		const base = (cfg?.messages?.delete_found) || 'He encontrado {count} pedido(s) pendiente(s) para el teléfono {telefono}:';
		const header = base.replace('{count}', String(list.length)).replace('{telefono}', tel);
		const items = list.map(o=>`- ID ${o.id}`).join('\n');
		const tail = '\n¿Quieres cancelarlo(s)? (sí/no)';
		return send([header, items, tail].filter(Boolean).join('\n'));
	} catch(e){
		return send('Ocurrió un problema al buscar ese número. Intenta de nuevo.');
	}
}

// Greet control: only once per 24h unless user asks (menu/hola)
function shouldGreet(session){
	try{
		if(!session || !session.greetedAt) return true;
		const last = new Date(session.greetedAt);
		if(isNaN(last.getTime())) return true;
		return (Date.now() - last.getTime()) > 24*60*60*1000;
	}catch{ return true; }
}

// Show full welcome+menu only when explicitly asked or if last menu was a while ago
function shouldShowFullMenu(session, lower){
	const isExplicitMenu = /^(menu|menú)$/i.test(lower);
	if(isExplicitMenu) return true; // always allow explicit menu
	const greetOrPedido = /^(hola|buenas|buenos dias|buenas tardes|buenas noches|pedido)$/i.test(lower);
	if(!greetOrPedido) return false;
	const last = Number(session && session.lastMenuAt || 0);
	const windowMs = 5*60*1000; // 5 minutes
	return !last || (Date.now() - last > windowMs);
}

// Robust flavor normalization and resolution

const normalize = s => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').trim();
function canonicalFlavorMap(config){
	const map = new Map();
	const list = config.catalog?.flavors || config.flavors || [];
	for (const f of list){
		const key = normalize(f);
		map.set(key, f);
		// Alias: si el sabor contiene "mango", aceptar también "mango"
		if(key.includes('mango') && !map.has('mango')){
			map.set('mango', f);
		}
	}
	return map;
}
function resolveFlavors(inputList, map){
	const out = [];
	for (const raw of inputList){
		const key = normalize(raw);
		if (!map.has(key)) return { ok:false, bad: raw };
		out.push(map.get(key));
	}
	// dedupe keeping original order
	const seen = new Set();
	const dedup = [];
	for(const f of out){ if(!seen.has(f)){ seen.add(f); dedup.push(f); } }
	return { ok:true, flavors: dedup };
}

// Returns {kind:'none'} if it doesn't look like per-portion input,
// {kind:'error', message} for format/limit errors, or {kind:'ok', lists: string[][]}

function dedupeStartHint(text){
  if(!text) return text;
  return String(text).replace(/(Escribe\s*\*?pedido\*?\s*para\s*empezar\.?(?:\s*|\n|\r))+?/gi, (m)=>{
    // collapse any repeated blocks to a single instance (take the first sentence only)
    return (m.match(/Escribe/i) ? m.split(/\s*(?=Escribe)/i)[0] : m).replace(/\s+$/, '');
  }).replace(/(Escribe\s*\*?pedido\*?\s*para\s*empezar\.?)(\s*\1)+/gi, '$1');
}

function buildWelcome(cfg){
	const msgs = cfg.messages||{}; const brand=cfg.brand||cfg.displayName||'';
	let base = msgs.welcome || (brand?`¡Hola! 👋 Soy el asistente de *${brand}*.`:'¡Hola! 👋');
	const hint = msgs.welcome_hint || 'Escribe *pedido* para empezar. 🍰';
	if(!base.toLowerCase().includes('pedido') && !base.toLowerCase().includes(hint.toLowerCase())) base=`${base} ${hint}`.trim();
  base = dedupeStartHint(base);
	return base;
}

function buildMenu(cfg){
	const msgs=cfg.messages||{}; 
	// If custom menu exists but mentions 'porciones', ignore it and rebuild.
	if(msgs.menu && !/(porciones|porción|porcion)/i.test(String(msgs.menu))) return msgs.menu;
		const lines=[];
		// Prepend clear options block (no portions mentioned)
		lines.push(
			'Opciones 📋:',
			'1) Generar pedido 🛒',
			'2) Cancelar un pedido ❌',
			'3) Modificar un pedido ✏️',
			'4) ¿Dónde estamos? 📍',
			'5) Dejar una reseña ⭐\n'
		);
		const allowedSizes = getAllowedSizes(cfg);
		const sizes=(allowedSizes||[]).map(s=>`- ${s.label||s.id}: ${s.price??''}`.trim()).join('\n'); if(sizes) lines.push('Tamaños:',sizes);
	const flavors=(cfg.catalog?.flavors||cfg.flavors||[]); if(flavors.length) lines.push('Sabores:',flavors.map(f=>`- ${f}`).join('\n'));
		// Horario del local de SayCheese
		lines.push('\nHorario del local de SayCheese ⏰:',
			'• Miércoles a domingo 11:00–13:00 → recoger encargos',
			'• Viernes 18:00–20:00 → recoger encargos',
			'• Fines de semana 11:00–13:00'
		);
	if(!lines.length) lines.push('Menú no configurado. Envía *pedido* para iniciar.');
	lines.push('\nPuedes escribir *atras* para retroceder un paso o *cancelar* para cancelar. 🔁');
	return lines.join('\n');
}

// Build size question from allowed sizes, ignoring any hard-coded enumerations in messages
function buildSizeQuestion(cfg){
	const msgs=cfg.messages||{};
	const sizes = getAllowedSizes(cfg);
	const fmtPrice = (p)=>{
		if(p==null || p==='') return '';
		const str = String(p).trim();
		if(/[€$]/.test(str)) return str;
		return `${str}€`;
	};
	const sizeList = sizes.map((s,i)=>{
		const base = s.label || s.id;
		const hasCurrencyInLabel = typeof base==='string' && /[€$]/.test(base);
		const priceText = fmtPrice(s.price);
		const display = hasCurrencyInLabel || !priceText ? base : `${base} (${priceText})`;
		return `*${i+1}*. ${display}`;
	}).join('\n');
	// Prefer full custom prompt if present
	if(msgs.ask_tamano){
		return msgs.ask_tamano.includes('{sizes}') ? msgs.ask_tamano.replace('{sizes}', sizeList) : msgs.ask_tamano;
	}
	// Fallback generated prompt
	return 'Elige tamaño:' + (sizeList? ('\n'+sizeList):'');
}

// Build order item for the current product using config prices
function buildOrderItem(conv, cfg){
	const precioMap = (cfg.options && cfg.options.precios) || {};
	const tamanoId = (conv.selectedSize?.id || conv.data?.tamano || '').toLowerCase();
	const cantidad = Number(conv.data?.cantidad || 0);
	const sizeRec = Array.isArray(cfg.catalog?.sizes)? cfg.catalog.sizes.find(s=> String(s.id).toLowerCase()===tamanoId) : null;
	const precioUnit = Number((sizeRec && sizeRec.price != null) ? sizeRec.price : (precioMap[tamanoId])) || 0;
	const subtotal = precioUnit * (cantidad || 0);
	return {
		tamano: tamanoId,
		label: conv.selectedSize?.label || tamanoId,
		type: conv.selectedSize?.type || 'entera',
		cantidad,
		sabores: Array.isArray(conv.data?.sabores) ? conv.data.sabores : [],
		fecha: conv.data?.fecha || '',
		observacion: conv.data?.observacion || '',
		precioUnit,
		total: subtotal
	};
}

function summarizeItems(conv, cfg, msgs){
	const items = Array.isArray(conv.items) ? conv.items : [];
	const lines = [];
	if(items.length){
		lines.push('Resumen del pedido:');
		items.forEach((it, idx)=>{
			const saboresTexto = it.sabores_por_porcion
				? it.sabores_por_porcion.map((arr,i)=>`${i+1}) ${arr.join(', ')}`).join(' | ')
				: (Array.isArray(it.sabores) ? it.sabores.join(', ') : '');
			const label = it.label || it.tamano;
			const obs = it.observacion ? ` • Obs: ${it.observacion}` : '';
			lines.push(`${idx+1}) ${label} x${it.cantidad} • Sabores: ${saboresTexto || '-' }${obs} • Subtotal: ${it.total||0}€`);
		});
	}
	const total = Number(conv.items?.reduce((acc,it)=> acc + (Number(it.total)||0), 0) || conv.total || 0);
	const totalLine = (msgs?.total_line || `Total: ${total}€`);
	lines.push(totalLine);
	return lines.join('\n');
}

// Summarize an already saved order (from store) for preview
function summarizeStoredOrder(order){
	try{
		const f = order && order.fields || {};
		const items = Array.isArray(f.items) ? f.items : null;
		const lines = [];
		if(items && items.length){
			items.forEach((it, idx)=>{
				const saboresTexto = it.sabores_por_porcion
					? it.sabores_por_porcion.map((arr,i)=>`${i+1}) ${arr.join(', ')}`).join(' | ')
					: (Array.isArray(it.sabores) ? it.sabores.join(', ') : '');
				const label = it.label || it.tamano || '';
				const obs = it.observacion ? ` • Obs: ${it.observacion}` : '';
				const subtotal = (typeof it.total === 'number') ? ` • Subtotal: ${it.total}€` : '';
				lines.push(`${idx+1}) ${label} x${it.cantidad||''} • Sabores: ${saboresTexto || '-'}${obs}${subtotal}`);
			});
		} else {
			const label = f.tamano || order.tamano || '';
			const sab = Array.isArray(f.sabores) ? f.sabores.join(', ') : (order.sabores||[]).join(', ');
			const cant = (f.cantidad != null ? f.cantidad : (order.cantidad||''));
			const obs = f.observacion ? ` • Obs: ${f.observacion}` : '';
			lines.push(`${label} x${cant} • Sabores: ${sab || '-' }${obs}`);
		}
		const total = Number(order.total || (items ? items.reduce((acc,it)=> acc + (Number(it.total)||0), 0) : 0)) || 0;
		lines.push(`Total: ${total}€`);
		return lines.join('\n');
	} catch { return ''; }
}

// Map internal stage -> session stage label (Spanish keys for persistence)
function internalToSessionStage(internal){
	switch(internal){
		case 'ask_name': return 'ask_nombre';
		case 'ask_phone': return 'ask_telefono';
		case 'ask_size': return 'ask_tamano';
		case 'ask_flavors': return 'ask_sabores';
		case 'ask_qty': return 'ask_cantidad';
		case 'ask_date': return 'ask_fecha';
		case 'ask_obs': return 'ask_obs';
		case 'ask_more': return 'ask_mas';
		case 'confirm': return 'confirm';
		default: return internal||'';
	}
}

// Map session stage label -> internal stage key
function sessionToInternalStage(sessionStage){
	switch(String(sessionStage||'')){
		case 'ask_nombre': return 'ask_name';
		case 'ask_telefono': return 'ask_phone';
		case 'ask_tamano': return 'ask_size';
		case 'ask_sabores': return 'ask_flavors';
		case 'ask_cantidad': return 'ask_qty';
		case 'ask_fecha': return 'ask_date';
		case 'ask_obs': return 'ask_obs';
		case 'ask_mas': return 'ask_more';
		case 'confirm': return 'confirm';
		default: return String(sessionStage||'');
	}
}

// Generate prompt for a given internal stage without mutating data
function genPromptForStage(cfg, conv, msgs, stage){
	switch(stage){
		case 'ask_name': return msgs.ask_nombre||'¿Cuál es tu *nombre*? 🙂 (o escribe cancelar)';
		case 'ask_phone': return msgs.ask_telefono||'Indica tu *teléfono* (9 dígitos) 📞:';
		case 'ask_size': return buildSizeQuestion(cfg);
		case 'ask_flavors': return (msgs.ask_sabores||'Elige sabores 🍓 (separa con comas):') + renderFlavorList(cfg);
		case 'ask_qty': {
			const st=conv.selectedSize?.type;
			if(st==='cajitas') return msgs.ask_cantidad_cajitas||'¿Cantidad de cajitas? (1-50) 📦';
			return msgs.ask_cantidad_entera||'¿Cantidad? (1-20) 🔢';
		}
		case 'ask_date': {
			const base = msgs.ask_fecha || ('📅 ' + buildAskDatePrompt());
			const sched = cfg.messages?.pickup_schedule ? ('\n\n' + cfg.messages.pickup_schedule) : '';
			return base + sched;
		}
		case 'ask_obs': return msgs.ask_obs||'📝 Observaciones (escribe "no" si no hay)';
		case 'ask_more': return msgs.ask_mas || '¿Quieres añadir algo más a tu pedido? (sí/no) ➕';
		case 'confirm': {
			const tpl=(msgs.confirm||'Confirma pedido: {tamano} {fecha} Total {total}€');
			const cantidad = (conv.data.cantidad||1);
			const summary=tpl
				.replace('{telefono}',conv.data?.telefono||'')
				.replace('{tamano}',conv.selectedSize?.label||conv.data?.tamano||'')
				.replace('{cantidad}',String(cantidad))
				.replace('{sabores}',(conv.data?.sabores||[]).join(', '))
				.replace('{fecha}',conv.data?.fecha||'')
				.replace('{total}',String(conv.total||0));
			return summary+'\n'+(msgs.confirm_yesno||'👉 Responde *sí* o *no*.');
		}
		default: return null;
	}
}

// Save session state and lastAsk guard
async function saveSessionState(tenantId, phone, stageInternal){
	try{
		const prev = await convStore.readConv(tenantId, phone) || {};
		const stageSession = internalToSessionStage(stageInternal);
		const next = { ...prev, state: { flow: 'new_order', stage: stageSession }, lastAsk: { stage: stageSession, ts: Date.now() } };
		await convStore.writeConv(tenantId, phone, next);
		const p = require('./conversationStore').pathForConv ? require('./conversationStore').pathForConv(tenantId, phone) : '';
		console.log('[saveSessionState]', p, next);
	}catch(e){
		const p = require('./conversationStore').pathForConv ? require('./conversationStore').pathForConv(tenantId, phone) : '';
		console.error('[saveSessionState][ERROR]', p, e);
	}
}

async function getConfig(tenantId){
	if(configCache.has(tenantId)) return configCache.get(tenantId);
	try{ 
		let raw = await store.readJSON(tenantId,'config.json',{});
		// Fallback: if simple requested structure exists separately use it
		if(!raw.brand && !raw.catalog){
			const simple = await store.readJSON(tenantId,'config.simple.requested.json',null);
			if(simple) raw = simple;
		}
		// Normalize: ensure catalog.sizes/flavors arrays for downstream logic
		if(!raw.catalog) raw.catalog = {};
		if(raw.sizes && !raw.catalog.sizes){
			// convert map -> array with inferred type
			raw.catalog.sizes = Object.entries(raw.sizes).map(([id,price])=>({ id, label: `${id.charAt(0).toUpperCase()}${id.slice(1)} (${price}€)`, price: price, type: id }));
		}
		if(raw.flavors && !raw.catalog.flavors){ raw.catalog.flavors = raw.flavors; }
		configCache.set(tenantId,raw); return raw; 
	}
	catch(e){ console.error(`[${tenantId}] getConfig error`,e); const empty={}; configCache.set(tenantId,empty); return empty; }
}

// --- Menu/welcome + delete-by-phone helpers ---
async function sendWelcomeAndMenu(client, chatId, cfg){
  const brand = cfg.brand || cfg.displayName || 'SayCheese By Nestor';
  const welcome = (cfg.messages?.welcome || buildWelcome(cfg)).replace(/\{\{\s*brand\s*\}\}/g, brand);
	const menu = cfg.messages?.menu || buildMenu(cfg);
	{
		const preview = String(welcome).slice(0, 80);
		console.log('[SEND]', chatId, preview);
		try {
			await client.sendMessage(chatId, String(welcome));
		} catch (e) {
			console.error('[SEND][ERROR]', e && e.message);
		}
	}
	{
		const preview = String(menu).slice(0, 80);
		console.log('[SEND]', chatId, preview);
		try {
			await client.sendMessage(chatId, String(menu));
		} catch (e) {
			console.error('[SEND][ERROR]', e && e.message);
		}
	}
}

async function findPendingByPhone(tenantId, phone){
	return await orderStore.findPendingByPhone(tenantId, phone);
}

async function deletePendingByPhone(tenantId, phone){
	// Cancela pedidos (pendientes o confirmados) por teléfono
	const matches = await findPendingByPhone(tenantId, phone);
	for(const m of matches){
		try { await require('./orderStore').cancel(tenantId, m.id); } catch {}
	}
}

// Support both signatures: (tenantId, client, msg) and (client, msg)
async function manejarMensajeTenant(a, b, c){
	let tenantId, client, msg;
	if (typeof a === 'string' && b && c) { tenantId = a; client = b; msg = c; }
	else { tenantId = 'samuel'; client = a; msg = b; }
	// Inicialización de variables al inicio
	const text = (msg?.body||'').toString();
	const phone = String(msg?.from||'').replace(/@.*/, '');
	const lower = norm(text);
	let session = {};
	try { session = await convStore.readConv(tenantId, phone) || {}; } catch {}
		const activeSessionStage = session?.state?.stage;
		const activeInternalStage = sessionToInternalStage(activeSessionStage);
		let conv = runtime.getState(tenantId, phone);
		const inFlow = Boolean(activeSessionStage) || (conv && conv.stage && conv.stage !== 'none');
		const lastAsk = session?.lastAsk || null;
		const cfg=await getConfig(tenantId); const msgs=cfg.messages||{};
		const sizes=getAllowedSizes(cfg); const flavors=cfg.catalog?.flavors||cfg.flavors||[]; const keywords=cfg.keywords||{};
	// --- LOG: Stage y sesión al recibir mensaje ---
	console.log(`[LOG] [${tenantId}] Mensaje recibido de ${msg.from}: "${msg.body}"`);
	console.log(`[LOG] [${tenantId}] Stage actual para ${phone}: ${activeSessionStage}`);
	// Detección de múltiples sesiones activas (por error)
	if (session && session.state && Array.isArray(session.state)) {
		console.warn(`[WARN] [${tenantId}] Varias sesiones activas para ${phone}:`, session.state);
	}
	// Solo envía el menú al chat que lo pide explícitamente
	function isGreeting(text) {
		const t = (text||'').toString().trim().toLowerCase();
		// Only these: menu/menú, pedido, hola, buenos dias/días
		return /^(menu|menú|pedido|hola|buenos dias|buenos días)$/i.test(t);
	}
			if (isGreeting(msg.body) && (conv && conv.stage === 'none')) {
					if(shouldShowFullMenu(session, lower)){
						console.log(`[LOG] [${tenantId}] Mostrando menú/bienvenida a ${phone} (sin flujo activo)`);
						await sendWelcomeAndMenu(client, msg.from, cfg);
						session.greetedAt = new Date().toISOString();
						session.lastMenuAt = Date.now();
						await convStore.writeConv(tenantId, phone, session);
					}
					return null;
			}
	// Nota: no interceptar aquí. Dejamos que el switch-case de etapas maneje el flujo más abajo.
	// Si no está en flujo activo y no pide menú, sigue con lógica de inicio/menu/idle
	// ...existing code for idle/menu...

	// Greeting logic: mostrar menú SOLO ante palabras clave explícitas (no envíos proactivos)
	try{
		const sess = session;
		const greetWords = /^(menu|menú|pedido|hola|buenos dias|buenos días)$/i;
		if(greetWords.test(lower) && (conv && conv.stage === 'none')){
			if(shouldShowFullMenu(sess, lower)){
				await sendWelcomeAndMenu(client, msg.from, cfg);
				sess.greetedAt = new Date().toISOString();
				sess.lastMenuAt = Date.now();
				await convStore.writeConv(tenantId, phone, sess);
			}
			return null;
		}
	}catch{}

  // --- New: Quick menu triggers and delete-by-phone flow ---
  try {
	let menuState = await convStore.readConv(tenantId, phone);
		const backWords = new Set(['atrás','atras']);
		const isMenuKeyword = (lower==='menu' || lower==='menú' || lower==='inicio');
		// Allow exact greeting keywords to show menu even during active flow
		const greetKeywords = new Set(['hola','buenas','buenos dias','buenos días','pedido']);
		const isGreetingOnly = (lower==='hola' || lower==='buenas');

		// Manual: "cancelar <telefono>" / "anular <telefono>" / "borrar <telefono>"
		const manualCancel = /^\s*(cancel(?:ar)?|anular|borrar)\s+([^]+)$/i.exec(text || '');
		if(manualCancel){
			const raw = manualCancel[2] || '';
			const digits = raw.replace(/\D/g,'');
			const tel9 = digits.slice(-9);
			if(tel9.length!==9){
				const txt = msgs.invalid_phone || 'Formato de teléfono inválido. Deben ser 9 dígitos.';
				{
					const preview = String(txt).slice(0,80);
					console.log('[SEND]', phone, preview);
					try { await client.sendMessage(msg.from, String(txt)); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
				}
				return null;
			}
			const matches = await findPendingByPhone(tenantId, tel9);
			const confirmedMatches = (matches||[]).filter(m=> String(m.status||'').toLowerCase()==='confirmed');
			if(!confirmedMatches || confirmedMatches.length===0){
				const txt = msgs.only_cancel_confirmed || 'Solo puedes cancelar pedidos confirmados. Si tu pedido está pendiente, espera confirmación.';
				{
					const preview = String(txt).slice(0,80);
					console.log('[SEND]', phone, preview);
					try { await client.sendMessage(msg.from, String(txt)); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
				}
				// Volver a menú
						try { await convStore.writeConv(tenantId, phone, {}); } catch{}
						try { runtime.setState(tenantId, phone, { stage:'none', data:{}, flow:'none', welcomed: menuState && menuState.welcomed, lastWelcomeAt: menuState && menuState.lastWelcomeAt }); } catch{}
				await sendWelcomeAndMenu(client, msg.from, cfg);
				return null;
			}
			try {
				const sess = await convStore.readConv(tenantId, phone) || {};
				sess.del_list = confirmedMatches.map(m=> String(m.id));
				sess.tel = tel9;
				sess.state = { flow:'delete_order', stage:'delete_by_phone' };
				sess.lastAsk = { stage:'delete_by_phone', ts: Date.now() };
				await convStore.writeConv(tenantId, phone, sess);
			} catch{}
			const headerBase = (msgs.delete_found || 'He encontrado {count} pedido(s) para el teléfono {telefono}:')
				.replace('{count}', String(confirmedMatches.length))
				.replace('{telefono}', tel9);
			const blocks = confirmedMatches.map(o=>`Pedido ID ${o.id}\n${summarizeStoredOrder(o)}`);
			const tail = msgs.delete_confirm || '¿Este es tu pedido? ¿Seguro que quieres cancelar? (sí/no)';
			const out = [headerBase, ...blocks, tail].join('\n\n');
			{
				const preview = String(out).slice(0,80);
				console.log('[SEND]', phone, preview);
				try { await client.sendMessage(msg.from, out); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
			}
			return null;
		}

		// Global interrupt: menu or greeting keywords -> show menu
		if (isMenuKeyword || (inFlow && greetKeywords.has(lower))){
			if(inFlow){
			{
				const preview = String(msgs.menu_short || '1) Generar pedido\n2) Cancelar un pedido\n3) Modificar un pedido\n4) ¿Dónde estamos?').slice(0, 80);
				console.log('[SEND]', phone, preview);
				try {
					await client.sendMessage(msg.from, String(msgs.menu_short || '1) Generar pedido\n2) Cancelar un pedido\n3) Modificar un pedido\n4) ¿Dónde estamos?'));
				} catch (e) {
					console.error('[SEND][ERROR]', e && e.message);
				}
			}
				return null;
			}
					await convStore.writeConv(tenantId, phone, {});
			try {
				const wasWelcomed = conv?.welcomed; const lastW = conv?.lastWelcomeAt;
				runtime.setState(tenantId, phone, { stage:'none', data:{}, welcomed:wasWelcomed, lastWelcomeAt:lastW, flow:'none' });
			} catch{}
					await sendWelcomeAndMenu(client, msg.from, cfg);
					try{ const s=await convStore.readConv(tenantId, phone) || {}; s.lastMenuAt=Date.now(); await convStore.writeConv(tenantId, phone, s); }catch{}
			return null;
		}

		// Greetings-only or back when idle -> just show welcome+menu (only if not in-flow)
		if (isGreetingOnly || (backWords.has(lower) && (!conv.stage || conv.stage==='none'))){
			if(!inFlow){
				await convStore.writeConv(tenantId, phone, {});
				await sendWelcomeAndMenu(client, msg.from, cfg);
			}
			return null;
		}

	// Define idle state helper (no active stage)
	const isIdle = (!conv.stage || conv.stage==='none');

		// New delete-by-phone staged flow
		if(conv.stage === 'delete_by_phone'){
			// If we already have list cached, we're expecting a yes/no
			if(menuState && Array.isArray(menuState.del_list) && menuState.del_list.length){
				if(/^\s*s[ií]\s*$/i.test(text)){
					try {
						const res = await orderStore.moveToCanceled(tenantId, menuState.del_list);
						{
							const preview = String(msgs.delete_done || 'Pedido(s) borrado(s).').slice(0, 80);
							console.log('[SEND]', phone, preview);
							try {
								await client.sendMessage(msg.from, msgs.delete_done || 'Pedido(s) borrado(s).');
							} catch (e) {
								console.error('[SEND][ERROR]', e && e.message);
							}
						}
					} catch {
						{
							const preview = 'No se pudo cancelar. Intenta más tarde.';
							console.log('[SEND]', phone, preview);
							try {
								await client.sendMessage(msg.from, 'No se pudo cancelar. Intenta más tarde.');
							} catch (e) {
								console.error('[SEND][ERROR]', e && e.message);
							}
						}
					}
					// clear temp and return to start
					try { await convStore.writeConv(tenantId, phone, {}); } catch {}
					try { runtime.setState(tenantId, phone, { stage:'none', data:{}, flow:'none', welcomed:conv.welcomed, lastWelcomeAt:conv.lastWelcomeAt }); } catch {}
					return null;
				}
				if(/^\s*no\s*$/i.test(text)){
					const abortMsg = msgs.delete_aborted || 'Operación cancelada. No se ha cancelado ningún pedido.';
					{
						const preview = String(abortMsg).slice(0, 80);
						console.log('[SEND]', phone, preview);
						try { await client.sendMessage(msg.from, abortMsg); } catch (e) { console.error('[SEND][ERROR]', e && e.message); }
					}
					try { await convStore.writeConv(tenantId, phone, {}); } catch {}
					try { runtime.setState(tenantId, phone, { stage:'none', data:{}, flow:'none', welcomed:conv.welcomed, lastWelcomeAt:conv.lastWelcomeAt }); } catch {}
					try {
						await sendWelcomeAndMenu(client, msg.from, cfg);
						const sess = await convStore.readConv(tenantId, phone) || {};
						sess.lastMenuAt = Date.now();
						await convStore.writeConv(tenantId, phone, sess);
					} catch{}
					return null;
				}
				{
					const preview = String(msgs.confirm_yesno || 'Responde sí o no, por favor.').slice(0, 80);
					console.log('[SEND]', phone, preview);
					try {
						await client.sendMessage(msg.from, msgs.confirm_yesno || 'Responde sí o no, por favor.');
					} catch (e) {
						console.error('[SEND][ERROR]', e && e.message);
					}
				}
				return null;
			}
			// Exit keywords while asking for the phone
			const low = lower;
			if(/^(cancelar|cancel|anular)$/i.test(low)){
				try { await convStore.writeConv(tenantId, phone, {}); } catch {}
				try { runtime.setState(tenantId, phone, { stage:'none', data:{}, flow:'none', welcomed: conv.welcomed, lastWelcomeAt: conv.lastWelcomeAt }); } catch {}
				{
					const preview = String(msgs.canceled || 'Operación cancelada.').slice(0, 80);
					console.log('[SEND]', phone, preview);
					try {
						await client.sendMessage(msg.from, msgs.canceled || 'Operación cancelada.');
					} catch (e) {
						console.error('[SEND][ERROR]', e && e.message);
					}
				}
				return null;
			}
			if(/^(menu|menú)$/i.test(low)){
				try { await convStore.writeConv(tenantId, phone, {}); } catch {}
				try { runtime.setState(tenantId, phone, { stage:'none', data:{}, flow:'none', welcomed: conv.welcomed, lastWelcomeAt: conv.lastWelcomeAt }); } catch {}
				await sendWelcomeAndMenu(client, msg.from, cfg);
				return null;
			}
			if(/^(atrás|atras)$/i.test(low)){
				{
					const preview = String(msgs.ask_delete_phone || 'Dime el número de teléfono (9 dígitos) del pedido a cancelar.').slice(0, 80);
					console.log('[SEND]', phone, preview);
					try {
						await client.sendMessage(msg.from, msgs.ask_delete_phone || 'Dime el número de teléfono (9 dígitos) del pedido a cancelar.');
					} catch (e) {
						console.error('[SEND][ERROR]', e && e.message);
					}
				}
				return null;
			}

			// Else, we expect the phone input here
			if(!/^\d{9}$/.test(lower)){
				{
					const preview = String(msgs.invalid_phone || 'Formato de teléfono inválido. Deben ser 9 dígitos.').slice(0, 80);
					console.log('[SEND]', phone, preview);
					try {
						await client.sendMessage(msg.from, msgs.invalid_phone || 'Formato de teléfono inválido. Deben ser 9 dígitos.');
					} catch (e) {
						console.error('[SEND][ERROR]', e && e.message);
					}
				}
				return null;
			}
			// Buscar pedidos por teléfono y pedir confirmación
			const matches = await findPendingByPhone(tenantId, lower);
						if(!matches || matches.length === 0){
								const txt = msgs.no_pedidos_para_telefono || 'No hay pedidos pendientes para ese teléfono.';
								{
										const preview = String(txt).slice(0,80);
										console.log('[SEND]', phone, preview);
										try { await client.sendMessage(msg.from, String(txt)); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
								}
								// Reset a idle y mostrar menú para continuar
								try {
									await convStore.writeConv(tenantId, phone, {});
								} catch{}
								try { runtime.setState(tenantId, phone, { stage:'none', data:{}, flow:'none', welcomed:conv.welcomed, lastWelcomeAt:conv.lastWelcomeAt }); } catch{}
								try {
									await sendWelcomeAndMenu(client, msg.from, cfg);
									const sess = await convStore.readConv(tenantId, phone) || {};
									sess.lastMenuAt = Date.now();
									sess.greetedAt = new Date().toISOString();
									await convStore.writeConv(tenantId, phone, sess);
								} catch{}
								return null;
						}
			// Persist list of ids and keep stage awaiting yes/no
			try {
				const sess = await convStore.readConv(tenantId, phone) || {};
				sess.del_list = matches.map(m=> String(m.id));
				sess.tel = lower;
				sess.state = { flow:'delete_order', stage:'delete_by_phone' };
				sess.lastAsk = { stage:'delete_by_phone', ts: Date.now() };
				await convStore.writeConv(tenantId, phone, sess);
			} catch{}
			// Build detailed preview
			const headerBase = (msgs.delete_found || 'He encontrado {count} pedido(s) pendiente(s) para el teléfono {telefono}:')
			  .replace('{count}', String(matches.length))
			  .replace('{telefono}', lower);
			const blocks = matches.map(o=>`Pedido ID ${o.id}\n${summarizeStoredOrder(o)}`);
			const tail = msgs.delete_confirm || '¿Este es tu pedido? ¿Seguro que quieres cancelar? (sí/no)';
			const out = [headerBase, ...blocks, tail].join('\n\n');
			{
				const preview = String(out).slice(0,80);
				console.log('[SEND]', phone, preview);
				try { await client.sendMessage(msg.from, out); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
			}
			return null;
		}

		// In-flow pedido -> resume current stage without restarting
		if (inFlow && (lower==='pedido' || lower==='generar' || lower==='nuevo pedido')){
			const stageToPrompt = activeInternalStage || conv.stage || 'ask_size';
			const prompt = genPromptForStage(cfg, conv, msgs, stageToPrompt) || (msgs.menu_short || buildMenu(cfg));
			// Prompt debounce (30s same prompt, not yet answered)
			if(shouldSkipPromptDueToDebounce(session, prompt)){
				return null;
			}
			try {
				const fresh = await convStore.readConv(tenantId, phone) || {};
				await convStore.writeConv(tenantId, phone, { ...fresh, lastAsk: { stage: activeSessionStage, ts: Date.now() } });
			} catch {}
			await setLastPrompt(tenantId, phone, prompt);
			{
				const preview = String(prompt).slice(0, 80);
				console.log('[SEND]', phone, preview);
				try {
					await client.sendMessage(msg.from, String(prompt));
				} catch (e) {
					console.error('[SEND][ERROR]', e && e.message);
				}
			}
			return null;
		}

	// Interpret 1/2/3 selections ONLY when idle (menu context)
		if(isIdle && ['1','generar','pedido','nuevo pedido'].includes(lower)){
			// Reset any menu/delete transient state and start a fresh order flow
			await convStore.writeConv(tenantId, phone, {});
			// Initialize runtime state for new order
			const next = {
				stage: 'ask_size',
				data: {},
				startedAt: Date.now(),
				welcomed: conv.welcomed,
				lastWelcomeAt: conv.lastWelcomeAt,
				flow: 'new_order'
			};
			runtime.setState(tenantId, phone, next);
			try {
				const fresh = await convStore.readConv(tenantId, phone) || {};
				await convStore.writeConv(tenantId, phone, {
					...fresh,
					state: { flow:'new_order', stage: 'ask_tamano' },
					lastAsk: { stage: 'ask_tamano', ts: Date.now() }
				});
			} catch {}
			// Auto-poner teléfono desde el remitente y saltar a tamaño directamente
			try {
				const senderDigits = String(phone).replace(/\D/g,'');
				const tel9 = senderDigits.slice(-9);
				const st = runtime.getState(tenantId, phone) || next;
				st.data = { ...(st.data||{}), telefono: tel9 };
				runtime.setState(tenantId, phone, st);
			} catch{}
			const prompt = buildSizeQuestion(cfg);
			await sendPrompt(tenantId, client, msg.from, session, prompt, { bypassDebounce: true });
			return null;
		}

						if(isIdle && ['2','borrar','eliminar'].includes(lower)){
								// Auto-uso del número del remitente para buscar y pedir confirmación
								try { await convStore.writeConv(tenantId, phone, {}); } catch {}
								runtime.setState(tenantId, phone, { stage:'delete_by_phone', data:{}, flow:'delete_order', welcomed:conv.welcomed, lastWelcomeAt:conv.lastWelcomeAt });
								const senderTel = phone.replace(/\D/g,'').slice(-9);
								const matches = await findPendingByPhone(tenantId, senderTel);
								const confirmedMatches = (matches||[]).filter(m=> String(m.status||'').toLowerCase()==='confirmed');
								if(!confirmedMatches || confirmedMatches.length===0){
									const txt = msgs.only_cancel_confirmed || 'Solo puedes cancelar pedidos confirmados. Si tu pedido está pendiente, espera confirmación.';
									{
										const preview = String(txt).slice(0,80);
										console.log('[SEND]', phone, preview);
										try { await client.sendMessage(msg.from, String(txt)); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
									}
									// back to idle + menu
									try { await convStore.writeConv(tenantId, phone, {}); } catch{}
									try { runtime.setState(tenantId, phone, { stage:'none', data:{}, flow:'none', welcomed:conv.welcomed, lastWelcomeAt:conv.lastWelcomeAt }); } catch{}
									await sendWelcomeAndMenu(client, msg.from, cfg);
									return null;
								}
								try {
									const sess = await convStore.readConv(tenantId, phone) || {};
									sess.del_list = confirmedMatches.map(m=> String(m.id));
									sess.tel = senderTel;
									sess.state = { flow:'delete_order', stage:'delete_by_phone' };
									sess.lastAsk = { stage:'delete_by_phone', ts: Date.now() };
									await convStore.writeConv(tenantId, phone, sess);
								} catch{}
								const headerBase = (msgs.delete_found || 'He encontrado {count} pedido(s) para el teléfono {telefono}:')
									.replace('{count}', String(confirmedMatches.length))
									.replace('{telefono}', senderTel);
								const blocks = confirmedMatches.map(o=>`Pedido ID ${o.id}\n${summarizeStoredOrder(o)}`);
								const tail = msgs.delete_confirm || '¿Este es tu pedido? ¿Seguro que quieres cancelar? (sí/no)';
								const out = [headerBase, ...blocks, tail].join('\n\n');
								{
									const preview = String(out).slice(0,80);
									console.log('[SEND]', phone, preview);
									try { await client.sendMessage(msg.from, out); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
								}
								return null;
			}

		if(isIdle && ['4','donde','dónde','direccion','dirección','ubicacion','ubicación','mapa','maps'].includes(lower)){
				const address = cfg.address || 'C. Abián, 4, 35212 Marpequeña, Las Palmas';
				const txt = (msgs.address || address || 'Dirección no configurada 📍');
				{
					const preview = String(txt).slice(0, 80);
					console.log('[SEND]', phone, preview);
					try {
						await client.sendMessage(msg.from, String(txt));
					} catch (e) {
						console.error('[SEND][ERROR]', e && e.message);
					}
				}
			// Flow marker (informational)
			try { runtime.setState(tenantId, phone, { ...conv, flow: 'where' }); } catch{}
      return null;
    }

		// Option 4: Reviews
		if(isIdle && ['4','reseña','resena','review','opinión','opinion'].includes(lower)){
			const link = cfg.review_link || 'https://g.page/r/CWjO3W1N3j7lEBM/review';
			const txt = msgs.review || `¿Nos ayudas con una reseña? ⭐ ${link}`;
			{
				const preview = String(txt).slice(0, 80);
				console.log('[SEND]', phone, preview);
				try { await client.sendMessage(msg.from, String(txt)); } catch(e){ console.error('[SEND][ERROR]', e && e.message); }
			}
			try { runtime.setState(tenantId, phone, { ...conv, flow: 'review' }); } catch{}
			return null;
		}

    // If user writes "pedido" directly, let existing flow handle it.
	if(lower.startsWith('pedido')){
      // no-op here
      // continue into existing flow below so that order trigger is processed
    }
  } catch(e){ console.error(`[${tenantId}] menu/delete flow error`, e); }

	// Back navigation
	const backSet=new Set(['atras','atrás','volver','back']);
	if(backSet.has(lower) && conv.stage && conv.stage!=='none'){
	const order=['ask_size','ask_flavors','ask_qty','ask_date','ask_obs','ask_more','confirm'];
		const idx=order.indexOf(conv.stage);
		if(idx>0){
			const newStage=order[idx-1];
			conv.stage=newStage;
				runtime.setState(tenantId, phone, conv);
				// Persist session stage and lastAsk
				try {
					const ss = internalToSessionStage(newStage);
					const fresh = await convStore.readConv(tenantId, phone) || {};
					await convStore.writeConv(tenantId, phone, {
						...fresh,
						state: { flow:'new_order', stage: ss },
						lastAsk: { stage: ss, ts: Date.now() }
					});
				} catch {}
			// regenerate prompt for that stage without mutating collected data (user can overwrite)
				switch(newStage){
					case 'ask_size': { 
						const prompt = buildSizeQuestion(cfg);
						if(shouldSkipPromptDueToDebounce(session, prompt)) return null;
						await setLastPrompt(tenantId, phone, prompt);
						return prompt; 
					}
				case 'ask_flavors': {
					return (msgs.ask_sabores||'Elige sabores (separa con comas):') + renderFlavorList(cfg);
				}
				case 'ask_qty': {
					const st=conv.selectedSize?.type;
					if(st==='cajitas') return msgs.ask_cantidad_cajitas||'¿Cantidad de cajitas? (1-50) 📦';
					return msgs.ask_cantidad_entera||'¿Cantidad? (1-20) 🔢';
				}
				case 'ask_date': {
					const base = msgs.ask_fecha || buildAskDatePrompt();
					const sched = cfg.messages?.pickup_schedule ? ('\n\n' + cfg.messages.pickup_schedule) : '';
					return base + sched;
				}
				case 'ask_obs': return msgs.ask_obs||'📝 Observaciones (escribe "no" si no hay)'
;
				case 'confirm': {
					const tpl=(msgs.confirm||'Confirma pedido: {tamano} {fecha} Total {total}€');
					const cantidad=(conv.data.cantidad||1);
					const summary=tpl
						.replace('{nombre}',conv.data.nombre||'')
						.replace('{telefono}',conv.data.telefono||'')
						.replace('{tamano}',conv.selectedSize?.label||conv.data.tamano||'')
						.replace('{cantidad}',String(cantidad))
						.replace('{sabores}',(conv.data.sabores||[]).join(', '))
						.replace('{fecha}',conv.data.fecha||'')
						.replace('{total}',String(conv.total||0));
					return summary+'\n'+(msgs.confirm_yesno||'Responde sí o no.');
				}
			}
		}
	}

	// Cancelación global -> mover a "cancelados" (no borrar)
	const cancelSet=new Set([...(keywords.cancel||[]),'cancel','cancelar','anular'].map(norm));
		if(cancelSet.has(lower)){
				try{
					// Solo guardar en cancelados si hay al menos un ítem real en el pedido
					const hasItems = Array.isArray(conv?.items) && conv.items.length>0;
					if(hasItems){
						const orders=require('./orderStore');
						await orders.append(tenantId,{
							status:'canceled',
							customer:{ name:conv.data?.nombre||'', phone:conv.data?.telefono||'' },
							fields:{ ...conv.data, items: conv.items, tamano: (conv.selectedSize?.label||conv.data?.tamano||'') },
							total: conv.items.reduce((acc,it)=> acc + (Number(it.total)||0), 0)
						});
					}
				}catch{}
				// Clear any temporary delete list from session
				try{
					const sess = await convStore.readConv(tenantId, phone) || {};
					if(Object.prototype.hasOwnProperty.call(sess, 'del_list')){
						delete sess.del_list;
						await convStore.writeConv(tenantId, phone, sess);
					}
				} catch{}
				// Reset runtime state to idle
				try{ const wasWelcomed=conv.welcomed, lastW=conv.lastWelcomeAt; runtime.setState(tenantId, phone,{stage:'none',data:{},welcomed:wasWelcomed,lastWelcomeAt:lastW}); } catch{}
				return msgs.canceled || 'Pedido cancelado y movido a la lista de cancelados.';
		}

	// Stage none / idle
if(conv.stage==='none'){
    const orderWords=(keywords.order||[]).map(norm);
    // Cambiado: isOrderTrigger ya NO reacciona a "1" ni a "pedido"
    // const isOrderTrigger = orderWords.some(w=> lower.includes(w)) || /^pedido(s)?$/.test(lower) || /^1$/.test(lower);
	const isOrderTrigger = orderWords.some(w=> lower.includes(w));
	const isDeleteTrigger = /^2$/.test(lower) || /borrar|eliminar/.test(lower);
	const isModifyTrigger = /^3$/.test(lower) || /modificar|editar|cambiar/.test(lower);
	const isWhereTrigger = /^4$/.test(lower) || /donde|dónde|direccion|dirección/.test(lower);
    const isMenuExplicit = (keywords.menu||[]).map(norm).some(w=> lower.includes(w));
    if(isOrderTrigger){
	runtime.setState(tenantId, phone,{stage:'ask_size',data:{},startedAt:Date.now(),welcomed:conv.welcomed,lastWelcomeAt:conv.lastWelcomeAt});
	// Auto-set phone
	try{ const tel9 = String(phone).replace(/\D/g,'').slice(-9); const st=runtime.getState(tenantId, phone)||{}; st.data={...(st.data||{}), telefono: tel9}; runtime.setState(tenantId, phone, st);}catch{}
	const prompt = buildSizeQuestion(cfg);
        if(shouldSkipPromptDueToDebounce(session, prompt)) return null;
        await setLastPrompt(tenantId, phone, prompt);
        return prompt;
    }
    if(isDeleteTrigger){
        runtime.setState(tenantId, phone,{stage:'delete_by_phone',data:{},welcomed:conv.welcomed,lastWelcomeAt:conv.lastWelcomeAt});
        return msgs.ask_borrar || 'Indica el teléfono del pedido a borrar:';
    }
	if(isModifyTrigger){
		const tel9 = String(phone).replace(/\D/g,'').slice(-9);
		const orders = require('./orderStore');
		const existing = await orders.findLatestByPhone(tenantId, tel9);
		if(!existing){
			return 'No encontré pedidos para tu número. Escribe "pedido" para crear uno nuevo.';
		}
		if(String(existing.status||'').toLowerCase()!=='confirmed'){
			return 'Solo puedes modificar pedidos confirmados. Tu pedido aún está pendiente ⏳.';
		}
		// Parse existing pickup date and enforce 3-day rule
		const norm = (s)=> String(s||'').trim().replace(/[\\/]/g,'-');
		const toDate = (s)=>{
			const p = norm(s).split('-').filter(Boolean).map(Number);
			const today=new Date(); today.setHours(0,0,0,0);
			if(p.length===2) return new Date(today.getFullYear(), (p[1]||1)-1, p[0]||1);
			if(p.length===3) return new Date(p[2], (p[1]||1)-1, p[0]||1);
			return null;
		};
		const dt = toDate(existing?.fields?.fecha);
		if(!dt){
			return 'No pude leer la fecha de recogida del pedido. Dímela por aquí y lo gestionamos manualmente.';
		}
		const today = new Date(); today.setHours(0,0,0,0);
		const diff = Math.round((dt - today)/86400000);
		if(diff < 3){
			return 'Solo podemos modificar pedidos con al menos 3 días de antelación a la recogida.';
		}
		// Announce restart once
		await client.sendMessage(msg.from, 'Perfecto 👍 Empezamos un pedido nuevo a partir del anterior. Indica de nuevo lo que quieres.');
		// Store target id and phone, then move to ask_size
		const st = runtime.getState(tenantId, phone) || { stage:'none', data:{} };
		st.modifyTargetId = String(existing.id);
		st.data = { ...(st.data||{}), telefono: String(existing?.customer?.phone || phone).replace(/\D/g,'').slice(-9) };
		st.stage = 'ask_size';
		st.flow = 'new_order';
		runtime.setState(tenantId, phone, st);
		try { await saveSessionState(tenantId, phone, 'ask_size'); } catch{}
		// Send size prompt via helper (debounce bypass to ensure single send now)
		await sendPrompt(tenantId, client, msg.from, session, buildSizeQuestion(cfg), { bypassDebounce: true });
		return null;
	}
    if(isWhereTrigger){
        return msgs.direccion || cfg.direccion || 'Estamos en: [dirección no configurada]';
    }
    if(isMenuExplicit){
        await sendWelcomeAndMenu(client, msg.from, cfg);
        return null;
    }
    // Sin palabras clave: no enviar nada proactivamente
    return null; // ignore
}


	switch(conv.stage){
		// removed ask_name stage
		case 'ask_size': {
			const trimmed = text.trim();
			const alias = (cfg.options && cfg.options.tamano_alias) || {};
			let key = alias[trimmed];
			if(!key){
				const t = trimmed.toLowerCase();
				if(/grande|tarta/.test(t)) key = 'grande';
				else if(/cajita|cajitas/.test(t)) key = 'cajitas';
				else if(/^[1-9]\d*$/.test(t)){
					// numeric selection by index in catalog sizes (1-based)
					const idx = Number(t)-1;
					const sz = Array.isArray(cfg.catalog?.sizes)? cfg.catalog.sizes[idx] : null;
					if(sz && sz.id) key = sz.id;
				}
			}
			if(!key){
				// anti-duplicate ask guard: throttle same prompt briefly
										if(!(lastAsk && lastAsk.stage==='ask_tamano' && (Date.now() - (lastAsk.ts||0) < 2000))){
											try { await convStore.writeConv(tenantId, phone, { ...session, lastAsk: { stage: 'ask_tamano', ts: Date.now() } }); } catch {}
										}
										const prompt = (msgs.ask_tamano || buildSizeQuestion(cfg));
										await sendPrompt(tenantId, client, msg.from, session, prompt);
										return null;
			}
			// Build a selectedSize object compatible with later logic
			const precios = (cfg.options && cfg.options.precios) || {};
			const sizeRec = Array.isArray(cfg.catalog?.sizes)? cfg.catalog.sizes.find(s=> String(s.id).toLowerCase()===String(key).toLowerCase()) : null;
			const price = (sizeRec && sizeRec.price != null) ? sizeRec.price : precios[key];
			const sel = {
				id: key,
				label: (sizeRec && sizeRec.label) ? sizeRec.label : (typeof price!=='undefined' ? `${key} (${price}€)` : key),
				type: (sizeRec && sizeRec.type) ? sizeRec.type : (key==='cajitas' ? 'cajitas' : 'entera'),
				price: price
			};
			conv.data.tamano = key;
			conv.selectedSize = sel;
			console.log(`[LOG] [${tenantId}] Guardando tamaño para ${phone}: "${key}"`);
				const newState = { ...conv, stage: 'ask_flavors' };
			runtime.setState(tenantId, phone, newState);
			console.log('[STATE]', phone, '->', newState.stage);
			try { await saveSessionState(tenantId, phone, 'ask_flavors'); } catch {}
			await markLastPromptAnswered(tenantId, phone);
				await sendPrompt(tenantId, client, msg.from, session, (msgs.ask_sabores||'Elige sabores (separa con comas):') + renderFlavorList(cfg));
				return null;
		}
			case 'ask_flavors': {
				const fmap = canonicalFlavorMap(cfg);
				const list = String(text||'').split(',').map(s=>s.trim()).filter(Boolean);
				if(list.length===0){
					return (msgs.ask_sabores||'Elige sabores (separa con comas):') + renderFlavorList(cfg);
				}
				const resolved = resolveFlavors(list, fmap);
				if(!resolved.ok){
					return `Sabor no reconocido: ${resolved.bad}. Usa solo los de la lista mostrada.`;
				}
				conv.data.sabores = resolved.flavors;
				await markLastPromptAnswered(tenantId, phone);
				const nextState = { ...conv, stage: 'ask_qty' };
				runtime.setState(tenantId, phone, nextState);
				try { await saveSessionState(tenantId, phone, 'ask_qty'); } catch {}
				const st = conv.selectedSize?.type;
				let promptQty;
				if(st==='cajitas') promptQty = msgs.ask_cantidad_cajitas||'¿Cantidad de cajitas? (1-50) 📦';
				else promptQty = msgs.ask_cantidad_entera||'¿Cantidad? (1-20) 🔢';
				await sendPrompt(tenantId, client, msg.from, session, promptQty);
				return null;
			}
		case 'ask_qty': {
				const n=Number(lower);
				const st=conv.selectedSize?.type;
				if(!Number.isInteger(n)||n<1) return 'Cantidad inválida. Indica un número entero positivo.';
				if(st==='cajitas'){
				if(n>50) return 'Máximo 50 cajitas. Indica un número entre 1 y 50.';
				conv.data.cantidad=n;
				console.log(`[LOG] [${tenantId}] Guardando cantidad de cajitas para ${phone}: ${n}`);
			} else {
				if(n>50) return 'Máximo 50 unidades. Indica un número entre 1 y 50.';
				conv.data.cantidad=n;
				console.log(`[LOG] [${tenantId}] Guardando cantidad para ${phone}: ${n}`);
			}
			// If date already provided in previous items, skip asking date again
			if(conv.data && conv.data.fecha){
				const nextState = { ...conv, stage: 'ask_obs' };
				runtime.setState(tenantId, phone, nextState);
				console.log(`[LOG] [${tenantId}] Saltando fecha (ya definida) -> ask_obs para ${phone}`);
				try { await saveSessionState(tenantId, phone, 'ask_obs'); } catch {}
				await sendPrompt(tenantId, client, msg.from, session, msgs.ask_obs||'Observaciones (escribe "no" si no hay)');
				return null;
			}
			const newState = { ...conv, stage: 'ask_date' };
			runtime.setState(tenantId, phone, newState);
			console.log(`[LOG] [${tenantId}] Avanzando a stage: ask_date para ${phone}`);
			try { await saveSessionState(tenantId, phone, 'ask_date'); } catch {}
			{
				const base = msgs.ask_fecha || buildAskDatePrompt();
				const sched = cfg.messages?.pickup_schedule ? ('\n\n' + cfg.messages.pickup_schedule) : '';
				await sendPrompt(tenantId, client, msg.from, session, base + sched);
			}
			return null;
		}
		case 'ask_date': {
			const dt = parseDDMMYYYY(text);
			if(!dt) return 'Formato de fecha no reconocido 😊. Usa DD-MM o DD/MM (ejemplo: 25-12).';
			const now = new Date(); now.setHours(0,0,0,0);
			const diffDays = (dt.getTime() - now.getTime())/86400000;
			if(diffDays < 3) return 'Gracias 🙌. Para preparar tu pedido necesitamos al menos 3 días. ¿Puedes indicar otra fecha a partir de dentro de 3 días?';
			let max = new Date(now); max.setMonth(max.getMonth()+3);
			if(max.getFullYear() > now.getFullYear()) max = new Date(now.getFullYear(), 11, 31);
			if(dt.getTime() > max.getTime()) return 'Gracias 🙌. Podemos agendar con hasta 3 meses de antelación. Indica una fecha dentro de los próximos 3 meses.';
			// Guardar sin año: DD-MM
			const pad=n=>String(n).padStart(2,'0');
			conv.data.fecha = `${pad(dt.getDate())}-${pad(dt.getMonth()+1)}`;
			console.log(`[LOG] [${tenantId}] Guardando fecha para ${phone}: "${conv.data.fecha}"`);
			const newState = { ...conv, stage: 'ask_obs' };
			runtime.setState(tenantId, phone, newState);
			console.log('[STATE]', phone, '->', newState.stage);
			try { await saveSessionState(tenantId, phone, 'ask_obs'); } catch {}
			await sendPrompt(tenantId, client, msg.from, session, msgs.ask_obs||'Observaciones (escribe "no" si no hay)');
			return null;
		}
		case 'ask_obs': {
			conv.data.observacion = (['no','ninguna'].includes(lower)) ? '' : text.trim();
			console.log(`[LOG] [${tenantId}] Guardando observación para ${phone}: "${conv.data.observacion}"`);
			if(conv.data.observacion.length>150) return 'Observación muy larga (máx 150). Indica otra más corta:';

			// Construir y agregar item actual a la lista temporal
			const item = buildOrderItem(conv, cfg);
			if(!Array.isArray(conv.items)) conv.items = [];
			conv.items.push(item);
			conv.total = conv.items.reduce((acc, it)=> acc + (Number(it.total)||0), 0);

			// Avanzar a preguntar si quiere añadir más
			const newState = { ...conv, stage: 'ask_more' };
			runtime.setState(tenantId, phone, newState);
			console.log('[STATE]', phone, '->', newState.stage);
			try { await saveSessionState(tenantId, phone, 'ask_more'); } catch {}
			await sendPrompt(tenantId, client, msg.from, session, msgs.ask_mas || '¿Quieres añadir algo más a tu pedido? (sí/no) ➕'
);
			return null;
		}
		case 'ask_more': {
			const yes = /^\s*(si|sí|s|yes|y)\s*$/i.test(lower);
			const no  = /^\s*(no|n)\s*$/i.test(lower);
				if(!yes && !no){
					await sendPrompt(tenantId, client, msg.from, session, msgs.ask_mas || '¿Quieres añadir más cosas a tu pedido? (sí/no) ➕'
);
					return null;
				}

			if(yes){
				// Reset de campos del item, conservar nombre/telefono
				delete conv.data.tamano;
				delete conv.data.cantidad;
				delete conv.data.sabores;
				delete conv.data.observacion;
				conv.selectedSize = undefined;

				const nextState = { ...conv, stage: 'ask_size' };
				runtime.setState(tenantId, phone, nextState);
				console.log('[STATE]', phone, '->', nextState.stage);
				try { await saveSessionState(tenantId, phone, 'ask_size'); } catch {}
				await sendPrompt(tenantId, client, msg.from, session, buildSizeQuestion(cfg));
				return null;
			}

			// no: resumen completo y confirmar
			const summary = summarizeItems(conv, cfg, msgs);
			const nextState = { ...conv, stage: 'confirm' };
			runtime.setState(tenantId, phone, nextState);
			console.log('[STATE]', phone, '->', nextState.stage);
			try { await saveSessionState(tenantId, phone, 'confirm'); } catch {}
			await sendPrompt(tenantId, client, msg.from, session, summary + '\n' + (msgs.confirm_yesno||'Responde sí o no.'));
			return null;
		}
		case 'confirm': {
			const yes=/^(si|sí|s|ok|vale|confirmo)$/i.test(lower);
			const no=/^(no|n)$/i.test(lower);
			if(no){
				const wasWelcomed=conv.welcomed, lastW=conv.lastWelcomeAt;
				// Resetear a idle sin guardar nada (ni pendiente ni cancelado)
				try { await saveSessionState(tenantId, phone, 'none'); } catch {}
				runtime.setState(tenantId, phone,{stage:'none',data:{},welcomed:wasWelcomed,lastWelcomeAt:lastW});
				return msgs.order_discarded || 'Listo, he cancelado el pedido. No se ha guardado nada.';
			}
			if(!yes) return (msgs.confirm_yesno||'👉 Responde *sí* o *no*.');
			// No permitir confirmar si no hay productos (tartas/cajitas)
			const items = Array.isArray(conv.items) ? conv.items : [];
			if(items.length===0){
				const warn = msgs.empty_order || 'Tu pedido está vacío. Añade al menos un producto. 🛒';
				// Volver a elegir tamaño para añadir el primer producto
				const nextState = { ...conv, stage: 'ask_size' };
				runtime.setState(tenantId, phone, nextState);
				try { await saveSessionState(tenantId, phone, 'ask_size'); } catch {}
				await sendPrompt(tenantId, client, msg.from, session, warn + '\n' + buildSizeQuestion(cfg), { bypassDebounce: true });
				return null;
			}
			const orders=require('./orderStore');
			const payloadFields = { items, ...conv.data };
			const total = items.reduce((acc,it)=>acc+(Number(it.total)||0),0);
			const stRuntime = runtime.getState(tenantId, phone) || {};
			if(stRuntime.modifyTargetId){
				try {
					await orders.cloneAsModifiedNew(tenantId, stRuntime.modifyTargetId, { customer:{ phone:conv.data.telefono }, fields: payloadFields, items, total });
				} catch(e){ await orders.add(tenantId,{ customer:{ phone:conv.data.telefono }, fields: payloadFields, total }); }
				// Clear modify flag
				try { delete stRuntime.modifyTargetId; runtime.setState(tenantId, phone, stRuntime); } catch{}
			} else {
				await orders.add(tenantId,{ customer:{ phone:conv.data.telefono }, fields: payloadFields, total });
			}
			const wasWelcomed=conv.welcomed,lastW=conv.lastWelcomeAt;
			try { await saveSessionState(tenantId, phone, 'confirm'); } catch {}
			runtime.setState(tenantId, phone,{stage:'none',data:{},welcomed:wasWelcomed,lastWelcomeAt:lastW});
			return (msgs.confirmed||'Pedido confirmado ✅').replace('{fecha}',conv.data.fecha||'');
		}
		default: {
			const wasWelcomed=conv.welcomed,lastW=conv.lastWelcomeAt;
			runtime.setState(tenantId, phone,{stage:'none',data:{},welcomed:wasWelcomed,lastWelcomeAt:lastW});
			return 'Reinicio. Escribe *pedido* para empezar.';
		}
	}
}

// Lifecycle helpers
function setLifecycle(tenantId, s){ const prev=lifecycle.get(tenantId)||{}; lifecycle.set(tenantId,{...prev,...s}); }
function getState(tenantId){ return lifecycle.get(tenantId)||{status:'stopped'}; }

// Los handlers de mensajes se atan únicamente en whatsappService.js (attachCoreHandlers o attachBotHandlers).
// No registrar aquí ningún client.on('message', ...).

async function startBot(tenantId){
	if(DISABLE_WA){
		console.log(`[botService] WA deshabilitado (DISABLE_WA=1). Simulando bot para tenant ${tenantId}.`);
		setLifecycle(tenantId,{status:'disabled',isReady:false});
		// Crear stub mínimo
		const stub = {
		  sendMessage: async ()=>{},
		  destroy: async ()=>{ setLifecycle(tenantId,{status:'stopped'}); }
		};
		clients.set(tenantId, stub);
		return stub;
	}
	const lib = ensureWA();
	if(!loggedTenants.has(tenantId)){ console.log('Using tenantId:',tenantId); loggedTenants.add(tenantId);} 
	if(clients.has(tenantId)) return clients.get(tenantId);
	let client;
	try {
		client=new lib.Client({
			authStrategy:new lib.LocalAuth({ clientId:tenantId, dataPath: AUTH_DIR }),
			puppeteer:{ headless:true, args: ['--no-sandbox','--disable-setuid-sandbox'] },
			qrMaxRetries: 1,
			restartOnAuthFail: false,
			takeoverOnConflict: true,
			takeoverTimeoutMs: 0,
		});
	} catch(e){
		console.error('[botService] Error creando Client()', e);
		setLifecycle(tenantId,{status:'error_client',isReady:false,error:e.message});
		throw e;
	}
	try {
	const { pushEvent } = require('../server');
	const emitStatus = (status, extra={})=>{ try { if(pushEvent) pushEvent('bot:status', { tenantId, status, ...extra }); } catch {} };
	client.on('qr', async qr=>{ try { const dataURL=await qrcode.toDataURL(qr); qrCache.set(tenantId,dataURL); } catch{} setLifecycle(tenantId,{status:'qr',isReady:false}); logger.appendEvent(tenantId,{type:'qr',ts:Date.now()}); emitStatus('qr'); });
	client.on('authenticated', ()=>{ setLifecycle(tenantId,{status:'authenticated',isReady:false}); logger.appendEvent(tenantId,{type:'authenticated',ts:Date.now()}); qrCache.delete(tenantId); emitStatus('authenticated'); });
	client.on('ready', ()=>{ setLifecycle(tenantId,{status:'ready',isReady:true}); logger.appendEvent(tenantId,{type:'ready',ts:Date.now()}); qrCache.delete(tenantId); emitStatus('ready'); });
	client.on('auth_failure', msg=>{ setLifecycle(tenantId,{status:'auth_failure',isReady:false,msg}); logger.appendEvent(tenantId,{type:'auth_failure',msg,ts:Date.now()}); clients.delete(tenantId); emitStatus('auth_failure',{ msg }); });
	client.on('disconnected', reason=>{ setLifecycle(tenantId,{status:'disconnected',isReady:false,reason}); logger.appendEvent(tenantId,{type:'disconnected',reason,ts:Date.now()}); clients.delete(tenantId); emitStatus('disconnected',{ reason }); });
			   // Handler de mensajes se ata en whatsappService.js
		setLifecycle(tenantId,{status:'starting',isReady:false});
		logger.appendEvent(tenantId,{type:'starting',ts:Date.now()});
		await client.initialize();
		clients.set(tenantId, client);
		return client;
	} catch(e){
		console.error('[botService] Error durante initialize()', e);
		setLifecycle(tenantId,{status:'error_init',isReady:false,error:e.message});
		try { await client.destroy().catch(()=>{}); } catch{}
		throw e;
	}
}

async function stopBot(tenantId){ const client=clients.get(tenantId); if(client){ await client.destroy(); clients.delete(tenantId);} lifecycle.delete(tenantId); qrCache.delete(tenantId); configCache.delete(tenantId); }
async function relink(tenantId){
	await stopBot(tenantId);
	const sess1 = path.join(AUTH_DIR, `session-${tenantId}`);
	const sess2 = path.join(AUTH_DIR, tenantId);
	try { if(fs.existsSync(sess1)) fs.rmSync(sess1, { recursive:true, force:true }); } catch{}
	try { if(fs.existsSync(sess2)) fs.rmSync(sess2, { recursive:true, force:true }); } catch{}
	return startBot(tenantId);
}
function getQR(tenantId){ if(qrCache.has(tenantId)) return qrCache.get(tenantId); const s=getState(tenantId); if(s.status==='qr') return qrCache.get(tenantId); return null; }
async function send(tenantId,to,text){ const client=clients.get(tenantId); if(!client) throw new Error('Bot not started'); const jid=to.endsWith('@c.us')?to:to.replace(/[^0-9]/g,'')+'@c.us'; return client.sendMessage(jid,text); }

async function destroyAllClients(){
  for (const client of clients.values()){
    try { await client.destroy(); } catch {}
  }
}

module.exports = { startBot, stopBot, relink, getQR, getState, send, getConfig, manejarMensajeTenant, DISABLE_WA, destroyAllClients };
