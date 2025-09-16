document.getElementById('loginForm').addEventListener('submit', async function(e) {
	e.preventDefault();
	const username = document.getElementById('username').value;
	const password = document.getElementById('password').value;
	const errorDiv = document.getElementById('error');
	errorDiv.textContent = '';
	try {
		const res = await fetch('/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password })
		});
		if (!res.ok) {
			const data = await res.json();
			errorDiv.textContent = data.error || 'Error de autenticación';
			return;
		}
		const data = await res.json();
		localStorage.setItem('tenantId', data.tenantId);
		window.location.href = '/index.html';
	} catch (err) {
		errorDiv.textContent = 'Error de red';
	}
});
