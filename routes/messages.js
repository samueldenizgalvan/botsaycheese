const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const maybeTenant = require('../middleware/maybeTenant');
const path = require('path');

router.get('/', maybeTenant, (req, res) => {
	const tenantId = req.tenantId;
	const limit = parseInt(req.query.limit) || 20;
	const file = path.join(__dirname, '../logs', tenantId, 'messages.ndjson');
	const messages = logger.readTailSafe(file, limit);
	res.json(messages);
});

module.exports = router;
