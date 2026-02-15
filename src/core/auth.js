function isAuthEnabled() {
  return String(process.env.API_AUTH_ENABLED || '').toLowerCase() === 'true'
}

function parseTenantTokens() {
  const raw = process.env.API_AUTH_TENANT_TOKENS || '{}'
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch (_error) {
    return {}
  }
}

function verifyAuth(req) {
  if (!isAuthEnabled()) {
    return { ok: true, tenantId: req.headers['x-tenant-id'] || null }
  }

  const authHeader = req.headers.authorization
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'missing bearer token' }
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'empty bearer token' }
  }

  const tenantId = req.headers['x-tenant-id']
  const tenantTokens = parseTenantTokens()

  if (tenantId && tenantTokens[tenantId]) {
    if (tenantTokens[tenantId] !== token) {
      return { ok: false, code: 'FORBIDDEN', message: 'invalid tenant token' }
    }
    return { ok: true, tenantId }
  }

  const expectedGlobalToken = process.env.API_AUTH_TOKEN || ''
  if (!expectedGlobalToken) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'api auth token is not configured' }
  }

  if (token !== expectedGlobalToken) {
    return { ok: false, code: 'FORBIDDEN', message: 'invalid token' }
  }

  return { ok: true, tenantId: tenantId || null }
}

module.exports = {
  verifyAuth
}
