const express = require('express');
const router = express.Router();
const { getClientStateForTenant, ensureStarted, getLastQr, relinkTenant, relinkFresh, getEventBus, getStatus, stopTenant, startTenant } = require('../services/whatsappService');

router.get('/status', (req, res) => {
	const tenant = String(req.query.tenant||'').trim();
	if(!tenant) return res.status(400).json({ error:'tenant requerido' });
	const status = getStatus(tenant);
	return res.json({ ok:true, status });
});

router.post('/start', async (req, res) => {
	const tenant = String(req.query.tenant||'').trim();
	if(!tenant) return res.status(400).json({ error:'tenant requerido' });
	try { await startTenant(tenant); return res.json({ ok:true }); } catch(e){ return res.status(500).json({ error:e.message }); }
});

router.post('/stop', async (req, res) => {
	const tenant = String(req.query.tenant||'').trim();
	if(!tenant) return res.status(400).json({ error:'tenant requerido' });
	try { await stopTenant(tenant); return res.json({ ok:true }); } catch(e){ return res.status(500).json({ error:e.message }); }
});

router.post('/relink', async (req, res) => {
	const tenant = String(req.query.tenant || req.headers['x-tenant-id'] || '').trim();
	if(!tenant) return res.status(400).json({ error:'tenant requerido' });
	console.log(`[RELINK] tenant=${tenant}`);
	try {
		await relinkFresh(tenant);
		return res.json({ ok:true, status:'initializing' });
	} catch(e){
		console.error('[relinkFresh]', e);
		return res.status(500).json({ error:e.message });
	}
});

router.get('/qr', (req, res) => {
	const tenant = String(req.query.tenant||'').trim();
	if(!tenant) return res.status(400).json({ error:'tenant requerido' });

	// If client requests SSE, stream QR/auth/status events
	const wantsSSE = String(req.headers.accept||'').includes('text/event-stream');
	if(wantsSSE){
		res.setHeader('Content-Type','text/event-stream');
		res.setHeader('Cache-Control','no-cache');
		res.setHeader('Connection','keep-alive');
		if(res.flushHeaders) res.flushHeaders();
		// heartbeat every 15s
		const hb = setInterval(()=>{ try{ res.write(':\n\n'); } catch(e){} }, 15000);
		// send last QR if available
		const last = getLastQr(tenant);
		if(last){ try{ res.write(`event: qr\ndata: ${last}\n\n`); } catch(e){} }
		// wire bus
		const bus = getEventBus(tenant);
		const onQr = ()=>{ const q = getLastQr(tenant); if(q){ try{ res.write(`event: qr\ndata: ${q}\n\n`); } catch(e){} } };
		const onAuth = ()=>{ try{ res.write('event: authenticated\ndata: {}\n\n'); } catch(e){} };
		const onReady = ()=>{ try{ res.write('event: ready\ndata: {}\n\n'); } catch(e){} };
		const onStatus = (data)=>{ try{ res.write(`event: status\ndata: ${JSON.stringify(data||{})}\n\n`); } catch(e){} };
		bus.on('qr', onQr);
		bus.on('authenticated', onAuth);
		bus.on('ready', onReady);
		bus.on('status', onStatus);
		req.on('close', ()=>{ clearInterval(hb); bus.off('qr', onQr); bus.off('authenticated', onAuth); bus.off('ready', onReady); bus.off('status', onStatus); try{ res.end(); } catch(e){} });
		return; // keep connection open
	}

	// Fallback JSON response (non-SSE)
	const qr = getLastQr(tenant);
	if(!qr) return res.sendStatus(204);
	return res.json({ pngBase64: qr });
});

module.exports = router;
