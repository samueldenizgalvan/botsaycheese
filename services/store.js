const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');

function ensureDir(dir) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

async function readJSON(tenantId, relPath, def = {}) {
	const f = path.join(DATA_DIR, tenantId, relPath);
	try {
		await fs.promises.mkdir(path.dirname(f), { recursive: true });
		return JSON.parse(await fs.promises.readFile(f, 'utf8'));
	} catch {
		return def;
	}
}

async function writeJSON(tenantId, relPath, data) {
	const f = path.join(DATA_DIR, tenantId, relPath);
	await fs.promises.mkdir(path.dirname(f), { recursive: true });
	await fs.promises.writeFile(f, JSON.stringify(data, null, 2), 'utf8');
}

async function appendEvent(tenantId, obj) {
	const dir = path.join(DATA_DIR, tenantId, 'logs');
	ensureDir(dir);
	const file = path.join(dir, 'events.ndjson');
	await fs.promises.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
}

async function appendMessage(tenantId, obj) {
	const dir = path.join(DATA_DIR, tenantId, 'logs');
	ensureDir(dir);
	const file = path.join(dir, 'messages.ndjson');
	await fs.promises.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
}

async function pushRecord(tenantId, record) {
	const file = path.join(DATA_DIR, tenantId, 'pedidos.json');
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	let arr = [];
	try {
		arr = JSON.parse(await fs.promises.readFile(file, 'utf8'));
		if (!Array.isArray(arr)) arr = [];
	} catch {}
	arr.push(record);
	await fs.promises.writeFile(file, JSON.stringify(arr, null, 2), 'utf8');
}

module.exports = {
	DATA_DIR,
	ensureDir,
	readJSON,
	writeJSON,
	appendEvent,
	appendMessage,
	pushRecord
};

// Convenience helper for current in-memory conversation stage
async function getStage(tenantId, chatId){
	try {
		const rt = require('./conversationRuntime');
		const phone = String(chatId||'').replace(/@.*/, '');
		const st = rt.getState(tenantId, phone);
		return st?.stage || 'none';
	} catch { return 'unknown'; }
}

module.exports.getStage = getStage;
