const store = require('../services/store');

exports.list = (req, res) => {
	const tenantId = req.tenantId;
	const status = req.query.status;
	const records = store.getRecords(tenantId, status);
	res.json(records);
};

exports.confirm = (req, res) => {
	const tenantId = req.tenantId;
	const id = req.params.id;
	const ok = store.moveRecord(tenantId, id, 'pending', 'completed');
	if (!ok) return res.status(404).json({ error: 'No encontrado o ya confirmado' });
	res.json({ ok: true });
};

exports.cancel = (req, res) => {
	const tenantId = req.tenantId;
	const id = req.params.id;
	const ok = store.moveRecord(tenantId, id, 'pending', 'failed');
	if (!ok) return res.status(404).json({ error: 'No encontrado o ya cancelado' });
	res.json({ ok: true });
};
