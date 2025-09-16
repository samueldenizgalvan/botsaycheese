const path = require('path');
const fs = require('fs');

exports.login = (req, res) => {
	const { username, password } = req.body;
	const usersPath = path.join(__dirname, '../data/users.json');
	let users = [];
	try {
		users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
	} catch {}
	const user = users.find(u => u.username === username && u.password === password);
	if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
	res.json({ tenantId: user.tenantId });
};
