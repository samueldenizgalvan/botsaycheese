const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

const usersPath = path.join(__dirname, '..', 'data', 'users.json');

router.post('/login', express.json(), (req, res) => {
	const { username, password } = req.body || {};
	try {
		const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
		const u = users.find(x => x.username === username && x.password === password);
		if (!u) return res.status(401).json({ error: 'Usuario o contraseña no válidos' });

		// Persistimos en sesión
		req.session.user = { username: u.username, tenantId: u.tenantId, displayName: u.displayName };
		return res.json({ ok: true, user: req.session.user });
	} catch (e) {
		console.error(e);
		return res.status(500).json({ error: 'Login error' });
	}
});

router.get('/me', (req, res) => {
	if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
	res.json({ user: req.session.user });
});

router.post('/logout', (req, res) => {
	req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
