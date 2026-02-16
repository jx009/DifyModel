function isAdminConsoleEnabled() {
  return String(process.env.ADMIN_CONSOLE_ENABLED || '').toLowerCase() === 'true'
}

function verifyAdminAuth(req) {
  if (!isAdminConsoleEnabled()) {
    return { ok: false, code: 'NOT_FOUND', message: 'route not found' }
  }

  const expectedToken = String(process.env.ADMIN_TOKEN || '').trim()
  if (!expectedToken) {
    return { ok: false, code: 'FORBIDDEN', message: 'admin token is not configured' }
  }

  const authHeader = req.headers.authorization
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'missing bearer token' }
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'empty bearer token' }
  }

  if (token !== expectedToken) {
    return { ok: false, code: 'FORBIDDEN', message: 'invalid admin token' }
  }

  return { ok: true }
}

module.exports = {
  isAdminConsoleEnabled,
  verifyAdminAuth
}
