const fs = require('fs');
const path = require('path');

function getLogDir(tenantId) {
	const dir = path.join(__dirname, '../logs', tenantId);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function appendEvent(tenantId, obj) {
	const dir = getLogDir(tenantId);
	const file = path.join(dir, 'events.ndjson');
	fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function appendMessage(tenantId, obj) {
	const dir = getLogDir(tenantId);
	const file = path.join(dir, 'messages.ndjson');
	fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readTailSafe(filePathOrTenantFile, limit = 20) {
	let filePath = filePathOrTenantFile;
	if (typeof limit !== 'number') limit = 20;
	if (!fs.existsSync(filePath)) return [];
	const data = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
	return data.slice(-limit).map(line => {
		try { return JSON.parse(line); } catch { return null; }
	}).filter(Boolean);
}

module.exports = {
	appendEvent,
	appendMessage,
	readTailSafe
};
