const path = require('path');
const fs = require('fs');
const botService = require('../services/botService');
const logger = require('../services/logger');
const { getEventBus, getLastQr } = require('../services/whatsappService');

exports.status = (req, res) => {
	const tenantId = req.tenantId;
	const state = botService.getState(tenantId);
	res.json({ ...state, isReady: state.status === 'ready' });
};

exports.qr = (req, res) => {
	// SSE QR stream
	const tenantId = req.tenantId;
	res.setHeader('Content-Type','text/event-stream');
	res.setHeader('Cache-Control','no-cache');
	res.setHeader('Connection','keep-alive');
	res.flushHeaders && res.flushHeaders();
	// heartbeat
	const hb = setInterval(()=>{ try{ res.write(':\n\n'); } catch(e){} }, 15000);

	// send last QR if any
	const last = getLastQr(tenantId);
	if(last){ try{ res.write(`event: qr\ndata: ${last}\n\n`); } catch(e){} }
	const bus = getEventBus(tenantId);
	const onQr = ()=>{ const q = getLastQr(tenantId); if(q){ try{ res.write(`event: qr\ndata: ${q}\n\n`); } catch(e){} } };
	const onAuth = ()=>{ try{ res.write('event: authenticated\ndata: {}\n\n'); } catch(e){} };
	const onReady = ()=>{ try{ res.write('event: ready\ndata: {}\n\n'); } catch(e){} };
	const onStatus = (data)=>{ try{ res.write(`event: status\ndata: ${JSON.stringify(data||{})}\n\n`); } catch(e){} };
	bus.on('qr', onQr);
	bus.on('authenticated', onAuth);
	bus.on('ready', onReady);
	bus.on('status', onStatus);
	req.on('close', ()=>{ clearInterval(hb); bus.off('qr', onQr); bus.off('authenticated', onAuth); bus.off('ready', onReady); bus.off('status', onStatus); try{ res.end(); } catch(e){} });
};
exports.start = async (req, res) => {
	const tenantId = req.tenantId;
	await botService.startBot(tenantId);
	res.json({ ok: true });
};

exports.relink = async (req, res) => {
	const tenantId = req.tenantId;
	await botService.relink(tenantId);
	res.json({ ok: true });
};

exports.stop = async (req, res) => {
	const tenantId = req.tenantId;
	await botService.stopBot(tenantId);
	res.json({ ok: true });
};

exports.debug = (req, res) => {
	const tenantId = req.tenantId;
	const hasClient = !!botService.getState(tenantId);
	const hasQR = !!botService.getQR(tenantId);
	const sessionDir = path.join(__dirname, '../sessions', tenantId);
	const eventsFile = path.join(__dirname, '../logs', tenantId, 'events.ndjson');
	const lastEvents = logger.readTailSafe(eventsFile, 10);
	res.json({ hasClient, hasQR, sessionDir, lastEvents });
};
