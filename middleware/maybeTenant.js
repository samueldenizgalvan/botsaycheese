// Middleware para extraer tenantId de header o sesión
module.exports = function maybeTenant(req, res, next) {
	const tenantId = req.header('X-Tenant-Id') || (req.session && req.session.tenantId);
	if (!tenantId) {
		return res.status(400).json({ error: 'Missing tenantId' });
	}
	req.tenantId = tenantId;
	next();
}
