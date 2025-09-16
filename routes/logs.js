const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const maybeTenant = require('../middleware/maybeTenant');
const path = require('path');

router.get('/events', maybeTenant, (req, res) => {
	const tenantId = req.tenantId;
	const limit = parseInt(req.query.limit) || 20;
	const file = path.join(__dirname, '../logs', tenantId, 'events.ndjson');
	const events = logger.readTailSafe(file, limit);
	res.json(events);
});

module.exports = router;
