// middleware/tenantHelper.js
function getTenantId(req) {
  const header = (req.headers['x-tenant-id'] || req.headers['tenant'] || '').toString().trim();
  if (header) return header;
  if (req.query && req.query.tenantId) return req.query.tenantId.toString();
  if (req.params && req.params.tenantId) return req.params.tenantId.toString();
  return null;
}

module.exports = { getTenantId };