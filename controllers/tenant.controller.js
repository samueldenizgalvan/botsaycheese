const path = require('path');
const fs = require('fs');

exports.getProfile = (req, res) => {
	const tenantId = req.tenantId;
	const configPath = path.join(__dirname, '../data', tenantId, 'config.json');
	let config = {};
	try {
		config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	} catch {}
	res.json({
		tenantId,
		displayName: config.displayName || tenantId,
		mode: config.mode || 'default',
		options: config.options || {}
	});
};
